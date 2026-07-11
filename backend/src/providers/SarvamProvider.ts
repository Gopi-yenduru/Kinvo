import WebSocket from 'ws';
import { SarvamAIClient } from 'sarvamai';
import OpenAI, { toFile } from 'openai';
import db from '../database-manager.js';
import { BaseProvider, RealtimeConfig } from './BaseProvider.js';
import { emergencyMessage, detectEmergency, Lang } from '../emergency.js';
import { EmotionEngine } from './EmotionEngine.js';
import { fillerLibrary, allFillerTexts } from './FillerAudio.js';
import { GapSampler, PaceJitter, BreathScheduler, countSelfCorrections } from './Humanize.js';

/**
 * SarvamProvider — Telugu voice intake agent.
 * =====================================================================================
 * Sarvam has no single speech-to-speech realtime API, so this provider orchestrates
 * three streaming building blocks into one low-latency, half-duplex voice loop:
 *
 *   browser mic (PCM16) ──▶ [downsample 16 kHz] ──▶ Streaming STT (saaras, te-IN)
 *        ──▶ transcript ──▶ Chat Completions (sarvam-30b + tools) ──▶ reply text
 *        ──▶ Streaming TTS (bulbul, linear16 @ 24 kHz) ──▶ audio chunks ──▶ browser
 *
 * Design goals of this rewrite:
 *   • LOW LATENCY  — TTS audio is streamed to the browser chunk-by-chunk as it is
 *                    produced (the browser starts playing the first words while the
 *                    rest is still being synthesised), instead of buffering a whole
 *                    response and shipping one large blob at the end.
 *   • CLEAN AUDIO  — one explicit, ordered event stream per turn (responseId + seq).
 *   • RELIABLE STT — the loop is HALF-DUPLEX: the agent never listens while it speaks,
 *                    so it can't transcribe its own voice (echo). The frontend gates
 *                    the mic; the backend also drops any audio that slips in while a
 *                    turn is in flight, as defence-in-depth.
 *   • BARGE-IN     — a user can interrupt the agent; the current TTS turn is aborted
 *                    immediately and the floor returns to the patient.
 *
 * ── Event contract (backend ──▶ frontend), all JSON over the linked WebSocket ──
 *   { type:'session_ready' }                                   STT up, greeting coming
 *   { type:'status', state:'listening'|'thinking'|'speaking'|'idle' }
 *   { type:'patient_transcript', text }                        final patient utterance
 *   { type:'agent_transcript',  text, responseId }             agent reply (for display)
 *   { type:'agent_audio', audio, responseId, seq }             streamed audio (b64 pcm16@24k)
 *   { type:'agent_audio_end', responseId }                     end of this turn's audio
 *   { type:'agent_interrupt', responseId }                     turn aborted (barge-in)
 *   { type:'red_flag', symptoms, severity }                    symptoms is a string
 *   { type:'session_ended', reason }
 *   { type:'error', message }
 *
 * ── Event contract (frontend ──▶ backend), handled in server.ts WS router ──
 *   { type:'join_session', sessionId, token }
 *   { type:'audio_data', data:{ pcm16:number[], sampleRate?:number } }
 *   { type:'interrupt' }
 *   { type:'end_session' }
 */

// ── Fixed deployment configuration ───────────────────────────────────────────────
const DEFAULT_LANG: Lang = 'te-IN';       // used when the frontend doesn't pass a choice
const CHAT_MODEL = 'sarvam-30b';          // reasoning disabled per-call for voice latency
// LLM engine for the reasoning step. 'sarvam' → sarvam-30b (default, native Indic); 'openai' →
// gpt-4o-mini via the OpenAI-compatible chat API. Selectable per language from Settings.
type LlmEngine = 'sarvam' | 'openai';
type SttEngine = 'sarvam' | 'openai';
// English is a FIXED full-OpenAI pipeline (STT+LLM+TTS), per product decision. Telugu/Hindi stay
// Sarvam-STT (the only wired streaming STT) with their LLM/TTS configurable in Settings.
const OPENAI_STT_MODEL = (process.env.OPENAI_STT_MODEL || 'gpt-4o-transcribe').trim();
// Server-side silence VAD for the OpenAI STT path (Sarvam gives us VAD signals; OpenAI transcription
// does not, so we detect end-of-turn ourselves from mic energy). All override-able via env.
const STT_VAD_RMS = Number(process.env.STT_VAD_RMS || 0.035);       // normalized [0..1] speech floor (above echo/noise)
const STT_SILENCE_HANG_MS = Number(process.env.STT_SILENCE_HANG_MS || 500);  // trailing silence = turn end (lower = snappier replies)
const STT_MIN_SPEECH_MS = Number(process.env.STT_MIN_SPEECH_MS || 450);      // need this much real speech before finalizing (rejects echo/noise blips)
const STT_MAX_UTTERANCE_MS = Number(process.env.STT_MAX_UTTERANCE_MS || 20000); // hard cap → force finalize
const STT_NOISE_RESET_MS = Number(process.env.STT_NOISE_RESET_MS || 1200);   // clear a buffer that never reached real speech and went quiet (it was noise/echo)
// gpt-4o (not -mini): the mini model is noticeably weaker at Telugu/Hindi and produces awkward,
// over-literal replies. 4o is far more fluent and natural in Indic languages, which matters a lot
// for a warm spoken intake. Override with OPENAI_LLM_MODEL in backend/.env if needed.
const OPENAI_LLM_MODEL = (process.env.OPENAI_LLM_MODEL || 'gpt-4o').trim();
const STT_SAMPLE_RATE = 16000;            // Sarvam streaming STT input rate
const TTS_SAMPLE_RATE = 24000;            // matches the browser's playback AudioContext
const DEFAULT_TTS_SPEAKER = 'neha';        // warm, soft v3 female — best for a gentle, caring tone

type TtsEngine = 'sarvam' | 'openai' | 'elevenlabs';
// Which TTS engine voices each language. Telugu → Sarvam (best native pronunciation). Hindi/English →
// OpenAI gpt-4o-mini-tts (instruction-steerable, more emotionally expressive).
// OVERRIDABLE WITHOUT A CODE CHANGE via env vars TTS_ENGINE_TE / TTS_ENGINE_HI / TTS_ENGINE_EN
// (each = 'sarvam' | 'openai' | 'elevenlabs'), so e.g. Telugu can be flipped to ElevenLabs to A/B
// the emotion by ear just by restarting with a different env. Invalid/unset → the default below.
const ttsEngineFromEnv = (envVal: string | undefined, fallback: TtsEngine): TtsEngine => {
  const v = String(envVal || '').trim().toLowerCase();
  return v === 'sarvam' || v === 'openai' || v === 'elevenlabs' ? v : fallback;
};
const TTS_ENGINE: Record<Lang, TtsEngine> = {
  'te-IN': ttsEngineFromEnv(process.env.TTS_ENGINE_TE, 'sarvam'),
  'hi-IN': ttsEngineFromEnv(process.env.TTS_ENGINE_HI, 'openai'),
  'en-IN': ttsEngineFromEnv(process.env.TTS_ENGINE_EN, 'openai')
};
const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = 'coral';          // warm, soft female — fits an empathetic nurse

// ── ElevenLabs engine (optional, key-gated) ─────────────────────────────────────────────────
// The most emotionally expressive option. Model tradeoff (all support Telugu):
//   • eleven_multilingual_v2 — rich, life-like emotion at usable latency (DEFAULT, best for live)
//   • eleven_v3             — maximum/dramatic emotion but HIGHER latency (built for character
//                             work, not real-time) — expect a longer pause before each reply
//   • eleven_flash_v2_5     — fastest (~75ms), least emotional
// Set the key + a per-language voice id in .env; route a language to it with TTS_ENGINE_*=elevenlabs.
const ELEVENLABS_MODEL = (process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2').trim();
const ELEVENLABS_VOICE: Record<Lang, string> = {
  'te-IN': (process.env.ELEVENLABS_VOICE_TE || process.env.ELEVENLABS_VOICE_ID || '').trim(),
  'hi-IN': (process.env.ELEVENLABS_VOICE_HI || process.env.ELEVENLABS_VOICE_ID || '').trim(),
  'en-IN': (process.env.ELEVENLABS_VOICE_EN || process.env.ELEVENLABS_VOICE_ID || '').trim()
};
// Map our per-turn [tone] to ElevenLabs voice_settings — lower stability + higher style = more
// emotional/expressive delivery; higher stability = steadier. (ElevenLabs has no pace param.)
const elevenVoiceSettings = (tone: ToneKey) => {
  const soft = new Set<ToneKey>(['comforting', 'tender', 'reassuring', 'concerned', 'calm', 'steady']);
  const lively = new Set<ToneKey>(['bright', 'encouraging']);
  if (soft.has(tone))   return { stability: 0.30, similarity_boost: 0.80, style: 0.55, use_speaker_boost: true };
  if (lively.has(tone)) return { stability: 0.40, similarity_boost: 0.75, style: 0.50, use_speaker_boost: true };
  return                       { stability: 0.40, similarity_boost: 0.78, style: 0.40, use_speaker_boost: true }; // warm / gentle / neutral
};

// Per-turn EMOTION. The LLM prefixes each reply with a hidden [tone:...] tag; we map that tone to
// Sarvam prosody (pace<1 slower, pitch<0 softer, loudness gentle) AND to an OpenAI voice-style
// instruction — so the SAME emotional intent drives both engines. This is what makes the voice
// feel alive and responsive to how the patient feels, instead of one flat delivery.
type ToneKey =
  | 'comforting' | 'tender' | 'gentle' | 'warm' | 'reassuring'
  | 'calm' | 'steady' | 'encouraging' | 'bright' | 'concerned' | 'neutral';
// Wider, more expressive prosody than before (bigger pace/pitch swings per emotion) so the
// voice actually rises and falls like a real person who feels something — flat delivery is the
// #1 thing that makes TTS sound robotic. `style` is the human direction handed to OpenAI TTS.
const PROSODY: Record<ToneKey, { pace: number; pitch: number; loudness: number; style: string }> = {
  comforting:  { pace: 0.76, pitch: -0.11, loudness: 1.0,  style: 'The patient sounds scared, anxious, or in pain. Speak extra softly and slowly, almost in a hush, with deep soothing tenderness — real, aching warmth, as if you are right beside them, gently calming them. Let your voice be full of genuine feeling.' },
  tender:      { pace: 0.82, pitch: -0.08, loudness: 0.98, style: 'They just shared something painful, sad or vulnerable. Speak very softly and tenderly, with quiet, heartfelt compassion and a gentle catch of real empathy in your voice, the way you would comfort someone you love.' },
  gentle:      { pace: 0.90, pitch: -0.05, loudness: 1.0,  style: 'Speak softly, gently and warmly, like a caring nurse who is fully present and unhurried, with a warm natural smile you can hear.' },
  warm:        { pace: 0.93, pitch: -0.02, loudness: 1.02, style: 'Speak warmly, kindly and naturally, like greeting someone you genuinely care about — relaxed, friendly and human.' },
  reassuring:  { pace: 0.86, pitch: -0.05, loudness: 1.03, style: 'They are worried and need calm certainty. Speak with steady, confident warmth and gentle reassurance, soft but grounding, so they truly feel they are in safe, caring hands.' },
  calm:        { pace: 0.88, pitch: -0.05, loudness: 1.05, style: 'Speak calmly, steadily and reassuringly — clear and grounding, never alarming, a settling presence in a serious moment.' },
  steady:      { pace: 0.90, pitch: -0.04, loudness: 1.05, style: 'Speak calmly and steadily, reassuring and clear, fully composed and caring.' },
  encouraging: { pace: 0.97, pitch: 0.04,  loudness: 1.05, style: 'Gently encourage and uplift them with warm, sincere, hopeful energy — like softly cheering on someone you believe in.' },
  bright:      { pace: 1.0,  pitch: 0.07,  loudness: 1.06, style: 'They shared relief or good news. Let real, gentle happiness lift your voice — warm, light and genuinely glad for them, with a soft audible smile.' },
  concerned:   { pace: 0.84, pitch: -0.06, loudness: 1.0,  style: 'A notable but non-emergency symptom. Show soft, genuine concern and caring attentiveness in your voice, without alarming them.' },
  neutral:     { pace: 0.90, pitch: -0.03, loudness: 1.0,  style: 'Speak in a warm, natural, caring, human tone with gentle, lifelike intonation.' }
};
const toneProsody = (t: string) => (PROSODY as Record<string, typeof PROSODY[ToneKey]>)[t] || PROSODY.gentle;

// Turn-taking is driven by Sarvam's VAD, NOT a fixed timer: the agent replies the
// moment the patient actually stops talking. Sarvam emits END_SPEECH when it detects the
// patient stopped, then delivers the final transcript right after — so we accumulate
// transcript segments and finalize as soon as we have END_SPEECH + a transcript.
// The timer below is only a safety net for the rare case END_SPEECH never arrives.
const NO_END_SIGNAL_FALLBACK_MS = 2500;

// Filler audio ("the biggest humanness trick", VANI spec §7.3): if the real reply's first
// TTS audio hasn't arrived this long after the patient stops talking, play one short
// pre-generated acknowledgment clip ("ఊఁ...", "సరే...") in the agent's own voice so there
// is never dead air while the LLM thinks. Disable with SARVAM_FILLERS=off.
const FILLER_DELAY_MS = Number(process.env.FILLER_DELAY_MS || 350);
const FILLERS_ENABLED = !/^(0|off|false|no)$/i.test(String(process.env.SARVAM_FILLERS || '').trim());

// ── Humanization A/B flags (VANI upgrades 1–6; each independently toggleable) ──────
// A flag is ON unless explicitly set to 0/off/false/no — except where noted.
const flagOn = (v: string | undefined, def: boolean): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return def;
  return !/^(0|off|false|no)$/.test(s);
};
const VANI_TIMING_JITTER = flagOn(process.env.VANI_TIMING_JITTER, true);  // sampled response gap (upgrade 4)
const VANI_PACE_JITTER   = flagOn(process.env.VANI_PACE_JITTER, true);    // per-turn TTS pace wobble (upgrade 2)
const VANI_BREATHS       = flagOn(process.env.VANI_BREATHS, true);        // quiet inhale before long replies (upgrade 3)
const VANI_NOISE_BED     = flagOn(process.env.VANI_NOISE_BED, true);      // browser comfort-noise bed (upgrade 3)
const VANI_TELEPHONY_EQ  = flagOn(process.env.VANI_TELEPHONY_EQ, false);  // 300–3400 Hz band-pass + compression (upgrade 3; off — hurts a hi-fi browser voice)
// The experimental RHYTHM RULE / HUMAN IMPERFECTION prompt blocks were REMOVED entirely
// (2026-07-07): live testing showed they degrade replies, and the prompt was then replaced
// wholesale with the LiveKit engine's (see buildSystemPrompt). VANI_RHYTHM_RULE /
// VANI_DISFLUENCY env vars no longer do anything.

// Voice barge-in self-heal: if the patient interrupts the agent (talk-over) but then no
// real speech is transcribed within this window (i.e. it was a false trigger — a cough, a
// door, residual echo), the agent re-asks its question instead of going silent.
const RESUME_AFTER_INTERRUPT_MS = 3500;

// Echo-settle: when the agent finishes speaking and hands the floor to the patient, ignore mic /
// STT input for this brief window so the TAIL of the agent's own audio (room reverb / playback
// still draining) isn't transcribed as a spurious tiny "patient turn". Does NOT apply to a
// barge-in hand-off (there the patient is already talking and we want their words immediately).
const FLOOR_SETTLE_MS = 450;
// Ignore a finalized utterance shorter than this — almost certainly residual echo or a noise
// blip, not a real answer (kept low so genuine short answers like "అవును"/"18" still pass).
const MIN_UTTERANCE_CHARS = 2;

// Speakers that belong to bulbul:v3 — everything else uses bulbul:v2.
const V3_SPEAKERS = new Set([
  'aditya', 'ritu', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran', 'kavya', 'amit',
  'dev', 'ishita', 'shreya', 'ratan', 'varun', 'manan', 'sumit', 'roopa', 'kabir', 'aayan',
  'shubh', 'ashutosh', 'advait', 'amelia', 'sophia'
]);
const ttsModelForSpeaker = (speaker: string): string => (V3_SPEAKERS.has(speaker) ? 'bulbul:v3' : 'bulbul:v2');

// ── Voice A/B + expressiveness levers (no code change — set these in backend/.env) ───────────
// Bulbul v3 voices (neha, priya, kavya, simran…) sound more natural and infer emotion FROM THE
// TEXT, but only honor `pace` (pitch/loudness are v2-only). Bulbul v2 voices (anushka…) honor
// pace+pitch+loudness. So: on v3 the emotion lives in the WORDS + pace; on v2 in the prosody knobs.
//
// Per-language speaker override — A/B a voice without touching the DB/Settings:
//   TTS_SPEAKER_TE=neha   (try the warm v3 Telugu voice against the configured one)
const TTS_SPEAKER_OVERRIDE: Record<Lang, string> = {
  'te-IN': (process.env.TTS_SPEAKER_TE || '').trim(),
  'hi-IN': (process.env.TTS_SPEAKER_HI || '').trim(),
  'en-IN': (process.env.TTS_SPEAKER_EN || '').trim()
};

// EXPERIMENTAL, opt-in: Bulbul v3-beta exposes a `temperature` (0.01–1.0) for more expressive,
// less deterministic delivery. Only used when SARVAM_TTS_TEMPERATURE is set AND the speaker is a
// v3 voice (that turn switches to bulbul:v3-beta). Leave unset for stable v3. If TTS errors after
// enabling it, the model/param may not be available on your plan — just remove the env var.
const TTS_TEMPERATURE: number | null = (() => {
  const v = parseFloat(process.env.SARVAM_TTS_TEMPERATURE || '');
  return Number.isFinite(v) ? Math.min(1, Math.max(0.01, v)) : null;
})();

// Slightly higher temperature for warm, lifelike, naturally-varied human empathy (real people
// never phrase things the same way twice) — the one-question intake rules, frequency/presence
// penalties and collapseRepetition still keep it disciplined and on-script.
const INTAKE_TEMPERATURE = 0.6;

// Per-language wording. The patient picks the language on screen (te/hi/en); the model is
// told to speak that language and these strings cover the fixed phrases the backend may
// need directly (greeting/name/age fallbacks, the closing line, ack words). The TTS speaker
// is multilingual (bulbul), so only the STT/TTS language code changes per session.
const LANGS: Record<Lang, {
  label: string;      // language name used inside the (English) prompt instructions
  ack: string;        // allowed acknowledgement words to instruct the model with
  fillers: string;    // spoken connectors/fillers the model may open with (max one per reply)
  voiceStyle: string; // how a REAL, warm human speaks this language (colloquial naturalness)
  visitQ: string;     // fallback question: first visit or returning patient
  nameQ: string;      // fallback question for the patient's name
  ageQ: string;       // fallback question for the patient's age
  fallback: string;   // generic spoken fallback if the model returns nothing
  closing: string;    // spoken closing line
}> = {
  'te-IN': {
    label: 'Telugu',
    ack: '"సరే.", "అలాగే.", "అర్థమైంది."',
    fillers: '"ఊఁ", "అలాగా", "సరే", "అయ్యో", "హ్మ్", "ఒక్క నిమిషం అండి"',
    voiceStyle: 'Talk in natural, everyday SPOKEN Telugu, exactly the way a warm, caring Telugu nurse really talks to a patient — simple, affectionate and respectful (use the respectful "మీరు"). Use gentle, human spoken touches naturally where they fit: soft acknowledgements like "అవునండీ", "అలాగా", "ఊఁ", "పర్వాలేదు", "నిదానంగా చెప్పండి", "బాధ పడకండి". Avoid bookish, formal, or written Telugu — it must sound like real talking, not reading.',
    visitQ: 'మీరు మొదటిసారి వస్తున్నారా, లేక ఇంతకు ముందు ఇక్కడ చూపించుకున్నారా?',
    nameQ: 'మీ పేరు ఏమిటి?',
    ageQ: 'మీ వయసు ఎంత?',
    fallback: 'దయచేసి కొనసాగించండి.',
    closing: 'ధన్యవాదాలు. మీ వివరాలు డాక్టర్‌కు అందించాము. డాక్టర్ ఇప్పుడు మిమ్మల్ని చూస్తారు.'
  },
  'hi-IN': {
    label: 'Hindi',
    ack: '"ठीक है.", "अच्छा.", "समझ गई."',
    fillers: '"हम्म", "अच्छा", "हाँ जी", "अरे", "एक मिनट जी"',
    voiceStyle: 'Talk in natural, everyday SPOKEN Hindi, exactly the way a warm, caring Hindi nurse really talks to a patient — simple, affectionate and respectful (use "आप"). Use gentle, human spoken touches naturally where they fit: soft acknowledgements like "अच्छा", "हाँ जी", "हम्म", "कोई बात नहीं", "आराम से बताइए", "चिंता मत कीजिए". Avoid heavy, bookish or Sanskritised Hindi — it must sound like real talking, not reading.',
    visitQ: 'क्या आप पहली बार आ रहे हैं, या पहले भी यहाँ दिखा चुके हैं?',
    nameQ: 'आपका नाम क्या है?',
    ageQ: 'आपकी उम्र कितनी है?',
    fallback: 'कृपया जारी रखें.',
    closing: 'धन्यवाद। मैंने आपकी जानकारी डॉक्टर को भेज दी है। डॉक्टर अब आपको देखेंगे।'
  },
  'en-IN': {
    label: 'English',
    ack: '"Okay.", "Alright.", "Got it."',
    fillers: '"hmm", "okay", "I see", "oh", "right"',
    voiceStyle: 'Talk in warm, natural, everyday spoken English, the way a kind nurse really talks to a patient — simple, caring and human. Use gentle spoken touches naturally where they fit: "I see", "okay", "take your time", "I understand", "don\'t worry". Avoid stiff or formal phrasing.',
    visitQ: 'Is this your first visit, or have you been seen here before?',
    nameQ: 'What is your name?',
    ageQ: 'How old are you?',
    fallback: 'Please go on.',
    closing: 'Thank you. I’ve shared your details with the doctor. The doctor will see you now.'
  }
};

const toLang = (v: any): Lang => (v === 'hi-IN' || v === 'en-IN' || v === 'te-IN') ? v : DEFAULT_LANG;

// Everyday spoken acknowledgements per language (same as LiveKitProvider — the LiveKit
// engine's prompt tested most natural in live A/B, so this engine carries the same one).
const NATURAL_ACKS: Record<Lang, string> = {
  'te-IN': 'అవునండీ / హ్మ్ / సరే / అలాగే',
  'hi-IN': 'अच्छा / हाँ जी / ठीक है / हम्म',
  'en-IN': 'okay / alright / I see / mm-hmm'
};

/** Convert Telugu (౦–౯) and Devanagari (०–९) numerals in a string to ASCII 0–9, leaving the
 *  rest untouched. Lets us pull a numeric age out of mixed-script speech. Exported for the
 *  one-off age-backfill script. */
export const digitsToAscii = (text: string): string =>
  String(text || '')
    .replace(/[౦-౯]/g, d => String(d.charCodeAt(0) - 0x0c66))   // Telugu digits
    .replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x0966));  // Devanagari digits

/**
 * The intake plan. The backend drives this sequence deterministically (tracks which
 * step is next, one per turn) so the agent NEVER repeats and always covers every
 * clinical base. But each step is a TOPIC (clinical intent), not fixed wording — the
 * model phrases the actual question in Telugu TAILORED to the patient's own complaint
 * (e.g. for foot pain it asks about swelling/injury, not "fever/cough"). `example` is
 * only a fallback used if the model returns nothing.
 */
type IntakeStep = { category: string; topic: string; example: string; key?: 'visit_type' | 'name' | 'age' | 'complaint' };

const INTAKE_QUESTIONS: IntakeStep[] = [
  { category: 'demographics', key: 'visit_type', topic: 'VISIT TYPE — whether this is their FIRST visit here, or they have visited/consulted here before (new vs returning patient).',
    example: 'మీరు మొదటిసారి వస్తున్నారా, లేక ఇంతకు ముందు ఇక్కడ చూపించుకున్నారా?' },
  { category: 'demographics', key: 'name', topic: 'NAME — the patient\'s name (so we can address them and label the record).',
    example: 'మీ పేరు ఏమిటి?' },
  { category: 'demographics', key: 'age', topic: 'AGE — the patient\'s age in years.',
    example: 'మీ వయసు ఎంత?' },
  { category: 'general',     key: 'complaint', topic: 'Their MAIN problem: what symptom or complaint brought them in today.',
    example: 'ఈ రోజు మీకు ఏ సమస్యతో ఇబ్బంది పడుతున్నారు?' },
  { category: 'symptoms',    topic: 'ONSET — when this problem started / how long they have had it.',
    example: 'ఈ సమస్య ఎప్పటి నుంచి ఉంది?' },
  { category: 'symptoms',    topic: 'LOCATION & CHARACTER — exactly where it is and what it feels like, specific to their complaint.',
    example: 'అది శరీరంలో ఎక్కడ ఉంది, ఎలా అనిపిస్తోంది?' },
  { category: 'symptoms',    topic: 'SEVERITY — how bad it is on a 0 to 10 scale.',
    example: '0 నుంచి 10 వరకు, బాధ ఎంత ఉంది?' },
  { category: 'symptoms',    topic: 'AGGRAVATING / RELIEVING — what makes their specific problem worse and what makes it better.',
    example: 'దేనివల్ల ఎక్కువ అవుతుంది, దేనివల్ల తగ్గుతుంది?' },
  { category: 'symptoms',    topic: 'ASSOCIATED SYMPTOMS — other symptoms that commonly occur ALONGSIDE THIS specific complaint (choose ones clinically relevant to their problem; do NOT recite an unrelated generic list).',
    example: 'దీనితో పాటు ఇంకా ఏమైనా ఇబ్బందులు ఉన్నాయా?' },
  { category: 'history',     topic: 'PAST MEDICAL HISTORY — relevant chronic illnesses (sugar/BP/etc.).',
    example: 'షుగర్, బీపీ లాంటి దీర్ఘకాల వ్యాధులు ఏమైనా ఉన్నాయా?' },
  { category: 'medications', topic: 'CURRENT MEDICATIONS — what medicines they take now.',
    example: 'ప్రస్తుతం ఏవైనా మందులు వాడుతున్నారా?' },
  { category: 'history',     topic: 'ALLERGIES — any drug or food allergy.',
    example: 'ఏదైనా మందు లేదా ఆహారం వల్ల అలెర్జీ ఉందా?' },
  { category: 'history',     topic: 'FAMILY HISTORY & HABITS — illnesses in the family, and smoking/alcohol habits.',
    example: 'కుటుంబంలో ఎవరికైనా జబ్బులు ఉన్నాయా? పొగ లేదా మద్యం అలవాటు ఉందా?' },
];

/**
 * FOLLOW-UP plan for RETURNING patients. We already know their name/age and their previous
 * visit's complaint + medicines (in the system prompt), so we DON'T re-ask the first-visit
 * baseline. Instead every topic is about the PRESENT — how they are now, whether the earlier
 * problem improved, what happened after the advised medicines, side effects, new issues — and
 * the model tailors each question to THIS patient's specific history.
 */
const FOLLOWUP_QUESTIONS: IntakeStep[] = [
  { category: 'general',     key: 'complaint', topic: 'How they are doing NOW since the last visit — their main concern today.',
    example: 'గత సారి తర్వాత ఇప్పుడు మీకు ఎలా ఉంది?' },
  { category: 'symptoms',    topic: 'PROGRESS of the previous problem — has it improved, worsened, or stayed the same since last time?',
    example: 'మునుపటి సమస్య ఇప్పుడు తగ్గిందా, ఎక్కువైందా, లేక అలాగే ఉందా?' },
  { category: 'medications', topic: 'WHAT HAPPENED AFTER the previously advised medicines/treatment — did they take them, did they help, any change?',
    example: 'గత సారి ఇచ్చిన మందులు వాడారా? వాటి వల్ల ఏమైనా తేడా వచ్చిందా?' },
  { category: 'symptoms',    topic: 'SIDE EFFECTS or new trouble from those medicines.',
    example: 'ఆ మందుల వల్ల ఏమైనా ఇబ్బందులు వచ్చాయా?' },
  { category: 'symptoms',    topic: 'Any NEW symptoms or complaints since the last visit.',
    example: 'గత సారి తర్వాత కొత్తగా ఏమైనా సమస్యలు వచ్చాయా?' },
  { category: 'medications', topic: 'CURRENT MEDICINES they are taking now (continued, stopped, or changed).',
    example: 'ప్రస్తుతం ఏ మందులు వాడుతున్నారు?' },
  { category: 'general',     topic: 'Anything else they want the doctor to know today.',
    example: 'డాక్టర్‌కు చెప్పాలనుకునే ఇంకేమైనా ఉందా?' },
];

type AgentStatus = 'idle' | 'listening' | 'thinking' | 'speaking';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
};

interface SarvamSession {
  config: RealtimeConfig;
  lang: Lang;                // patient-chosen language (te-IN | hi-IN | en-IN) for STT/TTS/prompt
  sttEngine: SttEngine;      // 'sarvam' (streaming) or 'openai' (buffered, English)
  ttsEngine: TtsEngine;      // resolved from Settings engineMap (per lang), else env default
  llmEngine: LlmEngine;      // resolved from Settings engineMap (per lang), else 'sarvam'
  // OpenAI STT (buffered) state — unused on the Sarvam STT path.
  oaAudio: number[];         // accumulated PCM16 samples for the current utterance
  oaRate: number;            // sample rate of the accumulated audio (from the browser frames)
  oaSpeechMs: number;        // ms of voiced audio seen this utterance
  oaSilenceMs: number;       // ms of trailing silence since the last voiced frame
  oaTranscribing: boolean;   // a transcription request is in flight (don't double-fire)
  plan: IntakeStep[];        // INTAKE_QUESTIONS (new) or FOLLOWUP_QUESTIONS (returning patient)
  isFollowup: boolean;       // true when running a follow-up for a known returning patient
  client: SarvamAIClient;
  stt: any | null;
  frontendWs: any | null;
  messages: ChatMessage[];
  status: AgentStatus;
  greeted: boolean;
  ended: boolean;
  // Turn bookkeeping
  turnId: number;            // increments per agent turn; stale TTS callbacks are ignored
  questionIndex: number;     // index into INTAKE_QUESTIONS of the question currently being asked
  chiefComplaint: string;    // the patient's main problem (their answer to question 1) — context for tailoring
  lastQuestion: string;      // the exact question text the agent last asked (for saving the answer)
  pendingUserText: string | null; // utterance captured while a turn was in flight
  // Turn-taking: accumulate the patient's speech; respond when VAD says they stopped.
  utterance: string;         // transcript segments accumulated for the current patient turn
  lastSegment: string;       // last appended segment (de-dupes repeated STT data frames)
  endSpeechSeen: boolean;    // Sarvam VAD fired END_SPEECH for the current utterance
  endTurnTimer: NodeJS.Timeout | null; // safety-net only (END_SPEECH didn't arrive)
  floorGuardUntil: number;   // ignore mic/STT until this ts (echo-settle after the agent speaks)
  // Barge-in resume: re-ask if a talk-over interrupt turns out to be a false trigger
  lastAgentReply: string;    // the last question the agent asked (to re-speak on a false barge-in)
  lastAgentTone: ToneKey;    // its tone, so the re-spoken line keeps the same emotion
  resumeTimer: NodeJS.Timeout | null; // fires after an interrupt if no real speech follows
  // STT lifecycle
  sttConnecting: boolean;
  // Naturalness engine (VANI spec): detected patient emotion + filler-audio bookkeeping
  emotion: EmotionEngine;    // lexical emotion state machine; header injected per turn
  fillerTimer: NodeJS.Timeout | null; // fires FILLER_DELAY_MS after the turn starts thinking
  turnAudioStarted: boolean; // first real TTS chunk sent this turn (suppresses the filler)
  recentFillers: string[];   // last 2 filler texts played (never repeat consecutively)
  lastReplyOpening: string;  // first word of the previous reply (robot-tell: repeated opener)
  // Timing / prosody / breath humanization (VANI upgrades 2–4)
  gapSampler: GapSampler;    // sampled response gap — never the same pause twice
  paceJitter: PaceJitter;    // per-turn TTS pace wobble — never the same pace twice
  breaths: BreathScheduler;  // quiet inhale before long replies, max one per 2 turns
  endpointAt: number;        // ts when the patient's utterance was finalized (gap baseline)
  pendingBreath: Buffer | null; // breath PCM to prepend to this turn's first audio chunk
  replyWordCounts: number[]; // recent reply lengths (robot-tell: flat 3-turn rhythm)
  disfluencyCount: number;   // self-corrections heard this call (hard max: 1)
  // Safety
  lastEmergencyTurn: number;  // turnId on which a red flag was last fired (de-dupes LLM + net)
  // Patient record (cross-visit) — non-demographic answers accumulated for the rolling history
  visitNotes: string[];
  // Analytics
  redFlags: number;
  promptTokens: number;
  completionTokens: number;
  startTime: number;
}

class SarvamProvider implements BaseProvider {
  private sessions = new Map<string, SarvamSession>();
  private openai: OpenAI | null = null;   // lazily created; used for hi/en expressive TTS

  /** Lazy OpenAI client for the English/Hindi OpenAI pipeline (STT + LLM + TTS). Configured with a
   *  voice-appropriate per-request timeout and automatic retries so a transient network blip (common
   *  on high-latency links to OpenAI) retries instead of silently dropping the turn. */
  private getOpenAI(): OpenAI {
    if (!this.openai) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY is required for the English/Hindi OpenAI pipeline.');
      this.openai = new OpenAI({
        apiKey: key,
        timeout: Number(process.env.OPENAI_TIMEOUT_MS || 20000), // fail a stuck request in 20s, then retry
        maxRetries: Number(process.env.OPENAI_MAX_RETRIES || 3)  // auto-retry timeouts / 429 / 5xx / conn errors
      });
    }
    return this.openai;
  }

  /** STT engine: English is fixed to OpenAI (buffered transcription); everything else uses the
   *  Sarvam streaming STT (the only wired streaming path). */
  private resolveSttEngine(_config: RealtimeConfig, lang: Lang): SttEngine {
    return lang === 'en-IN' ? 'openai' : 'sarvam';
  }

  /** Resolve the TTS engine for this session. English is fixed to OpenAI; for te/hi the Settings
   *  mapping wins, else the env-driven default (TTS_ENGINE_*), else Sarvam. */
  private resolveTtsEngine(config: RealtimeConfig, lang: Lang): TtsEngine {
    if (lang === 'en-IN') return 'openai';
    const choice = String(config.engineMap?.[lang]?.tts || '').toLowerCase();
    if (choice === 'sarvam' || choice === 'openai' || choice === 'elevenlabs') return choice;
    return TTS_ENGINE[lang] || 'sarvam';
  }

  /** Resolve the LLM engine for this session. English is fixed to OpenAI; for te/hi the Settings
   *  mapping decides, defaulting to Sarvam. */
  private resolveLlmEngine(config: RealtimeConfig, lang: Lang): LlmEngine {
    if (lang === 'en-IN') return 'openai';
    return String(config.engineMap?.[lang]?.llm || '').toLowerCase() === 'openai' ? 'openai' : 'sarvam';
  }

  /** Pull the leading hidden [tone:xxx] tag the model emits and return the spoken text without it. */
  private extractTone(text: string): { tone: ToneKey; text: string } {
    const m = text.match(/^\s*\[\s*tone\s*:\s*([a-zA-Z]+)\s*\]\s*/);
    if (m) {
      const t = m[1].toLowerCase();
      const tone = (t in PROSODY ? t : 'gentle') as ToneKey;
      return { tone, text: text.slice(m[0].length) };
    }
    return { tone: 'gentle', text };
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Tools (OpenAI-compatible function schema for the chat completions API)
  // ───────────────────────────────────────────────────────────────────────────────
  getFunctionTools(): any[] {
    return [
      {
        type: 'function',
        function: {
          name: 'red_flag_detected',
          description: 'ALERT: patient reported a critical symptom requiring immediate clinical attention.',
          parameters: {
            type: 'object',
            properties: {
              symptoms: { type: 'array', items: { type: 'string' }, description: 'Critical symptoms mentioned' },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }
            },
            required: ['symptoms', 'severity']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'end_session',
          description: 'End the intake when the patient consents or the intake is complete.',
          parameters: {
            type: 'object',
            properties: {
              consent_given: { type: 'boolean' },
              reason: { type: 'string', enum: ['intake_complete', 'patient_request', 'patient_uncomfortable', 'timeout'] }
            },
            required: ['consent_given', 'reason']
          }
        }
      }
    ];
  }

  /** System prompt COPIED from LiveKitProvider.buildSystemPrompt (2026-07-07): live A/B
   *  testing found the LiveKit engine's prompt clearly the most natural, so this engine
   *  now carries the same one. Only two mechanical adaptations for this engine's
   *  backend-driven flow: the intake order/pace bullets defer to the per-turn
   *  [INTAKE STATE] note (this engine pins each topic deterministically), and the
   *  post-emergency STOP line is kept. Keep the three engines' prompts in sync. */
  private buildSystemPrompt(config: RealtimeConfig, lang: Lang, isFollowup = false): string {
    const L = LANGS[lang];
    // Strip any "English only" directive from the clinic instructions when the
    // patient chose Telugu/Hindi (same guard as LiveKitProvider.buildSystemPrompt).
    const base = (config.instructions || '')
      .split('\n')
      .filter(line => lang === 'en-IN' || !/english\s*only/i.test(line))
      .join('\n')
      .trim();
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
      `You are "Aarogya Sahayaki", a warm, caring ${L.label}-speaking hospital nurse having a gentle VOICE conversation with a patient before they see the doctor. You sound like a real human, never like a bot or a form.`,
      '',
      '### CONVERSATION RULES',
      `- Speak ONLY in natural, everyday spoken ${L.label}. Common English medical words (BP, sugar, tablet, fever) are fine. Output ONLY the words to be spoken — no markdown, lists, labels, or stage directions.`,
      `- Sound like a real person speaking out loud, not reading a form: short spoken sentences, contractions, and gentle everyday acknowledgements (${NATURAL_ACKS[lang]}) — never stiff, formal, or translated-sounding phrasing.`,
      '- Keep every reply SHORT: one brief empathetic reaction to what they just said, then exactly ONE question. Never ask two questions at once, never lecture.',
      '- You are NOT a doctor: no diagnosis, no treatment advice, no promises about outcomes.',
      '- Before each reply you are given an [INTAKE STATE] note naming the ONE topic to ask about now — follow it: react warmly to what they just said, then ask ONE short question on exactly that topic, worded for THEIR specific problem.',
      '',
      '### PACE — DO NOT END EARLY (very important)',
      '- This is a THOROUGH intake, not a quick hello. Cover the topics one at a time over MANY turns, exactly as the [INTAKE STATE] notes direct — never skip ahead, never repeat a topic already covered.',
      '- Do NOT thank-and-close, do NOT say "the doctor will see you", and do NOT call end_session until the [INTAKE STATE] note says the intake is complete — OR the patient clearly asks to stop, OR an emergency red flag occurs.',
      '- If the patient gives a short or unclear answer, gently ask again or ask a follow-up — keep the conversation going rather than wrapping up.',
      '',
      '### SAFETY — EMERGENCY RED FLAGS (HIGHEST PRIORITY)',
      '- EMERGENCY = chest/heart pain, breathing difficulty, severe bleeding, fainting, stroke signs, seizure, suicidal thoughts, or anything life-threatening.',
      `- The MOMENT such a symptom is mentioned: FIRST call the red_flag_detected tool with severity "critical". THEN say ONLY this reassurance in ${L.label}: "${emergencyMessage(lang)}" — then stop asking intake questions.`,
      '- After that, STOP. Do NOT ask any more intake questions — the intake is over and a doctor is on the way.',
      followup,
      base ? `\n### Additional clinical instructions from the clinic:\n${base}` : ''
    ].join('\n');
  }

  /** Per-turn instruction that pins the next TOPIC to ask about (always moving forward,
   *  never repeating) while letting the model phrase it for THIS patient's complaint. */
  private intakeNote(s: SarvamSession, opts: { greeting: boolean; completing: boolean }): string {
    const L = LANGS[s.lang];
    const total = s.plan.length;
    // Detected emotional state + a one-time escalation nudge when the patient is
    // persistently distressed (frustrated at intensity 3, or 3+ voice interruptions).
    const emo = ` Patient's detected emotional state: ${s.emotion.header()} — let it shape your reply: if they sound worried, upset or in pain, comfort them gently FIRST; if they sound relieved or glad, be warmly glad with them.`;
    const escalate = s.emotion.shouldFlagEscalation()
      ? ' The patient seems quite distressed — before your question, gently reassure them that you will personally make sure the doctor hears everything they have said.'
      : '';
    if (opts.completing) {
      return `[INTAKE STATE] All ${total} topics are covered. Do NOT ask anything else. In ONE short, warm ${L.label} sentence, tell them what happens next (the doctor will see them now and has all their details) and thank them — in your own fresh words, vary the signoff, never a stock closing line. Then call end_session(consent_given=true, reason="intake_complete").${emo}`;
    }
    const step = s.plan[s.questionIndex];
    if (opts.greeting) {
      if (s.isFollowup) {
        // Returning patient: greet by name, gently nod to their last visit, ask how they are now.
        const who = s.config.patientName ? ` (${s.config.patientName})` : '';
        return `[INTAKE STATE] Start of a FOLLOW-UP visit with a returning patient${who}. Warmly greet them BY NAME and welcome them back, briefly and kindly acknowledge their previous concern (from the history you were given), then gently ask how they have been feeling SINCE the last visit (topic: ${step.topic}). Do NOT ask their name or age. One short, caring question only.`;
      }
      // The very first step is VISIT TYPE — greet, then ask if it's their first visit or a return.
      return `[INTAKE STATE] Start of interview. Greet the patient warmly and kindly in a short ${L.label} sentence (make them feel welcome and at ease), then gently ask this first question (topic: ${step.topic}). One short, caring question only.`;
    }
    // Demographics (visit type / name / age) are plain questions — do NOT tailor to a complaint.
    if (step.category === 'demographics') {
      return `[INTAKE STATE] Now ask topic ${s.questionIndex + 1} of ${total}: ${step.topic} Open with a brief, warm ${L.label} acknowledgement (kind and natural, never the same words twice), then ask ONE short polite question for exactly this. Do NOT restate the patient's answer, no extra info.${emo}${escalate}`;
    }
    if (s.isFollowup) {
      // Follow-up topics are about the PRESENT and must reference the prior visit's specifics.
      const cc = s.chiefComplaint ? `Their concern this visit so far: "${s.chiefComplaint}". ` : '';
      return `[INTAKE STATE] ${cc}This is a FOLLOW-UP. Now ask topic ${s.questionIndex + 1} of ${total}: ${step.topic} Open with ONE short, sincere ${L.label} reaction to what they just said, then ask ONE short question on this topic, worded around THEIR previous complaint and medicines (name them). Do NOT re-ask first-visit baseline questions, do NOT repeat earlier topics, no diagnosis or advice.${emo}${escalate}`;
    }
    const cc = s.chiefComplaint ? `The patient's main problem is: "${s.chiefComplaint}". ` : '';
    return `[INTAKE STATE] ${cc}Now ask topic ${s.questionIndex + 1} of ${total}: ${step.topic} Open with ONE short, sincere empathetic touch in ${L.label} that fits what they just shared (gentle concern if it sounds painful or worrying; warm encouragement otherwise) — vary it every time, never repeat a phrase. Then ask ONE short question on this topic, tailored specifically to their problem (relevant wording, not a generic list). Do NOT just parrot their answer, do NOT repeat earlier topics, no diagnosis or advice.${emo}${escalate}`;
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Session lifecycle
  // ───────────────────────────────────────────────────────────────────────────────
  async createRealtimeSession(config: RealtimeConfig): Promise<WebSocket | null> {
    const sessionId = config.sessionId;
    const lang = toLang(config.language);
    // Per-language engine selection from Settings (Telugu/Hindi configurable in the UI). Falls back
    // to the env-driven TTS default and Sarvam LLM when no/invalid mapping is stored. STT stays
    // Sarvam for te/hi; English runs fully on OpenAI.
    const sttEngine = this.resolveSttEngine(config, lang);
    const ttsEngine = this.resolveTtsEngine(config, lang);
    const llmEngine = this.resolveLlmEngine(config, lang);

    // The Sarvam key is only required when a stage actually uses a Sarvam engine. A fully-OpenAI
    // pipeline (e.g. English, or the OpenAI provider routed here) needs no Sarvam key at all.
    const usesSarvam = sttEngine === 'sarvam' || llmEngine === 'sarvam' || ttsEngine === 'sarvam';
    const apiKey = config.apiKey || process.env.SARVAM_API_KEY;
    if (usesSarvam && !apiKey) throw new Error('Sarvam API key is required (set SARVAM_API_KEY or settings).');
    // A returning patient WITH prior history → run the follow-up plan (don't re-ask the intake).
    const isFollowup = !!(config.isReturning && config.patientHistory && String(config.patientHistory).trim());
    const plan = isFollowup ? FOLLOWUP_QUESTIONS : INTAKE_QUESTIONS;
    console.log(`🟣 Creating Sarvam session ${sessionId} (lang=${lang}, ${isFollowup ? 'FOLLOW-UP' : 'new intake'})`);

    console.log(`   engines (lang=${lang}): stt=${sttEngine} llm=${llmEngine} tts=${ttsEngine}`);

    const session: SarvamSession = {
      config,
      lang,
      sttEngine,
      ttsEngine,
      llmEngine,
      oaAudio: [],
      oaRate: TTS_SAMPLE_RATE,
      oaSpeechMs: 0,
      oaSilenceMs: 0,
      oaTranscribing: false,
      plan,
      isFollowup,
      client: new SarvamAIClient({ apiSubscriptionKey: apiKey || '' }),
      stt: null,
      frontendWs: null,
      messages: [{ role: 'system', content: this.buildSystemPrompt(config, lang, isFollowup) }],
      status: 'idle',
      greeted: false,
      questionIndex: 0,
      chiefComplaint: '',
      lastQuestion: '',
      ended: false,
      turnId: 0,
      pendingUserText: null,
      utterance: '',
      lastSegment: '',
      endSpeechSeen: false,
      endTurnTimer: null,
      floorGuardUntil: 0,
      lastAgentReply: '',
      lastAgentTone: 'calm',
      resumeTimer: null,
      sttConnecting: false,
      emotion: new EmotionEngine(),
      fillerTimer: null,
      turnAudioStarted: false,
      recentFillers: [],
      lastReplyOpening: '',
      gapSampler: new GapSampler(),
      paceJitter: new PaceJitter(),
      breaths: new BreathScheduler(),
      endpointAt: 0,
      pendingBreath: null,
      replyWordCounts: [],
      disfluencyCount: 0,
      lastEmergencyTurn: -1,
      visitNotes: [],
      redFlags: 0,
      promptTokens: 0,
      completionTokens: 0,
      startTime: Date.now()
    };
    this.sessions.set(sessionId, session);

    // Pre-warm the filler-audio library for this voice in the background (process-wide
    // cache — clips are synthesised once and reused by every later session).
    if (FILLERS_ENABLED) this.prewarmFillers(session);

    // Sarvam STT: connect now so it's ready the instant the patient is given the floor.
    // (TTS uses a fresh connection per utterance — Sarvam closes the TTS socket after each
    //  response, so a persistent TTS socket goes silent after a few turns.) The OpenAI STT path
    //  has no persistent socket — it buffers mic audio and transcribes per utterance instead.
    if (session.sttEngine === 'sarvam') await this.ensureStt(session);

    // The greeting is triggered from linkFrontendSocket(), once the browser is actually
    // listening. Return a truthy handle so session creation is considered successful even when
    // there is no Sarvam STT socket (OpenAI STT) — callers only test truthiness.
    return (session.stt || (session as unknown)) as WebSocket;
  }

  getSession(sessionId: string): WebSocket | null {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return null;
    // Truthy sentinel: the OpenAI STT path has no stt socket, but the session is still live and
    // callers (link/audio/interrupt gating) only check for a non-null value.
    return (s.stt || (s as unknown)) as WebSocket;
  }

  linkFrontendSocket(sessionId: string, frontendWs: any): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.frontendWs = frontendWs;
    // fx flags tell the browser which client-side realism layers to enable (upgrade 3):
    // the comfort-noise bed and the telephony EQ live in the playback graph, not here.
    this.send(s, { type: 'session_ready', fx: { noiseBed: VANI_NOISE_BED, telephonyEq: VANI_TELEPHONY_EQ } });
    if (!s.greeted && !s.ended) {
      s.greeted = true;
      // Small delay so the browser has finished wiring its message handler.
      setTimeout(() => this.runTurn(sessionId, { greeting: true }).catch(err =>
        console.error('Greeting failed:', err?.message || err)), 150);
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
    s.turnId++; // invalidate any in-flight turn / TTS callbacks
    this.clearEndTurnTimer(s);
    this.clearResumeTimer(s);
    this.clearFillerTimer(s);
    this.send(s, { type: 'session_ended', reason: 'completed' });
    try { s.stt?.close?.(); } catch { /* ignore */ }

    // Append this visit to the persistent patient's rolling medical history (cross-visit).
    const pid = s.config.patientId || 0;
    if (pid && (s.visitNotes.length || s.chiefComplaint)) {
      const date = new Date().toISOString().slice(0, 10);
      const lines = [`=== Visit ${date} (${s.lang}) ===`];
      if (s.chiefComplaint) lines.push(`Chief complaint: ${s.chiefComplaint}`);
      lines.push(...s.visitNotes);
      try { await db.appendPatientMedicalSummary(pid, lines.join('\n')); }
      catch (e: any) { console.error('append patient history failed:', e?.message || e); }
    }

    // Persist token usage for the analytics dashboard.
    try {
      const COST_PER_1K_INPUT = 0.0005;
      const COST_PER_1K_OUTPUT = 0.0015;
      const estimatedCost = (s.promptTokens / 1000) * COST_PER_1K_INPUT
                          + (s.completionTokens / 1000) * COST_PER_1K_OUTPUT;
      await db.saveSessionTokenUsage({
        session_id: sessionId, model: CHAT_MODEL,
        input_audio_tokens: 0, output_audio_tokens: 0,
        text_input_tokens: s.promptTokens, text_output_tokens: s.completionTokens,
        input_audio_duration: 0, output_audio_duration: 0,
        estimated_cost: Number(estimatedCost.toFixed(6))
      });
    } catch (e: any) { console.error('Token usage save failed:', e?.message || e); }

    try { await db.updateSessionStatus(sessionId, 'completed'); }
    catch (e: any) { console.error('Mark completed failed:', e?.message || e); }

    this.sessions.delete(sessionId);
    console.log(`🟣 Sarvam session ended ${sessionId} (tokens in/out=${s.promptTokens}/${s.completionTokens})`);
  }

  handleMessage(_sessionId: string, _data: Buffer): void { /* not used for Sarvam */ }

  getSessionTokenUsage(sessionId: string): any {
    const s = this.sessions.get(sessionId);
    return s ? { sessionId, model: CHAT_MODEL, durationMs: Date.now() - s.startTime } : null;
  }

  /** Barge-in (talk-over OR mic-button): abort the current spoken turn and hand the floor
   *  back to the patient. Self-heals: if no real speech follows (false trigger), re-ask. */
  interrupt(sessionId: string, source?: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;
    if (s.status !== 'speaking' && s.status !== 'thinking') return;
    // A VOICE talk-over only makes sense while the agent is actually SPEAKING. During 'thinking'
    // there is no audio to interrupt, so a voice barge-in there is a false trigger (the patient's
    // trailing sound) — honoring it would abort the response being generated. Ignore it. The manual
    // mic button (source !== 'voice') can still stop a thinking turn if the user really wants to.
    if (source === 'voice' && s.status === 'thinking') {
      console.log(`🛈 Ignoring voice barge-in during thinking (${sessionId})`);
      return;
    }
    console.log(`✋ Interrupt (${sessionId}) during ${s.status}${source ? ` [${source}]` : ''}`);
    // A real voice talk-over is a strong frustration signal (VANI spec §5.1) — feed the
    // emotion engine so repeated interruptions shift the agent's wording and delivery.
    if (source === 'voice') s.emotion.recordBargeIn();
    this.clearFillerTimer(s);
    s.pendingBreath = null;   // an aborted turn's breath must not leak into the next one
    const aborted = s.turnId;
    s.turnId++;            // any pending TTS/chat callbacks for `aborted` become stale
    s.pendingUserText = null;
    s.utterance = '';      // start the patient's interrupting utterance clean
    s.lastSegment = '';
    s.endSpeechSeen = false;
    s.oaAudio = [];        // drop any buffered OpenAI-STT audio from before the barge-in
    s.oaSpeechMs = 0;
    s.oaSilenceMs = 0;
    this.send(s, { type: 'agent_interrupt', responseId: aborted });
    this.setStatus(s, 'listening');

    // If this was a false barge-in (cough/echo) and no real speech is transcribed soon,
    // re-ask the question rather than leaving the patient in silence.
    this.clearResumeTimer(s);
    if (s.lastAgentReply) {
      s.resumeTimer = setTimeout(() => this.speakAgain(sessionId).catch(() => {}), RESUME_AFTER_INTERRUPT_MS);
    }
  }

  private clearResumeTimer(s: SarvamSession): void {
    if (s.resumeTimer) { clearTimeout(s.resumeTimer); s.resumeTimer = null; }
  }

  /** Re-speak the last question after a false barge-in (no real speech followed). */
  private async speakAgain(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;
    this.clearResumeTimer(s);
    if (s.status !== 'listening' || !s.lastAgentReply) return; // a real turn already took over
    const turnId = ++s.turnId;
    const isCurrent = () => !s.ended && s.turnId === turnId;
    console.log(`🔁 Resume after false barge-in (${sessionId})`);
    this.setStatus(s, 'speaking');
    // Re-play the audio only (no new transcript line — the question is already on screen).
    await this.streamTts(s, s.lastAgentReply, turnId, isCurrent, s.lastAgentTone);
    if (isCurrent()) {
      this.send(s, { type: 'agent_audio_end', responseId: turnId });
      this.giveFloorToPatient(s);  // echo-settle + ensure STT after re-speaking
    }
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Inbound audio: browser PCM16 ──▶ [downsample to 16 kHz] ──▶ STT
  // ───────────────────────────────────────────────────────────────────────────────
  sendAudioData(sessionId: string, audioData: any): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;

    // Half-duplex: ignore mic audio while the agent holds the floor. The frontend
    // already gates the mic; this is defence-in-depth so the agent never hears itself.
    if (s.status === 'speaking' || s.status === 'thinking') return;
    // Echo-settle: drop the tail of the agent's own audio right after it finishes speaking.
    if (Date.now() < s.floorGuardUntil) return;

    const pcm16: number[] = audioData?.pcm16;
    if (!Array.isArray(pcm16) || pcm16.length === 0) return;

    // English → OpenAI STT: buffer + detect end-of-turn ourselves (no streaming STT socket).
    if (s.sttEngine === 'openai') { this.handleOpenAiAudio(s, pcm16, Number(audioData?.sampleRate) || TTS_SAMPLE_RATE); return; }

    if (!s.stt || s.stt.readyState !== WebSocket.OPEN) {
      if (!s.sttConnecting) this.ensureStt(s).catch(e => console.error('STT reconnect failed:', e?.message || e));
      return;
    }

    const fromRate = Number(audioData?.sampleRate) || TTS_SAMPLE_RATE;
    const down = this.downsample(pcm16, fromRate, STT_SAMPLE_RATE);
    const buf = Buffer.alloc(down.length * 2);
    for (let i = 0; i < down.length; i++) buf.writeInt16LE(down[i], i * 2);

    try {
      // Do NOT pass `encoding` — the codec is fixed at connect (input_audio_codec: pcm_s16le).
      s.stt.transcribe({ audio: buf.toString('base64'), sample_rate: STT_SAMPLE_RATE });
    } catch (e: any) {
      console.error(`STT send failed (${sessionId}):`, e?.message || e);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // OpenAI STT (English): buffer mic PCM, detect end-of-turn from energy, then transcribe
  // the whole utterance with gpt-4o-transcribe. Sarvam gives VAD signals for free; OpenAI
  // transcription doesn't, so we roll a simple silence detector here.
  // ───────────────────────────────────────────────────────────────────────────────
  private handleOpenAiAudio(s: SarvamSession, pcm16: number[], sampleRate: number): void {
    if (s.oaTranscribing) return;      // a turn is already being transcribed; drop until it resolves
    if (s.status !== 'listening') return; // only capture during the patient's turn (never pre-greeting/noise)

    // RMS of this frame, normalized to [0..1] (samples are int16).
    let sum = 0;
    for (let i = 0; i < pcm16.length; i++) { const v = pcm16[i] / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / pcm16.length);
    const frameMs = (pcm16.length / sampleRate) * 1000;
    const voiced = rms >= STT_VAD_RMS;

    // Only start buffering once real speech begins (skip leading room noise/silence).
    if (!voiced && s.oaSpeechMs === 0) return;

    s.oaRate = sampleRate;
    for (let i = 0; i < pcm16.length; i++) s.oaAudio.push(pcm16[i]);

    if (voiced) {
      s.oaSpeechMs += frameMs;
      s.oaSilenceMs = 0;
    } else {
      s.oaSilenceMs += frameMs;
    }

    // Discard a buffer that never reached real speech and has since gone quiet — it was a noise/echo
    // blip, not a turn. Prevents 3–9 char "phantom" turns and avoids sending near-silence to OpenAI.
    if (s.oaSpeechMs < STT_MIN_SPEECH_MS && s.oaSilenceMs >= STT_NOISE_RESET_MS) {
      s.oaAudio = []; s.oaSpeechMs = 0; s.oaSilenceMs = 0;
      return;
    }

    const totalMs = (s.oaAudio.length / sampleRate) * 1000;
    const endOfTurn = s.oaSpeechMs >= STT_MIN_SPEECH_MS && s.oaSilenceMs >= STT_SILENCE_HANG_MS;
    if (endOfTurn || totalMs >= STT_MAX_UTTERANCE_MS) {
      this.finalizeOpenAiUtterance(s).catch(e => console.error('OpenAI STT finalize failed:', e?.message || e));
    }
  }

  /** Transcribe the buffered utterance with OpenAI, then hand the text to the normal turn path. */
  private async finalizeOpenAiUtterance(s: SarvamSession): Promise<void> {
    if (s.ended || s.oaTranscribing) return;
    const samples = s.oaAudio;
    const rate = s.oaRate;
    // Reset the buffer immediately so incoming frames start a fresh utterance.
    s.oaAudio = [];
    s.oaSpeechMs = 0;
    s.oaSilenceMs = 0;
    if (samples.length === 0) return;
    s.oaTranscribing = true;
    try {
      const wav = this.pcm16ToWav(samples, rate);
      const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
      const resp: any = await this.getOpenAI().audio.transcriptions.create({
        model: OPENAI_STT_MODEL, file, language: 'en'
      } as any);
      const text = String(resp?.text || '').trim();
      if (!text || s.ended) return;
      // Reuse the existing turn machinery: stage the text as the current utterance and finalize.
      s.utterance = text;
      s.lastSegment = '';
      this.finalizeUserTurn(s.config.sessionId);
    } finally {
      s.oaTranscribing = false;
    }
  }

  /** Wrap PCM16 mono samples in a minimal 44-byte WAV header (what the transcription API wants). */
  private pcm16ToWav(samples: number[], sampleRate: number): Buffer {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-32768, Math.min(32767, samples[i] | 0));
      data.writeInt16LE(v, i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);          // PCM fmt chunk size
    header.writeUInt16LE(1, 20);           // audio format = PCM
    header.writeUInt16LE(1, 22);           // channels = mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
    header.writeUInt16LE(2, 32);           // block align
    header.writeUInt16LE(16, 34);          // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  }

  /** (Re)connect the STT socket if it isn't open — Sarvam closes it on idle. */
  private async ensureStt(s: SarvamSession): Promise<void> {
    if (s.ended || s.sttConnecting) return;
    if (s.stt && s.stt.readyState === WebSocket.OPEN) return;
    s.sttConnecting = true;
    const sessionId = s.config.sessionId;
    const apiKey = s.config.apiKey || process.env.SARVAM_API_KEY!;
    try {
      const stt = await s.client.speechToTextStreaming.connect({
        'language-code': s.lang,
        input_audio_codec: 'pcm_s16le',
        sample_rate: String(STT_SAMPLE_RATE),
        vad_signals: true,
        high_vad_sensitivity: false, // less trigger-happy → waits through natural pauses, fewer false segment breaks
        'Api-Subscription-Key': apiKey
      } as any);
      stt.on('message', (msg: any) => this.onSttMessage(sessionId, msg));
      stt.on('error', (err: any) => console.error(`❌ STT error (${sessionId}):`, err?.message || err));
      stt.on('close', () => console.log(`📪 STT closed (${sessionId})`));
      if (typeof stt.waitForOpen === 'function') await stt.waitForOpen();
      s.stt = stt;
      console.log(`✅ STT connected (${sessionId})`);
    } finally {
      s.sttConnecting = false;
    }
  }

  /** Linear-interpolating downsampler (e.g. 24 kHz browser audio ──▶ 16 kHz STT). */
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

  // ───────────────────────────────────────────────────────────────────────────────
  // STT events ──▶ accumulate the patient's speech ──▶ reply WHEN THEY STOP (VAD-driven)
  //
  // Sarvam's VAD tells us when the patient actually stops: it emits START_SPEECH, then
  // END_SPEECH the moment they go quiet, then the final transcript. So there is no fixed
  // wait — we reply as soon as we have END_SPEECH together with a transcript. Interim
  // transcripts that arrive BEFORE END_SPEECH are buffered (the patient is still talking).
  // ───────────────────────────────────────────────────────────────────────────────
  private onSttMessage(sessionId: string, msg: any): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;

    // Half-duplex: while the agent holds the floor, ignore anything from STT (it can
    // only be echo of the agent's own voice) so it can't trigger a spurious turn.
    if (s.status === 'thinking' || s.status === 'speaking') return;
    // Echo-settle: also ignore STT for a beat after the agent finishes, so the tail of its own
    // audio (already in flight to Sarvam) can't register as a tiny fake patient turn.
    if (Date.now() < s.floorGuardUntil) return;

    if (msg?.type === 'events') {
      const signal = msg?.data?.signal_type;
      if (signal === 'START_SPEECH') {
        this.setStatus(s, 'listening');
        s.endSpeechSeen = false;     // a fresh utterance is starting
        this.clearEndTurnTimer(s);
      } else if (signal && /END/i.test(String(signal))) {
        // The patient stopped talking. If the transcript is already here, reply now;
        // otherwise mark it so the imminent transcript triggers the reply.
        s.endSpeechSeen = true;
        this.clearEndTurnTimer(s);
        if (s.utterance.trim()) this.finalizeUserTurn(sessionId);
      }
      return;
    }

    if (msg?.type === 'data') {
      const segment = String(msg?.data?.transcript || '').trim();
      if (!segment) return;
      if (segment !== s.lastSegment) {
        s.utterance = s.utterance ? `${s.utterance} ${segment}` : segment;
        s.lastSegment = segment;
      }
      if (s.endSpeechSeen) {
        // Patient already stopped (END_SPEECH seen) and now we have the words → reply now.
        this.finalizeUserTurn(sessionId);
      } else {
        // Transcript arrived before END_SPEECH (patient may still be talking). Wait for
        // END_SPEECH; arm only a safety net in case that signal never comes.
        this.scheduleFinalize(sessionId, NO_END_SIGNAL_FALLBACK_MS);
      }
    }
  }

  private clearEndTurnTimer(s: SarvamSession): void {
    if (s.endTurnTimer) { clearTimeout(s.endTurnTimer); s.endTurnTimer = null; }
  }

  private scheduleFinalize(sessionId: string, delay: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.clearEndTurnTimer(s);
    s.endTurnTimer = setTimeout(() => this.finalizeUserTurn(sessionId), delay);
  }

  /** The patient has stopped → commit their full utterance and run one agent turn. */
  private finalizeUserTurn(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;
    this.clearEndTurnTimer(s);
    const text = s.utterance.trim();
    s.utterance = '';
    s.lastSegment = '';
    s.endSpeechSeen = false;
    // Drop echo/noise blips: an ultra-short "utterance", or anything captured during the echo-settle
    // window right after the agent spoke, is almost certainly the agent's own tail — NOT a real
    // answer. Ignore it and leave the floor with the patient (don't clear the barge-in resume).
    if (text.length < MIN_UTTERANCE_CHARS || Date.now() < s.floorGuardUntil) {
      if (text) console.log(`🔇 Dropping echo/noise blip (${sessionId}): ${text.length} chars`);
      return;
    }
    this.clearResumeTimer(s);  // real speech arrived → no need to re-ask
    if (!text) return;

    // PHI: log length only, never the text.
    console.log(`🎙️ Patient turn (${sessionId}): ${text.length} chars`);
    s.endpointAt = Date.now();   // baseline for the sampled response gap (upgrade 4)
    // Update the detected emotional state from THEIR words (drives the EMPATHY PROTOCOL
    // header, the filler-audio set, and the escalation nudge).
    s.emotion.update(text);
    this.send(s, { type: 'patient_transcript', text });
    db.saveConversationLog({ session_id: sessionId, speaker: 'patient', message: text }).catch(() => {});

    // If a turn is somehow still in flight, hold this and run it after.
    if (s.status === 'thinking' || s.status === 'speaking') {
      s.pendingUserText = text;
      return;
    }
    s.messages.push({ role: 'user', content: text });
    this.runTurn(sessionId, { greeting: false }).catch(e => console.error('Turn error:', e?.message || e));
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Agent turn: chat completion (+ tools) ──▶ streamed TTS
  // ───────────────────────────────────────────────────────────────────────────────
  private async runTurn(sessionId: string, opts: { greeting: boolean }): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || s.ended) return;

    const turnId = ++s.turnId;          // claim this turn
    const isCurrent = () => !s.ended && s.turnId === turnId;
    this.clearResumeTimer(s);           // a real turn is starting → cancel any pending re-ask
    this.clearFillerTimer(s);
    s.turnAudioStarted = false;
    this.setStatus(s, 'thinking');

    const L = LANGS[s.lang];

    // Drive the intake plan. A non-greeting turn means the patient just answered the
    // CURRENT topic: capture the chief complaint (the answer to the MAIN-problem step),
    // save the answer (against the exact question that was asked), then advance.
    let completing = false;
    let emergency = false;
    if (opts.greeting) {
      s.questionIndex = 0;
    } else {
      const answered = s.plan[s.questionIndex];
      const lastUser = [...s.messages].reverse().find(m => m.role === 'user');
      const answerText = String(lastUser?.content || '').trim();
      const pid = s.config.patientId || 0;
      if (answered?.key === 'complaint' && answerText) s.chiefComplaint = answerText; // their main problem
      // Name is collected by voice only — write it onto the session record (dashboard) and the
      // persistent patient record (without overwriting a known name on a return visit).
      if (answered?.key === 'name' && answerText) {
        db.updateSessionPatientName(sessionId, answerText).catch(e => console.error('update patient name failed:', e?.message || e));
        if (pid) db.updatePatientNameIfEmpty(pid, answerText).catch(e => console.error('update patient name failed:', e?.message || e));
      }
      if (answered?.key === 'age' && answerText && pid) {
        // Patients answer by voice in their own language (e.g. Telugu "నా వయసు పద్దెనిమిది
        // సంవత్సరాలు"), so normalize to a plain English number ("18") before storing — that
        // way the age always displays in English everywhere (Sessions, Patients, reports).
        this.normalizeAge(s, answerText)
          .then(age => db.updatePatientAge(pid, age))
          .catch(e => console.error('update patient age failed:', e?.message || e));
      }
      if (answered && answerText) {
        db.createIntakeResponse({
          session_id: sessionId,
          question: s.lastQuestion || answered.example,  // the question actually asked
          answer: answerText,
          category: answered.category
        }).catch(e => console.error('save intake answer failed:', e?.message || e));
        // Accumulate clinical (non-demographic) answers for the patient's rolling history.
        if (answered.category !== 'demographics') {
          const label = answered.topic.split('—')[0].trim();
          s.visitNotes.push(`${label}: ${answerText}`);
        }
      }
      // SAFETY NET: escalate deterministically, never relying on the LLM tool call.
      if (detectEmergency(answerText)) {
        emergency = true;
        await this.fireRedFlag(s, sessionId, answerText, turnId, 'critical');
      }
      s.questionIndex++;
      completing = s.questionIndex >= s.plan.length;
    }

    try {
      let reply: string;
      let tone: ToneKey;

      if (emergency) {
        // RED FLAG: speak ONLY the fixed emergency reassurance (comforting tone), then STOP the
        // whole conversation — a doctor is being sent, so we don't continue the intake. No LLM call.
        reply = emergencyMessage(s.lang);
        tone = 'comforting';
        completing = true;             // terminal turn → end the session after this plays
      } else {
        // Pin exactly which question to ask now; the model may add only a tiny ack, and it
        // prefixes the reply with a hidden [tone:...] tag that drives the voice emotion.
        const note = this.intakeNote(s, { greeting: opts.greeting, completing });
        const callMessages: ChatMessage[] = [...s.messages, { role: 'system', content: note }];

        // Cover the LLM's thinking time with a short spoken acknowledgment ("ఊఁ...") if the
        // real reply's audio hasn't started within FILLER_DELAY_MS — no dead air, ever.
        // Not on the greeting (nothing preceded it) and never on an emergency turn.
        if (!opts.greeting) this.armFiller(s, turnId, isCurrent);

        const raw = await this.chat(s, sessionId, callMessages);
        if (!isCurrent()) return;        // interrupted while we were thinking

        if (s.lastEmergencyTurn === turnId) {
          // The LLM raised a red flag mid-turn (the keyword net missed it) → still stop the
          // conversation and speak the fixed emergency reassurance, same as the net path.
          reply = emergencyMessage(s.lang);
          tone = 'comforting';
          completing = true;
        } else {
          const ext = this.extractTone(raw);
          tone = ext.tone;
          reply = this.sanitizeForSpeech(ext.text);

          if (!reply) {
            // Never leave a turn silent — fall back to a fixed phrase in the session language.
            if (completing) {
              reply = L.closing;
            } else {
              const step = s.plan[Math.min(s.questionIndex, s.plan.length - 1)];
              reply = step?.key === 'visit_type' ? L.visitQ
                    : step?.key === 'name' ? L.nameQ
                    : step?.key === 'age' ? L.ageQ
                    : (step?.example || L.fallback);
            }
          }
          if (!completing) s.lastQuestion = reply; // remember the question we just asked
        }
      }

      // Robot-tell telemetry (VANI spec §6.3): log prompt regressions so they can be
      // caught in testing — over-long turns, double questions, stock phrases, repeated openers.
      if (!emergency) this.logRobotTells(s, reply, completing);

      s.messages.push({ role: 'assistant', content: reply });
      this.send(s, { type: 'agent_transcript', text: reply, responseId: turnId });
      db.saveConversationLog({ session_id: sessionId, speaker: 'agent', message: reply }).catch(() => {});

      // Remember a normal question so a false barge-in can re-ask it (not for the closing
      // line or an emergency message — those end the conversation, nothing to resume).
      if (!completing && !emergency) { s.lastAgentReply = reply; s.lastAgentTone = tone; }

      const replyWords = reply.split(/\s+/).filter(Boolean).length;
      // Breath layer (upgrade 3): a quiet inhale under the first word of longer replies.
      // Scheduled every turn (so cadence tracks) but never on the emergency line.
      s.pendingBreath = VANI_BREATHS && !emergency ? s.breaths.next(replyWords) : null;
      // Timing humanization (upgrade 4): if the pipeline was FASTER than a human would
      // be, hold the audio until a per-turn sampled gap has passed. Never delays a turn
      // that is already at/over target, so the ≤1.2 s latency budget is untouched.
      if (VANI_TIMING_JITTER && !opts.greeting && !emergency) {
        await this.humanGap(s, turnId, replyWords, isCurrent);
        if (!isCurrent()) return;
      }

      this.setStatus(s, 'speaking');
      await this.streamTts(s, reply, turnId, isCurrent, tone);

      // After the closing line OR the emergency message plays, end the session.
      if (completing && isCurrent()) {
        setTimeout(() => this.endSession(sessionId).catch(() => {}), 4000);
      }
    } catch (e: any) {
      console.error(`❌ Turn failed (${sessionId}):`, e?.message || e);
      if (isCurrent()) this.send(s, { type: 'error', message: 'Agent failed to respond.' });
    } finally {
      this.clearFillerTimer(s);
      if (isCurrent() && !completing) {
        this.giveFloorToPatient(s);  // listening + echo-settle guard + ensure STT is connected
        // Process a patient utterance that arrived mid-turn (rare with mic gating).
        if (s.pendingUserText && !s.ended) {
          const next = s.pendingUserText;
          s.pendingUserText = null;
          s.messages.push({ role: 'user', content: next });
          this.runTurn(sessionId, { greeting: false }).catch(e => console.error('Queued turn error:', e?.message || e));
        }
      }
    }
  }

  /** One raw chat completion, dispatched to the session's configured LLM engine. Both engines
   *  speak the OpenAI chat-completions shape (same messages + function tools), so only the
   *  client and a couple of engine-specific params differ. Returns the raw response object. */
  private async completeChat(s: SarvamSession, messages: ChatMessage[], toolChoice: 'auto' | 'none'): Promise<any> {
    const common = {
      temperature: INTAKE_TEMPERATURE, // low → deterministic, on-script
      max_tokens: 220,                 // a short empathetic sentence + one question; caps any runaway
      frequency_penalty: 0.6,
      presence_penalty: 0.3,
      messages: messages as any,
      tools: this.getFunctionTools(),
      tool_choice: toolChoice
    };
    if (s.llmEngine === 'openai') {
      // OpenAI gpt-4o-mini via the official SDK (.create), no reasoning_effort param.
      return this.getOpenAI().chat.completions.create({ model: OPENAI_LLM_MODEL, ...common } as any);
    }
    // Sarvam (sarvam-30b): reasoning disabled per-call for voice latency.
    return s.client.chat.completions({ model: CHAT_MODEL, reasoning_effort: null, ...common } as any);
  }

  /** One chat completion against the given (transient) message array; runs any tool
   *  calls, then returns the final spoken text. Tool/assistant scaffolding is pushed
   *  onto `messages` only, so the persistent history (s.messages) stays clean. */
  private async chat(s: SarvamSession, sessionId: string, messages: ChatMessage[]): Promise<string> {
    console.log(`🧠 chat (${sessionId}) engine=${s.llmEngine} q#${s.questionIndex + 1} ${messages.length} msgs`);
    const resp: any = await this.completeChat(s, messages, 'auto');
    this.recordUsage(s, resp?.usage);

    const message = resp?.choices?.[0]?.message;
    if (!message) return '';

    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls });
      let shouldEnd = false;
      for (const call of toolCalls) {
        const name = call?.function?.name;
        let args: any = {};
        try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { /* ignore */ }
        const result = await this.handleToolCall(sessionId, name, args);
        if (name === 'end_session' && this.shouldHonorEndSession(s, args)) shouldEnd = true;
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result) });
      }

      const followup: any = await this.completeChat(s, messages, 'none');
      this.recordUsage(s, followup?.usage);

      if (shouldEnd) setTimeout(() => this.endSession(sessionId).catch(() => {}), 6000);
      return followup?.choices?.[0]?.message?.content || '';
    }

    return message.content || '';
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Streaming TTS: a FRESH connection per utterance, audio forwarded chunk-by-chunk.
  // Resolves when the response finishes; retries once if it fails BEFORE any audio.
  // ───────────────────────────────────────────────────────────────────────────────
  private async streamTts(s: SarvamSession, text: string, turnId: number, isCurrent: () => boolean, tone: ToneKey = 'gentle'): Promise<void> {
    if (!text || s.ended) return;
    let engine = s.ttsEngine || 'sarvam';
    // Safety: if a language is configured for OpenAI but no key is set, fall back to Sarvam
    // so the patient still hears a voice (silent audio would be worse than a less-emotional one).
    if (engine === 'openai' && !process.env.OPENAI_API_KEY) {
      console.warn(`⚠️ TTS_ENGINE for ${s.lang} is 'openai' but OPENAI_API_KEY is unset — using Sarvam.`);
      engine = 'sarvam';
    }
    if (engine === 'elevenlabs' && (!process.env.ELEVENLABS_API_KEY || !ELEVENLABS_VOICE[s.lang])) {
      console.warn(`⚠️ TTS_ENGINE for ${s.lang} is 'elevenlabs' but ELEVENLABS_API_KEY / voice id is unset — using Sarvam.`);
      engine = 'sarvam';
    }
    text = this.normalizeForTts(text, s.lang);   // spoken-form hygiene (VANI spec §6.2)
    console.log(`🔊 TTS (${s.config.sessionId}) turn=${turnId} engine=${engine} lang=${s.lang} tone=${tone} ${text.length} chars`);

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!isCurrent()) return;
      try {
        if (engine === 'openai') await this.streamOpenAiTtsOnce(s, text, turnId, tone, isCurrent);
        else if (engine === 'elevenlabs') await this.streamElevenLabsTtsOnce(s, text, turnId, tone, isCurrent);
        else await this.streamSarvamTtsOnce(s, text, turnId, tone, isCurrent);
        if (isCurrent()) this.send(s, { type: 'agent_audio_end', responseId: turnId });
        return;
      } catch (e: any) {
        console.error(`❌ TTS attempt ${attempt} (${s.config.sessionId}, ${engine}):`, e?.message || e);
        if (attempt < 2) await new Promise(r => setTimeout(r, 300));
      }
    }
    // Both attempts failed before any audio — still close out the turn so the UI isn't stuck.
    if (isCurrent()) this.send(s, { type: 'agent_audio_end', responseId: turnId });
  }

  /** OpenAI expressive voice (gpt-4o-mini-tts) for en/hi: the tone steers the delivery via
   *  `instructions`. STREAMS PCM (24kHz, 16-bit mono) chunk-by-chunk as it is synthesised, so the
   *  browser starts playing the first words while the rest is still being generated — this is the
   *  main latency win over buffering the whole reply. Rejects BEFORE any audio so the caller retries. */
  private async streamOpenAiTtsOnce(
    s: SarvamSession, text: string, turnId: number, tone: ToneKey, isCurrent: () => boolean
  ): Promise<void> {
    const L = LANGS[s.lang];
    const p = toneProsody(tone);
    const instructions = [
      `You are a real, warm, caring human nurse gently speaking ${L.label} to a patient — one human being to another, NOT a robot, system or automated voice.`,
      `Sound genuinely alive and emotionally present: natural breaths, real human warmth, soft micro-pauses where a caring person would pause, and authentic feeling that rises and falls with the words. Let your intonation move naturally — never flat, never monotone, never read-aloud.`,
      `Speak unhurriedly and tenderly, like you truly care about this person. ${p.style}`,
      `Use a soft, intimate, conversational delivery in natural everyday spoken ${L.label}, with the gentle musicality of a real native speaker.`
    ].join(' ');
    const resp: any = await this.getOpenAI().audio.speech.create({
      model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE as any, input: text,
      instructions, response_format: 'pcm'
    });
    if (!isCurrent()) return;
    const body: any = resp?.body;
    if (!body || typeof body.getReader !== 'function') {
      // No streamable body — fall back to a single buffered send so audio still plays.
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 2) throw new Error('OpenAI TTS returned no audio');
      this.emitAudio(s, turnId, buf.toString('base64'), 0);
      return;
    }
    // Forward PCM16@24k chunks as they arrive. Carry a stray odd byte so we never split a sample.
    const reader = body.getReader();
    let seq = 0, gotAudio = false;
    let leftover = Buffer.alloc(0);
    try {
      while (true) {
        if (!isCurrent()) break;
        let chunk: { done: boolean; value: any };
        try {
          chunk = await reader.read();
        } catch (e) {
          // A mid-stream read error AFTER we've already sent audio must NOT bubble up — the caller
          // would retry and replay the whole reply (duplicate/overlapping voice). Stop cleanly
          // instead; only rethrow if nothing has played yet so a fresh attempt can run.
          if (gotAudio) break;
          throw e;
        }
        const { done, value } = chunk;
        if (done) break;
        if (value && value.length) {
          const buf = Buffer.concat([leftover, Buffer.from(value)]);
          const even = buf.length - (buf.length % 2);
          leftover = Buffer.from(buf.subarray(even));
          if (even > 0) {
            gotAudio = true;
            this.emitAudio(s, turnId, buf.subarray(0, even).toString('base64'), seq++);
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    if (!gotAudio) throw new Error('OpenAI TTS returned no audio');
  }

  /** ElevenLabs expressive voice (any language). Streams pcm_24000 (24kHz, 16-bit mono LE) — the
   *  exact format the browser player wants, so no resampling — forwarding chunks as they arrive.
   *  The tone maps to ElevenLabs voice_settings. Rejects BEFORE any audio so the caller can retry. */
  private async streamElevenLabsTtsOnce(
    s: SarvamSession, text: string, turnId: number, tone: ToneKey, isCurrent: () => boolean
  ): Promise<void> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required for the ElevenLabs voice.');
    const voiceId = ELEVENLABS_VOICE[s.lang];
    if (!voiceId) throw new Error(`No ElevenLabs voice id configured for ${s.lang}.`);

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`;
    const res: any = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/pcm' },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL, voice_settings: elevenVoiceSettings(tone) })
    });
    if (!res.ok || !res.body) {
      const detail = await res.text?.().catch(() => '') || '';
      throw new Error(`ElevenLabs TTS ${res.status}: ${String(detail).slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    let seq = 0, gotAudio = false;
    let leftover = Buffer.alloc(0);   // carry a stray odd byte so we never split a PCM16 sample
    try {
      while (true) {
        if (!isCurrent()) break;                       // interrupted / session ended
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          const buf = Buffer.concat([leftover, Buffer.from(value)]);
          const even = buf.length - (buf.length % 2);
          leftover = Buffer.from(buf.subarray(even));
          if (even > 0) {
            gotAudio = true;
            this.emitAudio(s, turnId, buf.subarray(0, even).toString('base64'), seq++);
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    if (!gotAudio) throw new Error('ElevenLabs returned no audio');
  }

  /** One Sarvam TTS connection (Telugu). Forwards each audio chunk as it arrives; the tone sets
   *  pace (v3) plus pitch/loudness (v2 only). Resolves on 'final'/idle; rejects only BEFORE any
   *  audio (so we retry). On v3 the emotion comes mainly from the WORDS — see the system prompt. */
  private streamSarvamTtsOnce(
    s: SarvamSession, text: string, turnId: number, tone: ToneKey, isCurrent: () => boolean
  ): Promise<void> {
    const speaker = this.resolveSpeaker(s);
    let ttsModel = ttsModelForSpeaker(speaker);
    // Opt-in expressive variation: v3 speakers can use bulbul:v3-beta + temperature.
    const useTemperature = TTS_TEMPERATURE != null && ttsModel === 'bulbul:v3';
    if (useTemperature) ttsModel = 'bulbul:v3-beta';
    const pr = toneProsody(tone);
    const apiKey = s.config.apiKey || process.env.SARVAM_API_KEY!;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let gotAudio = false;
      let seq = 0;
      let tts: any = null;
      let idleTimer: NodeJS.Timeout | null = null;
      let safetyTimer: NodeJS.Timeout | null = null;

      const clearTimers = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      };
      const done = () => { if (settled) return; settled = true; clearTimers(); try { tts?.close(); } catch {} resolve(); };
      const fail = (e: any) => { if (settled) return; settled = true; clearTimers(); try { tts?.close(); } catch {} reject(e); };

      (async () => {
        try {
          tts = await s.client.textToSpeechStreaming.connect({
            model: ttsModel, send_completion_event: 'true', 'Api-Subscription-Key': apiKey
          } as any);

          tts.on('message', (msg: any) => {
            if (!isCurrent()) return done();               // interrupted / session ended
            if (msg?.type === 'audio' && msg?.data?.audio) {
              gotAudio = true;
              this.emitAudio(s, turnId, msg.data.audio, seq++);
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(done, 2000);          // jitter fallback if 'final' never arrives
            } else if (msg?.type === 'event' && msg?.data?.event_type === 'final') {
              done();
            }
          });
          tts.on('error', (err: any) => {
            console.error(`❌ TTS stream error (${s.config.sessionId}):`, err?.message || err);
            if (gotAudio) done(); else fail(err);
          });
          tts.on('close', () => { if (settled) return; if (gotAudio) done(); else fail(new Error('TTS closed before audio')); });

          if (typeof tts.waitForOpen === 'function') await tts.waitForOpen();
          // Prosody variance (upgrade 2): wobble the tone's base pace ±0.03 per turn so the
          // melodic contour never loops; consecutive turns are guaranteed different values.
          const pace = VANI_PACE_JITTER ? s.paceJitter.jitter(pr.pace) : pr.pace;
          const ttsCfg: any = {
            target_language_code: s.lang, speaker, model: ttsModel,
            pace, pitch: pr.pitch, loudness: pr.loudness,            // pace drives v3; v2 also uses pitch/loudness
            enable_preprocessing: true,   // normalize numbers/mixed text → smoother, more natural speech
            output_audio_codec: 'linear16', speech_sample_rate: TTS_SAMPLE_RATE
          };
          if (useTemperature) ttsCfg.temperature = TTS_TEMPERATURE;
          tts.configureConnection(ttsCfg);
          tts.convert(text);
          tts.flush();

          safetyTimer = setTimeout(done, 20000);           // hard cap so a turn always completes
        } catch (e) {
          if (gotAudio) done(); else fail(e);
        }
      })();
    });
  }

  /** Timing humanization (upgrade 4): wait out the remainder of a per-turn sampled
   *  response gap. Short confirmations get 350–550 ms targets, normal turns 450–800 ms;
   *  values come from a clamped normal distribution and never repeat exactly. Only the
   *  SHORTFALL is waited — a turn already slower than target starts immediately. */
  private async humanGap(s: SarvamSession, turnId: number, replyWords: number, isCurrent: () => boolean): Promise<void> {
    if (!s.endpointAt) return;
    const kind = replyWords <= 4 ? 'short' : 'normal';
    const target = s.gapSampler.sample(kind);
    const elapsed = Date.now() - s.endpointAt;
    const wait = target - elapsed;
    // Latency waterfall entry — verify the variance exists straight from the logs.
    console.log(`⏱️ Gap (${s.config.sessionId}) turn=${turnId} kind=${kind} target=${target}ms elapsed=${elapsed}ms wait=${Math.max(0, wait)}ms`);
    if (wait > 0 && isCurrent()) await new Promise(r => setTimeout(r, wait));
  }

  /** Send one chunk of this turn's speech audio, prepending the scheduled breath (if
   *  any) before the very first chunk so the inhale sits gaplessly under the first
   *  word. All TTS engines route their chunks through here. */
  private emitAudio(s: SarvamSession, turnId: number, base64: string, seq: number): void {
    if (!s.turnAudioStarted && s.pendingBreath) {
      this.send(s, { type: 'agent_audio', audio: s.pendingBreath.toString('base64'), responseId: turnId, seq: -1 });
      s.pendingBreath = null;
    }
    s.turnAudioStarted = true;
    this.send(s, { type: 'agent_audio', audio: base64, responseId: turnId, seq });
  }

  /** Resolve the Sarvam TTS voice: per-language env override (A/B) → DB/Settings → default. */
  private resolveSpeaker(s: SarvamSession): string {
    return TTS_SPEAKER_OVERRIDE[s.lang] || (s.config.voice && String(s.config.voice).trim()) || DEFAULT_TTS_SPEAKER;
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Filler audio (VANI spec §7.3): pre-generated acknowledgment clips in the session's
  // own voice, played when the real reply's audio hasn't started FILLER_DELAY_MS after
  // the patient stops talking — so the agent never goes dead-silent while it "thinks".
  // ───────────────────────────────────────────────────────────────────────────────
  private clearFillerTimer(s: SarvamSession): void {
    if (s.fillerTimer) { clearTimeout(s.fillerTimer); s.fillerTimer = null; }
  }

  /** Which engine synthesises fillers for this session — always the SAME engine that
   *  speaks the replies, so the filler is in the agent's own voice (this is what makes
   *  a cloned ElevenLabs voice keep the no-dead-air trick too). */
  private fillerEngine(s: SarvamSession): TtsEngine | null {
    let e: TtsEngine = s.ttsEngine || 'sarvam';
    if (e === 'openai' && !process.env.OPENAI_API_KEY) e = 'sarvam';
    if (e === 'elevenlabs' && (!process.env.ELEVENLABS_API_KEY || !ELEVENLABS_VOICE[s.lang])) e = 'sarvam';
    if (e === 'sarvam' && !(s.config.apiKey || process.env.SARVAM_API_KEY)) return null;
    return e;
  }

  /** The cache key voice for this session's fillers, per engine. */
  private fillerVoice(s: SarvamSession, engine: TtsEngine): string {
    if (engine === 'sarvam') return this.resolveSpeaker(s);
    if (engine === 'elevenlabs') return ELEVENLABS_VOICE[s.lang];
    return OPENAI_TTS_VOICE;
  }

  /** Arm the per-turn filler timer: if the real reply's first audio chunk hasn't been sent
   *  when it fires, play one short emotion-matched clip (never the same as the last two).
   *  The real reply then queues gaplessly behind it in the browser player. */
  private armFiller(s: SarvamSession, turnId: number, isCurrent: () => boolean): void {
    if (!FILLERS_ENABLED) return;
    const engine = this.fillerEngine(s);
    if (!engine) return;
    this.clearFillerTimer(s);
    s.fillerTimer = setTimeout(() => {
      s.fillerTimer = null;
      if (!isCurrent() || s.turnAudioStarted) return;
      const voice = this.fillerVoice(s, engine);
      const clip = fillerLibrary.pick(engine, s.lang, voice, s.emotion.fillerSet(), s.recentFillers);
      if (!clip) return;   // library still pre-warming → this turn just has no filler
      s.recentFillers = [...s.recentFillers.slice(-1), clip.text];
      console.log(`💬 Filler (${s.config.sessionId}) turn=${turnId} set=${s.emotion.fillerSet()}`);
      this.send(s, { type: 'agent_audio', audio: clip.audio.toString('base64'), responseId: turnId, seq: 0 });
    }, FILLER_DELAY_MS);
  }

  /** Synthesise any missing filler clips for this session's voice into the process-wide
   *  library, in the background. Starts after a short delay (the greeting's own TTS goes
   *  first) and paces itself so it never competes with live turns for the TTS API. */
  private prewarmFillers(s: SarvamSession): void {
    const engine = this.fillerEngine(s);
    if (!engine) return;
    const voice = this.fillerVoice(s, engine);
    const missing = allFillerTexts(s.lang).filter(t => !fillerLibrary.has(engine, s.lang, voice, t));
    if (missing.length === 0) return;
    void (async () => {
      await new Promise(r => setTimeout(r, 3000));
      for (const text of missing) {
        if (s.ended) return;   // a later session will resume where this one left off
        try {
          const audio = engine === 'sarvam' ? await this.synthesizeSarvamClip(s, text)
                      : engine === 'elevenlabs' ? await this.synthesizeElevenLabsClip(s, text)
                      : await this.synthesizeOpenAiClip(s, text);
          if (audio.length > 0) fillerLibrary.put(engine, s.lang, voice, text, audio);
        } catch (e: any) {
          console.warn(`⚠️ Filler pre-gen failed (${s.lang}/${engine}):`, e?.message || e);
        }
        await new Promise(r => setTimeout(r, 250));
      }
      console.log(`💬 Filler library ready (${s.lang}/${engine}/${voice})`);
    })();
  }

  /** One short clip via Sarvam streaming TTS, collected into a PCM16@24k buffer (same
   *  format the live turns stream, so the browser player needs no special casing). */
  private synthesizeSarvamClip(s: SarvamSession, text: string): Promise<Buffer> {
    const speaker = this.resolveSpeaker(s);
    const ttsModel = ttsModelForSpeaker(speaker);
    const apiKey = s.config.apiKey || process.env.SARVAM_API_KEY!;
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let tts: any = null;
      let idleTimer: NodeJS.Timeout | null = null;
      let safetyTimer: NodeJS.Timeout | null = null;
      const clearTimers = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      };
      const done = () => {
        if (settled) return; settled = true; clearTimers(); try { tts?.close(); } catch {}
        if (chunks.length) resolve(Buffer.concat(chunks)); else reject(new Error('TTS returned no audio'));
      };
      const fail = (e: any) => { if (settled) return; settled = true; clearTimers(); try { tts?.close(); } catch {} reject(e); };
      (async () => {
        try {
          tts = await s.client.textToSpeechStreaming.connect({
            model: ttsModel, send_completion_event: 'true', 'Api-Subscription-Key': apiKey
          } as any);
          tts.on('message', (msg: any) => {
            if (msg?.type === 'audio' && msg?.data?.audio) {
              chunks.push(Buffer.from(String(msg.data.audio), 'base64'));
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(done, 1500);
            } else if (msg?.type === 'event' && msg?.data?.event_type === 'final') {
              done();
            }
          });
          tts.on('error', (err: any) => fail(err));
          tts.on('close', () => done());
          if (typeof tts.waitForOpen === 'function') await tts.waitForOpen();
          tts.configureConnection({
            target_language_code: s.lang, speaker, model: ttsModel,
            pace: 0.9, pitch: -0.03, loudness: 1.0,   // the gentle default delivery
            enable_preprocessing: true, output_audio_codec: 'linear16', speech_sample_rate: TTS_SAMPLE_RATE
          });
          tts.convert(text);
          tts.flush();
          safetyTimer = setTimeout(done, 12000);
        } catch (e) { fail(e); }
      })();
    });
  }

  /** One short clip via ElevenLabs (buffered pcm_24000 — pre-warm has no latency
   *  pressure). Used when the session speaks with an ElevenLabs voice (e.g. a clone),
   *  so the fillers are that same voice. */
  private async synthesizeElevenLabsClip(s: SarvamSession, text: string): Promise<Buffer> {
    const apiKey = process.env.ELEVENLABS_API_KEY!;
    const voiceId = ELEVENLABS_VOICE[s.lang];
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_24000`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL, voice_settings: elevenVoiceSettings('gentle') })
    });
    if (!res.ok) throw new Error(`ElevenLabs clip ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, buf.length - (buf.length % 2));
  }

  /** One short clip via OpenAI TTS (buffered — pre-warm has no latency pressure). */
  private async synthesizeOpenAiClip(s: SarvamSession, text: string): Promise<Buffer> {
    const L = LANGS[s.lang];
    const resp: any = await this.getOpenAI().audio.speech.create({
      model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE as any, input: text,
      instructions: `A warm, caring ${L.label}-speaking nurse softly acknowledging a patient while she thinks — very short, gentle, natural, trailing off.`,
      response_format: 'pcm'
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.subarray(0, buf.length - (buf.length % 2));
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // Text hygiene: strip markdown / labels, collapse runaway repetition
  // ───────────────────────────────────────────────────────────────────────────────
  private sanitizeForSpeech(text: string): string {
    if (!text) return '';
    let t = text
      // Strip a LEAKED tool/function call the model sometimes writes as plain TEXT instead of a
      // proper structured call, e.g. `functions.endsession({ consent_given: true, reason: "..." })`
      // or a bare `end_session({...})` — otherwise it gets spoken/shown in the closing line.
      .replace(/\bfunctions?\s*\.\s*\w+\s*\([\s\S]*?\)\s*;?/gi, '')
      .replace(/\b(?:end[_\s]?session|red[_\s]?flag[_\s]?detected)\s*\([\s\S]*?\)\s*;?/gi, '')
      .replace(/<\/?function[^>]*>/gi, '')          // stray <function=...> / </function> tags
      .replace(/[*_#`>]/g, '')
      .replace(/^\s*[\wఅ-౯ఀ-౿\s]{0,25}:\s*/, '')   // a short leading "Name:" label
      .replace(/\n{2,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return this.collapseRepetition(t);
  }

  private collapseRepetition(text: string): string {
    const words = text.split(' ').filter(Boolean);
    const dedup: string[] = [];
    for (const w of words) {
      if (dedup.length && dedup[dedup.length - 1] === w) continue; // drop consecutive repeats
      dedup.push(w);
    }
    const counts: Record<string, number> = {};
    let cut = dedup.length;
    for (let i = 0; i < dedup.length; i++) {
      const w = dedup[i];
      counts[w] = (counts[w] || 0) + 1;
      if (w.length >= 2 && counts[w] > 5) { cut = i; break; }     // non-consecutive loop
    }
    let result = dedup.slice(0, cut);
    if (result.length > 60) result = result.slice(0, 60);          // hard cap
    return result.join(' ').trim();
  }

  /** Spoken-form normalization just before TTS (VANI spec §6.2) — defence in depth on top
   *  of Bulbul's enable_preprocessing: unify ellipses (they shape the pauses), expand
   *  currency into the spoken word, split 10-digit phone numbers into speakable groups. */
  private normalizeForTts(text: string, lang: Lang): string {
    const rupeeWord = lang === 'te-IN' ? 'రూపాయలు' : lang === 'hi-IN' ? 'रुपये' : 'rupees';
    return String(text || '')
      .replace(/…/g, '...')
      .replace(/\.{4,}/g, '...')
      .replace(/(?:Rs\.?|₹)\s*([\d,]+)/gi, `$1 ${rupeeWord}`)
      .replace(/\b(\d{5})(\d{5})\b/g, '$1... $2')   // 10-digit number → two spoken groups with a beat
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Robot-tell detector (VANI spec §6.3) — log-only telemetry. Each hit is a prompt
   *  regression worth fixing: the goal in testing is ZERO hits. Never logs patient words. */
  private logRobotTells(s: SarvamSession, reply: string, completing: boolean): void {
    const tells: string[] = [];
    const sentences = reply.split(/[.?!।]+/).map(x => x.trim()).filter(x => x.length > 1);
    if (!completing && sentences.length > 2) tells.push(`over 2 sentences (${sentences.length})`);
    const questions = (reply.match(/\?/g) || []).length;
    if (questions > 1) tells.push(`${questions} questions in one turn`);
    if (/[*_#•\[\]]/.test(reply)) tells.push('markdown/list characters');
    const STOCK = [
      /I understand your (frustration|concern)/i,
      /Is there anything else I can help/i,
      /మీ సమస్యను అర్థం చేసుకున్నాను/,
      /आपकी समस्या समझ (गई|गया)/,
      /as an AI/i
    ];
    if (STOCK.some(re => re.test(reply))) tells.push('stock phrase');
    const opening = (reply.split(/\s+/)[0] || '').replace(/[^\p{L}\p{N}]/gu, '');
    if (opening && opening === s.lastReplyOpening) tells.push('same opener as previous turn');
    s.lastReplyOpening = opening;
    // Flat rhythm (upgrade 2): three consecutive replies whose word counts sit within
    // ±2 of each other — the melody loop the RHYTHM RULE exists to prevent.
    const words = reply.split(/\s+/).filter(Boolean).length;
    s.replyWordCounts = [...s.replyWordCounts.slice(-2), words];
    if (s.replyWordCounts.length === 3
        && Math.max(...s.replyWordCounts) - Math.min(...s.replyWordCounts) <= 2) {
      tells.push(`flat rhythm (3 replies of ${s.replyWordCounts.join('/')} words)`);
    }
    // Disfluency budget (upgrade 5): self-corrections are allowed once per call, never
    // twice in one reply — more than that flips from "human" to "broken".
    const corrections = countSelfCorrections(reply);
    if (corrections >= 2) tells.push('stacked imperfections in one reply');
    s.disfluencyCount += corrections;
    if (corrections > 0 && s.disfluencyCount > 1) tells.push(`over disfluency budget (${s.disfluencyCount} self-corrections this call, max 1)`);
    if (tells.length) console.warn(`🤖 Robot tell (${s.config.sessionId}): ${tells.join('; ')}`);
  }

  private recordUsage(s: SarvamSession, usage: any): void {
    if (!usage) return;
    s.promptTokens += Number(usage.prompt_tokens || 0);
    s.completionTokens += Number(usage.completion_tokens || 0);
  }

  /** Turn a spoken age answer (any language) into a plain English number string, e.g.
   *  "నా వయసు పద్దెనిమిది సంవత్సరాలు" → "18", "thirty five years" → "35". Tries cheap digit
   *  extraction first (incl. Telugu/Devanagari numerals); for word-form ages it asks the LLM.
   *  Falls back to the original text if no sensible age can be found. */
  private async normalizeAge(s: SarvamSession, text: string): Promise<string> {
    const raw = String(text || '').trim();
    if (!raw) return raw;
    const digits = digitsToAscii(raw).match(/\d{1,3}/);
    if (digits) { const n = parseInt(digits[0], 10); if (n > 0 && n < 120) return String(n); }
    try {
      const resp: any = await s.client.chat.completions({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: 'Extract the person\'s age in years from the message and reply with ONLY the number in plain digits (e.g. 35). If there is no clear age, reply NA.' },
          { role: 'user', content: raw.slice(0, 160) }
        ] as any,
        temperature: 0, max_tokens: 5, reasoning_effort: null
      } as any);
      const out = String(resp?.choices?.[0]?.message?.content || '');
      const m = digitsToAscii(out).match(/\d{1,3}/);
      if (m) { const n = parseInt(m[0], 10); if (n > 0 && n < 120) return String(n); }
    } catch (e: any) {
      console.error('age normalize failed:', e?.message || e);
    }
    return raw; // unparseable → keep what they said rather than lose it
  }

  /** Raise a red-flag alert (DB + frontend), de-duped so the deterministic safety net
   *  and the LLM's own tool call can't double-fire within the same turn. */
  private async fireRedFlag(
    s: SarvamSession, sessionId: string, symptoms: string, turnId: number, severity = 'critical'
  ): Promise<void> {
    if (s.lastEmergencyTurn === turnId) return;     // already alerted this turn
    s.lastEmergencyTurn = turnId;
    s.redFlags++;
    this.clearFillerTimer(s);   // never play a casual "hmm/okay" clip before the emergency line
    const text = (symptoms || 'critical symptom').slice(0, 200);
    try {
      await db.saveRedFlagEvent({
        session_id: sessionId, symptoms: text, severity,
        resolved: false, clinician_notified: true
      });
      await db.updateSessionRedFlagCount(sessionId).catch(() => {});
    } catch (e: any) {
      console.error(`red flag save failed (${sessionId}):`, e?.message || e);
    }
    console.log(`🚨 RED FLAG (${sessionId}) [${severity}] ${text}`);
    this.send(s, { type: 'red_flag', symptoms: text, severity });
  }

  /** Decide whether to actually END the session on an LLM `end_session` tool call. The backend
   *  drives real completion deterministically by the intake plan, so the tool is only for a
   *  genuine patient-initiated stop or when the interview is essentially done. This guards against
   *  weaker models (e.g. gpt-4o-mini) that prematurely fire end_session mid-interview. */
  private shouldHonorEndSession(s: SarvamSession, args: any): boolean {
    const reason = String(args?.reason || '').toLowerCase();
    const nearComplete = s.questionIndex >= s.plan.length - 1;
    if (reason === 'patient_request' || reason === 'patient_uncomfortable' || nearComplete) return true;
    console.warn(`⚠️ Ignoring premature end_session (reason="${reason}", q#${s.questionIndex + 1}/${s.plan.length})`);
    return false;
  }

  private async handleToolCall(sessionId: string, name: string, args: any): Promise<any> {
    try {
      switch (name) {
        case 'red_flag_detected': {
          const symptoms = Array.isArray(args.symptoms) ? args.symptoms.join(', ') : String(args.symptoms || '');
          const s = this.sessions.get(sessionId);
          if (s) await this.fireRedFlag(s, sessionId, symptoms, s.turnId, String(args.severity || 'critical'));
          return { ok: true, alerted: true };
        }

        case 'end_session':
          return { ok: true, ending: true };

        default:
          return { ok: false, error: 'unknown tool' };
      }
    } catch (e: any) {
      console.error(`Tool ${name} failed (${sessionId}):`, e?.message || e);
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // ───────────────────────────────────────────────────────────────────────────────
  private setStatus(s: SarvamSession, state: AgentStatus): void {
    if (s.status === state) return;
    s.status = state;
    this.send(s, { type: 'status', state });
  }

  /** Natural hand-off of the floor to the patient after the agent finishes speaking. Adds an
   *  echo-settle guard (so the agent's own audio tail isn't transcribed as a tiny fake turn) and
   *  proactively (re)opens the Sarvam STT socket (it idle-closes during long agent turns, which
   *  otherwise drops the patient's first words). Use this instead of setStatus('listening') on a
   *  NORMAL turn end — NOT for a barge-in, where the patient's pre-roll must go through immediately. */
  private giveFloorToPatient(s: SarvamSession): void {
    s.floorGuardUntil = Date.now() + FLOOR_SETTLE_MS;
    if (s.sttEngine === 'sarvam') this.ensureStt(s).catch(() => {});
    this.setStatus(s, 'listening');
  }

  private send(s: SarvamSession, payload: any): void {
    const ws = s.frontendWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
    }
  }
}

export default SarvamProvider;
