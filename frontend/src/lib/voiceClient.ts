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
 *   • Barge-in   — VOICE talk-over: a local BargeInDetector detects sustained real speech over
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
// The mic stays OPEN while the agent speaks. To decide the patient is really talking OVER the
// agent (not residual echo of the agent's own voice), we compare the mic level to the agent's
// LIVE PLAYBACK level, sampled in real time from the audio output (see playbackRms). The echo at
// the mic is at most a fraction of what's currently playing, so:
//   threshold = max(BARGE_MIN_RMS, playbackLevel * ECHO_RESIDUAL_FACTOR + BARGE_MARGIN)
// This makes barge-in reliable in BOTH directions: during the agent's natural gaps between words
// the playback level ≈ 0, so the threshold drops and the patient can break in easily; during loud
// playback the threshold rises so echo can't trip it (only the patient's clearly-louder voice does).
const BARGE_MIN_RMS = 0.035;        // base gate during silence/gaps (real speech easily exceeds this)
const ECHO_RESIDUAL_FACTOR = 0.65;  // mic must beat this fraction of the LIVE playback level (echo residual)
const BARGE_MARGIN = 0.015;         // small constant headroom above the echo estimate
const BARGE_FRAMES_TO_TRIGGER = 4;  // sustained frames (~340 ms) of real over-threshold speech
const BARGE_PREROLL_MAX = 10;       // recent voiced frames flushed to STT so words aren't lost

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
 * Barge-in detector referenced to the agent's LIVE playback level. Each mic frame WHILE the agent
 * speaks is compared to a threshold derived from what the speakers are actually outputting right
 * now (`echoLevel`), so residual echo can't trip it but the patient's real voice — especially in
 * the agent's natural gaps, where echoLevel≈0 — does. Requires a few sustained frames of real
 * over-threshold speech so a single click/cough doesn't interrupt.
 */
class BargeInDetector {
  private voiced = 0;     // consecutive above-threshold frames

  reset(): void { this.voiced = 0; }

  /** @param micRms  RMS of the current mic frame.
   *  @param echoLevel  RMS the agent is playing out right now (the echo source).
   *  @returns true once sustained talk-over is detected. */
  push(micRms: number, echoLevel: number): boolean {
    const threshold = Math.max(BARGE_MIN_RMS, echoLevel * ECHO_RESIDUAL_FACTOR + BARGE_MARGIN);
    if (micRms > threshold) {
      this.voiced += 1;
      if (this.voiced >= BARGE_FRAMES_TO_TRIGGER) { this.voiced = 0; return true; }
    } else {
      this.voiced = 0;
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
  private playbackAnalyser: AnalyserNode | null = null;   // taps the live agent playback (echo source)
  private analyserBuf: Float32Array | null = null;

  private micEnabled = true;             // manual mute toggle (UI mic button)
  private agentHoldsFloor = false;       // true while status is thinking/speaking
  private currentResponseId = 0;
  private ending = false;
  private readonly cb: VoiceClientCallbacks;
  // Voice barge-in (talk-over)
  private bargeInEnabled = true;
  private readonly vad = new BargeInDetector();
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
    // Tap the playback with an analyser so barge-in can read the LIVE output level (= echo source)
    // in real time. It's a passive sink — no effect on what the patient hears.
    this.playbackAnalyser = this.ctx.createAnalyser();
    this.playbackAnalyser.fftSize = 1024;
    this.analyserBuf = new Float32Array(this.playbackAnalyser.fftSize);
    playbackGain.connect(this.playbackAnalyser);
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
    this.send({ type: 'interrupt', source: 'manual' });
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
    this.playbackAnalyser = null; this.analyserBuf = null;
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private onMicFrame(e: AudioProcessingEvent): void {
    if (!this.micEnabled) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ctx) return;

    const input = e.inputBuffer.getChannelData(0);
    const agentSpeaking = !!this.player?.isActive();   // audio actually coming out of the speakers

    // Agent is THINKING (holds the floor but nothing is playing yet): gate the mic but do NOT
    // barge-in. There's no audio to interrupt, and treating the patient's trailing sound/breath as
    // a barge-in here would abort the very response being generated (the "interrupt during thinking"
    // bug that made the agent re-ask instead of answer). Just wait for it to start speaking.
    if (this.agentHoldsFloor && !agentSpeaking) { this.vad.reset(); this.preRoll.length = 0; return; }

    if (agentSpeaking) {
      // Full-duplex barge-in: listen for the patient talking OVER the agent. This audio is
      // NOT streamed to STT (it's mostly the agent's echo) — it only decides whether to
      // interrupt. We keep a short pre-roll of the patient's onset so, on barge-in, their
      // first words are flushed to STT and not clipped.
      if (!this.bargeInEnabled) return;          // half-duplex fallback
      const micLevel = this.rms(input);
      const echoLevel = this.playbackRms();      // what the agent is playing right now
      const threshold = Math.max(BARGE_MIN_RMS, echoLevel * ECHO_RESIDUAL_FACTOR + BARGE_MARGIN);
      if (micLevel > threshold) {
        this.preRoll.push(this.toPcm16(input));
        if (this.preRoll.length > BARGE_PREROLL_MAX) this.preRoll.shift();
      } else {
        this.preRoll.length = 0;
      }
      if (this.vad.push(micLevel, echoLevel)) this.bargeIn();
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
    this.send({ type: 'interrupt', source: 'voice' });
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

  /** RMS of the agent's live playback (the echo source), sampled from the output analyser. 0 when
   *  nothing is playing — including the gaps between the agent's words, which is when it's easiest
   *  (and correct) to let the patient break in. */
  private playbackRms(): number {
    const a = this.playbackAnalyser, buf = this.analyserBuf;
    if (!a || !buf) return 0;
    a.getFloatTimeDomainData(buf);
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
