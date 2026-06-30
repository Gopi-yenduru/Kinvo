/**
 * VoiceClient — browser side of the Sarvam Telugu voice intake agent.
 * =====================================================================================
 * Owns the entire realtime voice loop so the React component only deals with UI state:
 *
 *   • WebSocket  — authenticated /ws connection, the new clean event contract.
 *   • Microphone — getUserMedia capture (echo-cancelled). FULL-DUPLEX: the mic stays open
 *                  while the agent talks so the patient can talk over it. That audio is NOT
 *                  streamed to STT (it's mostly the agent's echo); it only feeds a local
 *                  echo-safe VAD that decides whether to barge in.
 *   • Playback   — StreamingPcmPlayer schedules incoming PCM chunks sample-accurately and
 *                  gaplessly, so audio is smooth and starts the instant the first chunk
 *                  arrives (low latency) instead of waiting for the whole reply.
 *   • Barge-in   — VOICE talk-over: a local EchoSafeVad detects sustained real speech over
 *                  the agent (echo-cancelled mic + adaptive floor + sustained frames), then
 *                  stops playback, tells the backend to abort, and flushes a short pre-roll
 *                  so the patient's first words aren't lost. interrupt() also serves the
 *                  manual mic button. Backend self-heals false triggers by re-asking.
 *
 * Backend → client events handled here (see SarvamProvider.ts for the emitter):
 *   session_ready · status · patient_transcript · agent_transcript ·
 *   agent_audio · agent_audio_end · agent_interrupt · red_flag · session_ended · error
 */

export type AgentStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceClientCallbacks {
  onReady?: () => void;
  onStatus?: (status: AgentStatus) => void;
  onPatientTranscript?: (text: string) => void;
  onAgentTranscript?: (text: string) => void;
  onRedFlag?: (symptoms: string, severity: string) => void;
  onError?: (message: string) => void;
  onSessionEnded?: (reason?: string) => void;
  onClose?: () => void;
  onBargeIn?: () => void;            // fired the instant a voice talk-over is detected
}

const PLAYBACK_SAMPLE_RATE = 24000; // must match the backend TTS output rate
const MIC_FRAME_SIZE = 2048;        // ~85 ms — finer granularity for snappy barge-in detection

// ── Voice barge-in (talk-over) tuning ──────────────────────────────────────────────
// The mic stays OPEN while the agent speaks. We trust the browser echo canceller to strip
// the agent's own voice, then a local energy VAD with an ADAPTIVE floor + a SUSTAINED-speech
// requirement decides the patient is really talking over the agent (not residual echo or a
// transient noise) before interrupting. Raise these if barge-in is too eager; lower if sluggish.
const BARGE_MIN_RMS = 0.045;        // absolute floor: speech must be at least this loud
const BARGE_FLOOR_FACTOR = 2.2;     // …and this many× above the learned echo/noise residual
const BARGE_FLOOR_MARGIN = 0.012;   // …plus this margin
const BARGE_FRAMES_TO_TRIGGER = 3;  // sustained frames (~255 ms) before declaring barge-in
const BARGE_PREROLL_MAX = 8;        // recent voiced frames flushed to STT so words aren't lost

/**
 * Gapless streaming player for raw little-endian PCM16 chunks. Each chunk is scheduled
 * to start exactly where the previous one ends, using the Web Audio clock, so there are
 * no clicks/gaps between chunks of one reply.
 */
class StreamingPcmPlayer {
  private nextTime = 0;
  private currentResponseId: number | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
  }

  enqueue(base64: string, responseId: number): void {
    // A new reply: rebase the schedule to "now" so we don't queue behind a finished one.
    if (responseId !== this.currentResponseId) {
      this.currentResponseId = responseId;
      this.nextTime = this.ctx.currentTime;
    }

    const bin = atob(base64);
    const sampleCount = bin.length >> 1; // 2 bytes per sample (drop a stray odd byte)
    if (sampleCount === 0) return;

    const buffer = this.ctx.createBuffer(1, sampleCount, PLAYBACK_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const lo = bin.charCodeAt(i * 2);
      const hi = bin.charCodeAt(i * 2 + 1);
      let s = (hi << 8) | lo;
      if (s >= 0x8000) s -= 0x10000;          // sign-extend
      channel[i] = s / 32768;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    const startAt = Math.max(this.nextTime, this.ctx.currentTime);
    src.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** True while audio is still scheduled/playing — used to keep the mic gated until
   *  the agent's voice has actually finished coming out of the speakers (no echo). */
  isActive(): boolean {
    return this.sources.size > 0 || this.nextTime > this.ctx.currentTime + 0.05;
  }

  /** Immediately stop everything that's playing/scheduled (barge-in / reset). */
  stop(): void {
    for (const src of this.sources) {
      try { src.onended = null; src.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.nextTime = this.ctx.currentTime;
    this.currentResponseId = null;
  }
}

/**
 * Echo-safe voice-activity detector for barge-in. Fed the RMS of each mic frame WHILE the
 * agent is speaking. It keeps an ADAPTIVE floor of the residual (post-echo-cancellation)
 * level and only reports a barge-in once speech stays clearly above that floor for a few
 * consecutive frames — so neither leftover echo nor a one-off noise can false-trigger.
 */
class EchoSafeVad {
  private floor = 0.01;   // learned residual/echo level
  private voiced = 0;     // consecutive above-threshold frames

  reset(): void { this.voiced = 0; }

  threshold(): number {
    return Math.max(BARGE_MIN_RMS, this.floor * BARGE_FLOOR_FACTOR + BARGE_FLOOR_MARGIN);
  }

  /** Returns true when sustained human speech (talk-over) is detected. */
  push(rms: number): boolean {
    if (rms > this.threshold()) {
      this.voiced += 1;
      if (this.voiced >= BARGE_FRAMES_TO_TRIGGER) { this.voiced = 0; return true; }
    } else {
      this.voiced = 0;
      this.floor = this.floor * 0.95 + rms * 0.05; // slowly learn the quiet/echo level
    }
    return false;
  }
}

export class VoiceClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private player: StreamingPcmPlayer | null = null;

  private micEnabled = true;             // manual mute toggle (UI mic button)
  private agentHoldsFloor = false;       // true while status is thinking/speaking
  private currentResponseId = 0;
  private ending = false;
  private readonly cb: VoiceClientCallbacks;
  // Voice barge-in (talk-over)
  private bargeInEnabled = true;
  private readonly vad = new EchoSafeVad();
  private preRoll: number[][] = [];      // recent voiced frames, flushed to STT on barge-in

  constructor(cb: VoiceClientCallbacks = {}) {
    this.cb = cb;
  }

  /** Connect audio + WebSocket and join the session. Call from a user gesture. */
  async start(sessionId: string, token: string | null): Promise<void> {
    // --- Audio graph -----------------------------------------------------------
    this.ctx = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const playbackGain = this.ctx.createGain();
    playbackGain.gain.value = 1.0;
    playbackGain.connect(this.ctx.destination);
    this.player = new StreamingPcmPlayer(this.ctx, playbackGain);

    // --- Microphone ------------------------------------------------------------
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.micSource = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(MIC_FRAME_SIZE, 1, 1);
    this.processor.onaudioprocess = (e) => this.onMicFrame(e);

    // Route mic through a silent sink so the ScriptProcessor runs without echoing
    // the microphone to the speakers.
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    this.micSource.connect(this.processor);
    this.processor.connect(silent);
    silent.connect(this.ctx.destination);

    // --- WebSocket -------------------------------------------------------------
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    this.ws.onopen = () => this.send({ type: 'join_session', sessionId, token });
    this.ws.onmessage = (ev) => this.onServerMessage(ev);
    this.ws.onerror = () => this.cb.onError?.('Voice connection error');
    this.ws.onclose = () => { if (!this.ending) this.cb.onClose?.(); };
  }

  /** Manual mic mute/unmute (UI mic button). */
  setMicEnabled(enabled: boolean): void { this.micEnabled = enabled; }
  isMicEnabled(): boolean { return this.micEnabled; }

  /** Turn voice talk-over on/off (off = half-duplex; the mic button still interrupts). */
  setBargeInEnabled(enabled: boolean): void { this.bargeInEnabled = enabled; }

  /** User-initiated barge-in: stop playback now and tell the backend to abort the turn. */
  interrupt(): void {
    this.player?.stop();
    this.agentHoldsFloor = false;
    this.send({ type: 'interrupt' });
  }

  /** End the session and tear down all audio + the socket. */
  async stop(): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    this.send({ type: 'end_session' });
    this.player?.stop();

    try { this.processor?.disconnect(); } catch { /* ignore */ }
    try { this.micSource?.disconnect(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') { try { await this.ctx.close(); } catch { /* ignore */ } }
    try { this.ws?.close(1000, 'session ended'); } catch { /* ignore */ }

    this.ws = null; this.ctx = null; this.stream = null;
    this.processor = null; this.micSource = null; this.player = null;
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private onMicFrame(e: AudioProcessingEvent): void {
    if (!this.micEnabled) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ctx) return;

    const input = e.inputBuffer.getChannelData(0);
    const agentTalking = this.agentHoldsFloor || !!this.player?.isActive();

    if (agentTalking) {
      // Full-duplex barge-in: listen for the patient talking OVER the agent. This audio is
      // NOT streamed to STT (it's mostly the agent's echo) — it only decides whether to
      // interrupt. We keep a short pre-roll of the patient's onset so, on barge-in, their
      // first words are flushed to STT and not clipped.
      if (!this.bargeInEnabled) return;          // half-duplex fallback
      const level = this.rms(input);
      if (level > this.vad.threshold()) {
        this.preRoll.push(this.toPcm16(input));
        if (this.preRoll.length > BARGE_PREROLL_MAX) this.preRoll.shift();
      } else {
        this.preRoll.length = 0;
      }
      if (this.vad.push(level)) this.bargeIn();
      return;
    }

    // Patient has the floor → stream to STT normally.
    this.send({ type: 'audio_data', data: { pcm16: this.toPcm16(input), sampleRate: this.ctx.sampleRate } });
  }

  /** Patient talked over the agent: stop playback, tell the backend to abort, and flush the
   *  captured onset so the transcription keeps their first words. */
  private bargeIn(): void {
    this.cb.onBargeIn?.();
    this.player?.stop();
    this.agentHoldsFloor = false;
    this.vad.reset();
    this.send({ type: 'interrupt' });
    const roll = this.preRoll;
    this.preRoll = [];
    const rate = this.ctx?.sampleRate ?? PLAYBACK_SAMPLE_RATE;
    for (const frame of roll) this.send({ type: 'audio_data', data: { pcm16: frame, sampleRate: rate } });
  }

  private rms(buf: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  private toPcm16(buf: Float32Array): number[] {
    const out = new Array<number>(buf.length);
    for (let i = 0; i < buf.length; i++) {
      const s = Math.max(-1, Math.min(1, buf[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  private onServerMessage(ev: MessageEvent): void {
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'session_ready':
        this.cb.onReady?.();
        break;

      case 'status':
        this.agentHoldsFloor = msg.state === 'thinking' || msg.state === 'speaking';
        this.cb.onStatus?.(msg.state as AgentStatus);
        break;

      case 'patient_transcript':
        if (msg.text) this.cb.onPatientTranscript?.(String(msg.text));
        break;

      case 'agent_transcript':
        if (typeof msg.responseId === 'number') this.currentResponseId = msg.responseId;
        if (msg.text) this.cb.onAgentTranscript?.(String(msg.text));
        break;

      case 'agent_audio':
        if (msg.audio) this.player?.enqueue(String(msg.audio), Number(msg.responseId) || this.currentResponseId);
        break;

      case 'agent_audio_end':
        break; // the player drains on its own

      case 'agent_interrupt':
        this.player?.stop();
        break;

      case 'red_flag':
        this.cb.onRedFlag?.(String(msg.symptoms || ''), String(msg.severity || ''));
        break;

      case 'session_ended':
        this.cb.onSessionEnded?.(msg.reason);
        break;

      case 'error':
        this.cb.onError?.(String(msg.message || 'An error occurred'));
        break;
    }
  }

  private send(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
    }
  }
}
