/**
 * Advanced engine configuration.
 * =====================================================================================
 * All the fine-grained voice-engine knobs that used to be settable ONLY through
 * backend/.env are now first-class, admin-editable settings, stored as one JSON blob on
 * the settings row (`advanced_config`) and threaded into each new session so they take
 * effect LIVE (no server restart). Each knob still falls back to its .env value, and the
 * .env value in turn falls back to the hard default here — so an un-set field changes
 * nothing.
 *
 * resolveAdvancedConfig() builds the effective config in priority order:
 *   stored value  >  environment variable  >  built-in default
 * and clamps everything to a safe range, so a bad stored value can never break a session.
 */

export interface AdvancedConfig {
  llm: {
    temperature: number;          // 0–1, sampling temperature for the intake LLM
    maxResponseTokens: number;    // cap on a single reply (short empathetic sentence + 1 question)
    frequencyPenalty: number;     // -2–2, discourages repeated tokens
    presencePenalty: number;      // -2–2, discourages repeated topics
  };
  humanization: {
    timingJitter: boolean;        // per-turn sampled response gap (never the same pause twice)
    paceJitter: boolean;          // per-turn TTS pace wobble (kills the melody loop)
    breaths: boolean;             // quiet inhale before longer replies
    noiseBed: boolean;            // continuous low room-tone in the browser
    telephonyEq: boolean;         // 300–3400 Hz band-pass + compression (phone-line realism)
  };
  fillers: {
    enabled: boolean;             // short "hmm…/సరే…" clips covering LLM thinking time
    delayMs: number;              // play a filler if real audio hasn't started within this long
  };
  tts: {
    sarvamTemperature: number | null; // v3-beta expressive variation (0.01–1), null = stable v3
    speakerTe: string;            // per-language Sarvam speaker override ('' = use Settings/default)
    speakerHi: string;
    speakerEn: string;
  };
  stt: {
    // English/OpenAI buffered-STT end-of-turn detection (the Sarvam path uses Sarvam VAD).
    vadRms: number;               // speech-energy floor, normalized 0–1
    silenceHangMs: number;        // trailing silence that ends a turn
    minSpeechMs: number;          // minimum real speech before a turn can finalize
    maxUtteranceMs: number;       // hard cap → force finalize
    noiseResetMs: number;         // clear a buffer that never became real speech
  };
  turnTaking: {
    resumeAfterInterruptMs: number; // re-ask if a barge-in turns out to be a false trigger
    floorSettleMs: number;          // echo-settle window after the agent finishes speaking
    noEndSignalFallbackMs: number;  // safety net if Sarvam END_SPEECH never arrives
  };
}

const num = (v: any, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const bool = (v: any, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const str = (v: any, def = ''): string => (typeof v === 'string' ? v.trim() : def);

/** Is an env flag "on"? Unset → default; anything but 0/off/false/no → on. */
const envFlag = (v: string | undefined, def: boolean): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return def;
  return !/^(0|off|false|no)$/.test(s);
};
const envNum = (v: string | undefined, def: number): number => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : def;
};

/** The built-in defaults, already folded with any backend/.env overrides. This is what the
 *  engine used before advanced settings existed, so an empty stored config is a no-op. */
export function envDefaults(): AdvancedConfig {
  const sarvamTemp = parseFloat(process.env.SARVAM_TTS_TEMPERATURE || '');
  return {
    llm: {
      temperature: envNum(process.env.INTAKE_TEMPERATURE, 0.6),
      maxResponseTokens: envNum(process.env.INTAKE_MAX_TOKENS, 220),
      frequencyPenalty: envNum(process.env.INTAKE_FREQUENCY_PENALTY, 0.6),
      presencePenalty: envNum(process.env.INTAKE_PRESENCE_PENALTY, 0.3),
    },
    humanization: {
      timingJitter: envFlag(process.env.VANI_TIMING_JITTER, true),
      paceJitter: envFlag(process.env.VANI_PACE_JITTER, true),
      breaths: envFlag(process.env.VANI_BREATHS, true),
      noiseBed: envFlag(process.env.VANI_NOISE_BED, true),
      telephonyEq: envFlag(process.env.VANI_TELEPHONY_EQ, false),
    },
    fillers: {
      enabled: !/^(0|off|false|no)$/i.test(String(process.env.SARVAM_FILLERS || '').trim()),
      delayMs: envNum(process.env.FILLER_DELAY_MS, 350),
    },
    tts: {
      sarvamTemperature: Number.isFinite(sarvamTemp) ? clamp(sarvamTemp, 0.01, 1) : null,
      speakerTe: str(process.env.TTS_SPEAKER_TE),
      speakerHi: str(process.env.TTS_SPEAKER_HI),
      speakerEn: str(process.env.TTS_SPEAKER_EN),
    },
    stt: {
      vadRms: envNum(process.env.STT_VAD_RMS, 0.035),
      silenceHangMs: envNum(process.env.STT_SILENCE_HANG_MS, 500),
      minSpeechMs: envNum(process.env.STT_MIN_SPEECH_MS, 450),
      maxUtteranceMs: envNum(process.env.STT_MAX_UTTERANCE_MS, 20000),
      noiseResetMs: envNum(process.env.STT_NOISE_RESET_MS, 1200),
    },
    turnTaking: {
      resumeAfterInterruptMs: envNum(process.env.RESUME_AFTER_INTERRUPT_MS, 3500),
      floorSettleMs: envNum(process.env.FLOOR_SETTLE_MS, 450),
      noEndSignalFallbackMs: envNum(process.env.NO_END_SIGNAL_FALLBACK_MS, 2500),
    },
  };
}

/** Merge a stored partial config over the env defaults and clamp every field to a safe range.
 *  Tolerates null / bad JSON / missing sections — any unknown or invalid field keeps its default. */
export function resolveAdvancedConfig(stored: any): AdvancedConfig {
  const d = envDefaults();
  let p: any = stored;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
  if (!p || typeof p !== 'object') p = {};
  const sTemp = p.tts?.sarvamTemperature;
  return {
    llm: {
      temperature: clamp(num(p.llm?.temperature, d.llm.temperature), 0, 1),
      maxResponseTokens: Math.round(clamp(num(p.llm?.maxResponseTokens, d.llm.maxResponseTokens), 40, 1000)),
      frequencyPenalty: clamp(num(p.llm?.frequencyPenalty, d.llm.frequencyPenalty), -2, 2),
      presencePenalty: clamp(num(p.llm?.presencePenalty, d.llm.presencePenalty), -2, 2),
    },
    humanization: {
      timingJitter: bool(p.humanization?.timingJitter, d.humanization.timingJitter),
      paceJitter: bool(p.humanization?.paceJitter, d.humanization.paceJitter),
      breaths: bool(p.humanization?.breaths, d.humanization.breaths),
      noiseBed: bool(p.humanization?.noiseBed, d.humanization.noiseBed),
      telephonyEq: bool(p.humanization?.telephonyEq, d.humanization.telephonyEq),
    },
    fillers: {
      enabled: bool(p.fillers?.enabled, d.fillers.enabled),
      delayMs: Math.round(clamp(num(p.fillers?.delayMs, d.fillers.delayMs), 0, 2000)),
    },
    tts: {
      sarvamTemperature: (sTemp === null || sTemp === undefined || sTemp === '')
        ? d.tts.sarvamTemperature
        : clamp(num(sTemp, d.tts.sarvamTemperature ?? 0.5), 0.01, 1),
      speakerTe: str(p.tts?.speakerTe, d.tts.speakerTe),
      speakerHi: str(p.tts?.speakerHi, d.tts.speakerHi),
      speakerEn: str(p.tts?.speakerEn, d.tts.speakerEn),
    },
    stt: {
      vadRms: clamp(num(p.stt?.vadRms, d.stt.vadRms), 0.005, 0.3),
      silenceHangMs: Math.round(clamp(num(p.stt?.silenceHangMs, d.stt.silenceHangMs), 150, 3000)),
      minSpeechMs: Math.round(clamp(num(p.stt?.minSpeechMs, d.stt.minSpeechMs), 100, 3000)),
      maxUtteranceMs: Math.round(clamp(num(p.stt?.maxUtteranceMs, d.stt.maxUtteranceMs), 3000, 60000)),
      noiseResetMs: Math.round(clamp(num(p.stt?.noiseResetMs, d.stt.noiseResetMs), 200, 5000)),
    },
    turnTaking: {
      resumeAfterInterruptMs: Math.round(clamp(num(p.turnTaking?.resumeAfterInterruptMs, d.turnTaking.resumeAfterInterruptMs), 1000, 15000)),
      floorSettleMs: Math.round(clamp(num(p.turnTaking?.floorSettleMs, d.turnTaking.floorSettleMs), 0, 2000)),
      noEndSignalFallbackMs: Math.round(clamp(num(p.turnTaking?.noEndSignalFallbackMs, d.turnTaking.noEndSignalFallbackMs), 800, 8000)),
    },
  };
}

/** Normalize an incoming settings payload's `advanced` object to the canonical, clamped shape
 *  for storage. (Same as resolveAdvancedConfig — stored form is already the resolved form.) */
export const sanitizeAdvancedConfig = resolveAdvancedConfig;
