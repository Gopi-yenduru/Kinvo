/**
 * VoiceClient — browser side of the Sarvam Telugu voice intake agent.
 * =====================================================================================
 * Owns the entire realtime voice loop so the React component only deals with UI state:
 *
 *   • WebSocket  — authenticated /ws connection, the new clean event contract.
 *   • Microphone — getUserMedia capture with HALF-DUPLEX gating: the mic is muted while
 *                  the agent is talking, so the agent never transcribes its own voice
 *                  (this is the main cure for "it mishears me / talks to itself").
 *   • Playback   — StreamingPcmPlayer schedules incoming PCM chunks sample-accurately and
 *                  gaplessly, so audio is smooth and starts the instant the first chunk
 *                  arrives (low latency) instead of waiting for the whole reply.
 *   • Barge-in   — interrupt() stops playback locally and tells the backend to abort.
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
}

const PLAYBACK_SAMPLE_RATE = 24000; // must match the backend TTS output rate
const MIC_FRAME_SIZE = 4096;        // ~170 ms of audio per outbound mic frame

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
    // Half-duplex: don't capture while the agent is talking (no echo), and respect mute.
    // Gate on BOTH the backend status (thinking/speaking) AND whether playback is still
    // draining, so the mic stays closed until the agent's voice has actually stopped.
    if (!this.micEnabled || this.agentHoldsFloor || this.player?.isActive()) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ctx) return;

    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = new Array<number>(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.send({ type: 'audio_data', data: { pcm16, sampleRate: this.ctx.sampleRate } });
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
