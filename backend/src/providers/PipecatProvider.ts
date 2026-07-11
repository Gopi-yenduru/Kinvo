import WebSocket from 'ws';
import db from '../database-manager.js';
import { BaseProvider, RealtimeConfig } from './BaseProvider.js';
import { emergencyMessage, Lang } from '../emergency.js';

/**
 * PipecatProvider — open-source voice pipeline (Pipecat) behind the SAME frontend
 * WebSocket contract as the in-house SarvamProvider.
 * =====================================================================================
 * The heavy lifting (VAD → STT → LLM+tools → TTS) runs in the separate Python service
 * under pipecat-service/ (FastAPI + Pipecat). This class is a thin bridge:
 *
 *   browser ⇆ Node (existing contract)     Node ⇆ Python (bridge protocol)
 *   ─────────────────────────────────      ────────────────────────────────
 *   audio_data {pcm16[], sampleRate}   →   0x01 + PCM16LE @16 kHz (binary)
 *   interrupt / end_session            →   0x02 + JSON control (binary)
 *                                      ←   raw PCM16LE @24 kHz (binary) → agent_audio b64
 *                                      ←   JSON events (text): transcripts, speaking
 *                                          boundaries, tool_call, error
 *
 * ALL business logic stays here in Node exactly like the other providers: transcripts
 * and red flags are persisted to the DB, the session lifecycle is driven from this
 * side, and the frontend never knows which engine produced the audio.
 */

const PIPECAT_URL = (process.env.PIPECAT_URL || 'http://localhost:8765').trim().replace(/\/+$/, '');
const STT_SAMPLE_RATE = 16000;   // what the Python service expects on the mic path
const BROWSER_SAMPLE_RATE = 24000;
const CONNECT_TIMEOUT_MS = 8000;
const AUDIO_FLUSH_BYTES = 9600;  // ≈200 ms @ 24 kHz mono PCM16 per frontend message
const AUDIO_FLUSH_MS = 60;       // trailing-chunk flush so audio never sits in the buffer
const END_AFTER_GOODBYE_MS = 1200;   // grace after the goodbye finishes playing
const END_FALLBACK_MS = 20000;       // end anyway if the goodbye never finishes

const TAG_AUDIO = 0x01;
const TAG_CONTROL = 0x02;

const LANG_LABEL: Record<Lang, string> = {
  'te-IN': 'Telugu',
  'hi-IN': 'Hindi',
  'en-IN': 'English'
};

// Everyday spoken acknowledgements per language (same as LiveKitProvider — the LiveKit
// engine's prompt tested most natural, so the other engines carry the same voice rules).
const NATURAL_ACKS: Record<Lang, string> = {
  'te-IN': 'అవునండీ / హ్మ్ / సరే / అలాగే',
  'hi-IN': 'अच्छा / हाँ जी / ठीक है / हम्म',
  'en-IN': 'okay / alright / I see / mm-hmm'
};

type AgentStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

interface PipecatSession {
  config: RealtimeConfig;
  lang: Lang;
  ws: WebSocket | null;          // socket to the Python pipecat service
  frontendWs: any;               // socket to the browser
  status: AgentStatus;
  greeted: boolean;
  ended: boolean;
  responseId: number;            // one agent spoken turn (drives agent_audio/interrupt)
  seq: number;                   // audio chunk ordering within a response
  botSpeaking: boolean;
  audioBuf: Buffer[];            // coalesce small TTS chunks into fewer frontend messages
  audioBufBytes: number;
  flushTimer: NodeJS.Timeout | null;
  endRequested: boolean;         // end_session tool fired — end after the goodbye
  endTimer: NodeJS.Timeout | null;
  lastEmergencyResponse: number; // de-dupe red-flag alerts within one agent turn
  patientTurns: number;          // how many times the patient has spoken (guards premature end)
  startTime: number;
}

// A genuine intake needs at least this many patient answers before the agent may end on
// its own "intake_complete" verdict. A patient-initiated stop or an emergency bypasses this.
const MIN_PATIENT_TURNS_BEFORE_END = 5;

class PipecatProvider implements BaseProvider {
  private sessions: Map<string, PipecatSession> = new Map();

  // ───────────────────────────────────────────────────────────────────────────────
  // Session lifecycle
  // ───────────────────────────────────────────────────────────────────────────────
  async createRealtimeSession(config: RealtimeConfig): Promise<WebSocket | null> {
    const sessionId = config.sessionId;
    const lang: Lang = (config.language === 'hi-IN' || config.language === 'en-IN') ? config.language : 'te-IN';
    const wsUrl = PIPECAT_URL.replace(/^http/i, 'ws') + '/ws';
    console.log(`🐍 Creating Pipecat session ${sessionId} (lang=${lang}) via ${wsUrl}`);

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try { socket.terminate(); } catch { /* ignore */ }
        reject(new Error(`Pipecat service did not respond within ${CONNECT_TIMEOUT_MS / 1000}s. Is it running at ${PIPECAT_URL}? (see pipecat-service/README.md)`));
      }, CONNECT_TIMEOUT_MS);

      socket.on('open', () => {
        socket.send(JSON.stringify({
          type: 'start',
          session_id: sessionId,
          language: lang,
          system_prompt: this.buildSystemPrompt(config, lang),
          voice: config.voice || '',
          temperature: config.temperature ?? 0.6
        }));
      });
      // First text message decides the handshake: 'ready' resolves, 'error' rejects.
      socket.once('message', (data: Buffer, isBinary: boolean) => {
        clearTimeout(timer);
        try {
          const msg = isBinary ? null : JSON.parse(data.toString());
          if (msg?.type === 'ready') return resolve(socket);
          reject(new Error(msg?.message || 'Pipecat service refused the session'));
        } catch {
          reject(new Error('Pipecat service sent an invalid handshake'));
        }
      });
      socket.on('error', (err: any) => {
        clearTimeout(timer);
        reject(new Error(`Cannot reach the Pipecat service at ${PIPECAT_URL} (${err?.message || err}). Start it with: cd pipecat-service && python main.py`));
      });
    });

    const session: PipecatSession = {
      config, lang,
      ws, frontendWs: null,
      status: 'idle',
      greeted: false, ended: false,
      responseId: 0, seq: 0, botSpeaking: false,
      audioBuf: [], audioBufBytes: 0, flushTimer: null,
      endRequested: false, endTimer: null,
      lastEmergencyResponse: -1,
      patientTurns: 0,
      startTime: Date.now()
    };
    this.sessions.set(sessionId, session);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      try { this.onServiceMessage(sessionId, data, isBinary); }
      catch (e: any) { console.error(`pipecat message error (${sessionId}):`, e?.message || e); }
    });
    ws.on('close', () => {
      const s = this.sessions.get(sessionId);
      if (s && !s.ended) {
        console.error(`🐍 Pipecat service socket closed unexpectedly (${sessionId})`);
        this.send(s, { type: 'error', message: 'Voice service disconnected.' });
        this.endSession(sessionId).catch(() => {});
      }
    });
    ws.on('error', (err: any) => console.error(`pipecat ws error (${sessionId}):`, err?.message || err));

    return ws;
  }

  getSession(sessionId: string): WebSocket | null {
    const s = this.sessions.get(sessionId);
    return s && !s.ended ? s.ws : null;
  }

  linkFrontendSocket(sessionId: string, frontendWs: any): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.frontendWs = frontendWs;
    this.send(s, { type: 'session_ready' });
    if (!s.greeted && !s.ended) {
      s.greeted = true;
      // Frontend is wired up — tell the pipeline to greet the patient.
      setTimeout(() => this.sendControl(s, { type: 'go' }), 150);
    }
  }

  unlinkFrontendSocket(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.frontendWs = null;
  }

  async endSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;
    s.ended = true;
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    if (s.endTimer) { clearTimeout(s.endTimer); s.endTimer = null; }
    this.send(s, { type: 'session_ended', reason: 'completed' });

    // Graceful pipeline stop, then close the bridge socket.
    try { this.sendControl(s, { type: 'end' }); } catch { /* ignore */ }
    const ws = s.ws;
    setTimeout(() => { try { ws?.close(); } catch { /* ignore */ } }, 300);

    // Analytics row (token usage is not metered on the pipecat path yet — keep the
    // session visible in the dashboard with a zeroed row).
    try {
      await db.saveSessionTokenUsage({
        session_id: sessionId, model: 'pipecat',
        input_audio_tokens: 0, output_audio_tokens: 0,
        text_input_tokens: 0, text_output_tokens: 0,
        input_audio_duration: 0, output_audio_duration: 0,
        estimated_cost: 0
      });
    } catch (e: any) { console.error('Token usage save failed:', e?.message || e); }

    try { await db.updateSessionStatus(sessionId, 'completed'); }
    catch (e: any) { console.error('Mark completed failed:', e?.message || e); }

    this.sessions.delete(sessionId);
    console.log(`🐍 Pipecat session ended ${sessionId} (${Math.round((Date.now() - s.startTime) / 1000)}s)`);
  }

  handleMessage(_sessionId: string, _data: Buffer): void { /* not used — events arrive on the bridge socket */ }

  getSessionTokenUsage(sessionId: string): any {
    const s = this.sessions.get(sessionId);
    return s ? { sessionId, model: 'pipecat', durationMs: Date.now() - s.startTime } : null;
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Browser → Python: mic audio and barge-in
  // ───────────────────────────────────────────────────────────────────────────────
  sendAudioData(sessionId: string, audioData: any): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
    const pcm16: number[] = audioData?.pcm16;
    if (!Array.isArray(pcm16) || pcm16.length === 0) return;

    // Full-duplex: forward everything — Pipecat's server-side VAD owns turn-taking
    // and interruptions (unlike the half-duplex in-house pipeline, nothing is gated).
    const fromRate = Number(audioData?.sampleRate) || BROWSER_SAMPLE_RATE;
    const samples = this.downsample(pcm16, fromRate, STT_SAMPLE_RATE);
    const buf = Buffer.allocUnsafe(1 + samples.length * 2);
    buf[0] = TAG_AUDIO;
    for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 1 + i * 2);
    try { s.ws.send(buf); } catch { /* socket closing */ }
  }

  /** Barge-in (talk-over or mic button): abort the agent's current spoken turn. */
  interrupt(sessionId: string, source?: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;
    // A voice talk-over only makes sense while the agent is audibly speaking; Pipecat's
    // own VAD already handles real speech, so ignore stray voice triggers otherwise.
    if (source === 'voice' && !s.botSpeaking) return;
    console.log(`✋ Interrupt (${sessionId})${source ? ` [${source}]` : ''}`);
    this.sendControl(s, { type: 'interrupt' });
    this.dropPendingAudio(s);
    if (s.botSpeaking) {
      s.botSpeaking = false;
      this.send(s, { type: 'agent_interrupt', responseId: s.responseId });
    }
    this.setStatus(s, 'listening');
  }

  getFunctionTools(): any[] {
    // Same tool set as the other providers — the schemas actually sent to the LLM live
    // in pipecat-service/bot.py; keep both in sync.
    return [
      {
        type: 'function',
        name: 'red_flag_detected',
        description: 'ALERT IMMEDIATE CLINICAL ATTENTION REQUIRED: Patient reported critical symptoms that need immediate medical review',
        parameters: {
          type: 'object',
          properties: {
            symptoms: { type: 'array', items: { type: 'string' }, description: 'List of critical symptoms mentioned by patient' },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }
          },
          required: ['symptoms', 'severity']
        }
      },
      {
        type: 'function',
        name: 'end_session',
        description: 'End the medical intake session when patient expressly consents or when intake is naturally complete',
        parameters: {
          type: 'object',
          properties: {
            consent_given: { type: 'boolean' },
            reason: { type: 'string', enum: ['intake_complete', 'patient_request', 'patient_uncomfortable', 'timeout'] }
          },
          required: ['consent_given', 'reason']
        }
      }
    ];
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Python → browser: audio, transcripts, tool calls
  // ───────────────────────────────────────────────────────────────────────────────
  private onServiceMessage(sessionId: string, data: Buffer, isBinary: boolean): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;

    if (isBinary) {  // raw PCM16 @24 kHz agent audio
      this.startResponseIfNeeded(s);
      s.audioBuf.push(data);
      s.audioBufBytes += data.length;
      if (s.audioBufBytes >= AUDIO_FLUSH_BYTES) this.flushAudio(s);
      else if (!s.flushTimer) s.flushTimer = setTimeout(() => this.flushAudio(s), AUDIO_FLUSH_MS);
      return;
    }

    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'bot_started_speaking':
        this.startResponseIfNeeded(s);
        break;

      case 'bot_transcript': {
        const text = String(msg.text || '').trim();
        if (!text) break;
        this.send(s, { type: 'agent_transcript', text, responseId: s.responseId });
        db.saveConversationLog({
          session_id: sessionId, speaker: 'agent', message: text,
          audio_data: JSON.stringify({ source: 'pipecat' })
        }).catch((e: any) => console.error('agent log save failed:', e?.message || e));
        break;
      }

      case 'bot_stopped_speaking':
        this.flushAudio(s);
        if (s.botSpeaking) {
          s.botSpeaking = false;
          this.send(s, { type: 'agent_audio_end', responseId: s.responseId });
        }
        this.setStatus(s, 'listening');
        if (s.endRequested) {
          // The goodbye just finished playing — now really end.
          if (s.endTimer) clearTimeout(s.endTimer);
          s.endTimer = setTimeout(() => this.endSession(sessionId).catch(() => {}), END_AFTER_GOODBYE_MS);
        }
        break;

      case 'user_transcript': {
        const text = String(msg.text || '').trim();
        if (!text) break;
        s.patientTurns++;
        this.send(s, { type: 'patient_transcript', text });
        db.saveConversationLog({
          session_id: sessionId, speaker: 'patient', message: text,
          audio_data: JSON.stringify({ source: 'pipecat' })
        }).catch((e: any) => console.error('patient log save failed:', e?.message || e));
        this.setStatus(s, 'thinking');
        break;
      }

      case 'user_started_speaking':
        // Patient talked over the agent — Pipecat has already cut the pipeline; make
        // the browser stop its queued playback too.
        if (s.botSpeaking) {
          s.botSpeaking = false;
          this.dropPendingAudio(s);
          this.send(s, { type: 'agent_interrupt', responseId: s.responseId });
          this.setStatus(s, 'listening');
        }
        break;

      case 'user_stopped_speaking':
        break; // transcript follows and drives the status change

      case 'tool_call':
        this.handleToolCall(sessionId, s, String(msg.name || ''), msg.arguments || {});
        break;

      case 'error':
        console.error(`🐍 pipecat error (${sessionId}): ${msg.message}`);
        this.send(s, { type: 'error', message: String(msg.message || 'Voice service error') });
        break;
    }
  }

  private handleToolCall(sessionId: string, s: PipecatSession, name: string, args: any): void {
    if (name === 'red_flag_detected') {
      if (s.lastEmergencyResponse === s.responseId) return; // already alerted this turn
      s.lastEmergencyResponse = s.responseId;
      const symptoms = (Array.isArray(args.symptoms) ? args.symptoms.join(', ') : String(args.symptoms || 'critical symptom')).slice(0, 200);
      const severity = String(args.severity || 'critical');
      console.log(`🚨 RED FLAG (${sessionId}) [${severity}] ${symptoms}`);
      db.saveRedFlagEvent({
        session_id: sessionId, symptoms, severity,
        resolved: false, clinician_notified: true
      }).then(() => db.updateSessionRedFlagCount(sessionId)).catch((e: any) =>
        console.error(`red flag save failed (${sessionId}):`, e?.message || e));
      this.send(s, { type: 'red_flag', symptoms, severity });
      return;
    }
    if (name === 'end_session') {
      const reason = String(args?.reason || '').toLowerCase();
      // Guard against the LLM wrapping up after only a couple of exchanges. A patient-driven
      // stop or an emergency always ends; an "intake_complete" verdict is only honored once
      // enough of the intake has actually happened. (Same intent as SarvamProvider's guard.)
      const patientDriven = reason === 'patient_request' || reason === 'patient_uncomfortable';
      const emergencyEnded = s.lastEmergencyResponse >= 0;
      if (!patientDriven && !emergencyEnded && s.patientTurns < MIN_PATIENT_TURNS_BEFORE_END) {
        console.warn(`⚠️ Ignoring premature end_session (${sessionId}) reason="${reason}" after only ${s.patientTurns} patient turn(s)`);
        return;
      }
      console.log(`🏁 end_session tool (${sessionId}) reason=${reason} after ${s.patientTurns} patient turn(s)`);
      s.endRequested = true;
      // Fallback: end even if the goodbye never finishes (TTS failure etc.).
      if (s.endTimer) clearTimeout(s.endTimer);
      s.endTimer = setTimeout(() => this.endSession(sessionId).catch(() => {}), END_FALLBACK_MS);
      return;
    }
    console.warn(`Unknown pipecat tool call: ${name}`);
  }

  /** A new agent spoken turn begins (first audio chunk or explicit start event). */
  private startResponseIfNeeded(s: PipecatSession): void {
    if (s.botSpeaking) return;
    s.botSpeaking = true;
    s.responseId++;
    s.seq = 0;
    this.setStatus(s, 'speaking');
  }

  private flushAudio(s: PipecatSession): void {
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    if (!s.audioBufBytes) return;
    const chunk = Buffer.concat(s.audioBuf, s.audioBufBytes);
    s.audioBuf = [];
    s.audioBufBytes = 0;
    this.send(s, {
      type: 'agent_audio',
      audio: chunk.toString('base64'),
      responseId: s.responseId,
      seq: s.seq++
    });
  }

  private dropPendingAudio(s: PipecatSession): void {
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    s.audioBuf = [];
    s.audioBufBytes = 0;
  }

  // ───────────────────────────────────────────────────────────────────────────────
  private buildSystemPrompt(config: RealtimeConfig, lang: Lang): string {
    const label = LANG_LABEL[lang];
    // Strip any "English only" directive from the clinic instructions when the
    // patient chose Telugu/Hindi (same guard as SarvamProvider.buildSystemPrompt).
    const base = (config.instructions || '')
      .split('\n')
      .filter(line => lang === 'en-IN' || !/english\s*only/i.test(line))
      .join('\n')
      .trim();
    const isFollowup = !!(config.isReturning && config.patientHistory && String(config.patientHistory).trim());
    const followup = isFollowup ? [
      '',
      '### FOLLOW-UP VISIT — you already know this patient',
      config.patientName
        ? `- Their name is ${config.patientName}. Greet them warmly BY NAME and welcome them back. Do NOT ask their name or age again.`
        : '- Greet them warmly and welcome them back. Do NOT ask their name or age again.',
      '- Previous visit history (refer to their complaint and medicines by name):',
      '"""',
      String(config.patientHistory || '').slice(0, 4000),
      '"""',
      '- Focus on the PRESENT: how they are NOW, whether the earlier problem improved, medicine effects/side effects, and any NEW problems. Do NOT re-run a fresh intake.'
    ].join('\n') : '';
    return [
      `You are "Aarogya Sahayaki", a warm, caring ${label}-speaking hospital nurse having a gentle VOICE conversation with a patient before they see the doctor. You sound like a real human, never like a bot or a form.`,
      '',
      '### CONVERSATION RULES',
      `- Speak ONLY in natural, everyday spoken ${label}. Common English medical words (BP, sugar, tablet, fever) are fine. Output ONLY the words to be spoken — no markdown, lists, labels, or stage directions.`,
      `- Sound like a real person speaking out loud, not reading a form: short spoken sentences, contractions, and gentle everyday acknowledgements (${NATURAL_ACKS[lang]}) — never stiff, formal, or translated-sounding phrasing.`,
      '- Keep every reply SHORT: one brief empathetic reaction to what they just said, then exactly ONE question. Never ask two questions at once, never lecture.',
      '- You are NOT a doctor: no diagnosis, no treatment advice, no promises about outcomes.',
      isFollowup
        ? '- Start by greeting them back by name, then ask how they are feeling now compared to last time, and continue the follow-up thoroughly.'
        : `- Start by greeting the patient warmly, introducing yourself briefly, and asking their name. Then ask their age. Then their main health problem, and continue a natural intake. Ask ONE question at a time, adapting to their answers.`,
      '',
      '### PACE — DO NOT END EARLY (very important)',
      '- This is a THOROUGH intake, not a quick hello. You MUST ask about, and hear an answer for, EACH of these before finishing: (1) name, (2) age, (3) main health problem, (4) how long it has been going on, (5) how severe it is, (6) any other symptoms, (7) current medicines, (8) allergies, (9) relevant past illnesses. Cover them one at a time over MANY turns.',
      '- Do NOT thank-and-close, do NOT say "the doctor will see you", and do NOT call end_session until you have genuinely been through the list above — OR the patient clearly asks to stop, OR an emergency red flag occurs. Ending after just a name or one or two answers is WRONG.',
      '- If the patient gives a short or unclear answer, gently ask again or ask a follow-up — keep the conversation going rather than wrapping up.',
      '- ONLY when the intake is genuinely complete (or the patient asks to stop): thank them in one warm sentence, say the doctor will see them shortly, and call the end_session tool.',
      '',
      '### SAFETY — EMERGENCY RED FLAGS (HIGHEST PRIORITY)',
      '- EMERGENCY = chest/heart pain, breathing difficulty, severe bleeding, fainting, stroke signs, seizure, suicidal thoughts, or anything life-threatening.',
      `- The MOMENT such a symptom is mentioned: FIRST call the red_flag_detected tool with severity "critical". THEN say ONLY this reassurance in ${label}: "${emergencyMessage(lang)}" — then stop asking intake questions.`,
      followup,
      base ? `\n### Additional clinical instructions from the clinic:\n${base}` : ''
    ].join('\n');
  }

  /** Linear-interpolation resample (same as SarvamProvider) — browser rate → 16 kHz. */
  private downsample(input: number[], fromRate: number, toRate: number): Int16Array {
    if (fromRate === toRate) return Int16Array.from(input);
    const ratio = fromRate / toRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = pos - i0;
      out[i] = Math.round(input[i0] * (1 - frac) + input[i1] * frac);
    }
    return out;
  }

  private sendControl(s: PipecatSession, obj: any): void {
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;
    const json = Buffer.from(JSON.stringify(obj), 'utf-8');
    const buf = Buffer.concat([Buffer.from([TAG_CONTROL]), json]);
    try { s.ws.send(buf); } catch { /* socket closing */ }
  }

  private setStatus(s: PipecatSession, state: AgentStatus): void {
    if (s.status === state) return;
    s.status = state;
    this.send(s, { type: 'status', state });
  }

  private send(s: PipecatSession, payload: any): void {
    const ws = s.frontendWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
    }
  }
}

export default PipecatProvider;
