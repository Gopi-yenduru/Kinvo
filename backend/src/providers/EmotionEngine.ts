import { Lang } from '../emergency.js';

/**
 * EmotionEngine — lexical emotion detection + per-call emotional state machine.
 * =====================================================================================
 * Implements the "empathy engine" from the Project VANI naturalness spec (Section 5):
 * every patient utterance is scanned for emotion-bearing tokens (Telugu / Hindi /
 * English), scored into one of a few coarse states, and kept in a per-call state
 * machine that DECAYS instead of resetting — a patient who was distressed 30 seconds
 * ago is still tender even if their last sentence was neutral.
 *
 * The state is exposed two ways:
 *   • header()    — the invisible control header the LLM sees before each turn
 *                   ("[EMOTION: WORRIED | INTENSITY: 2 | TREND: rising]"), which drives
 *                   the wording via the EMPATHY PROTOCOL in the system prompt.
 *   • fillerSet() — which pre-generated filler-audio set matches the moment, so the
 *                   "thinking" acknowledgment sound matches the feeling too.
 *
 * Detection is pure regex + counting: deterministic, unit-testable, ~0 ms per turn.
 * No models, no network — exactly what the spec prescribes for v1.
 */

export type EmotionName = 'NEUTRAL' | 'FRUSTRATED' | 'WORRIED' | 'CONFUSED' | 'HAPPY';
export type EmotionTrend = 'rising' | 'steady' | 'cooling';
export type FillerSet = 'standard' | 'calm' | 'soft' | 'patient' | 'bright';

type LexEntry = { re: RegExp; weight: number };

// Seed lexicon, weights 1–3. One combined detector serves every session language, since
// Sarvam STT freely mixes scripts (English medical words inside Telugu/Hindi speech).
const LEXICON: Record<Exclude<EmotionName, 'NEUTRAL'>, LexEntry[]> = {
  FRUSTRATED: [
    // Telugu
    { re: /విసుగు|చిరాకు/, weight: 2 },
    { re: /ఎన్ని ?సార్లు|మళ్ళీ ?మళ్ళీ|మల్లీ ?మల్లీ/, weight: 2 },   // "how many times / again and again"
    { re: /చెప్పాను ?కదా|అడిగారు ?కదా/, weight: 2 },                 // "I already told you"
    { re: /ఇంకా ?ఎంత ?సేపు/, weight: 2 },                            // "how much longer"
    // Hindi
    { re: /कितनी ?बार|बार ?बार|फिर ?से ?वही/, weight: 2 },
    { re: /बता ?(चुका|चुकी)|कब ?तक|अभी ?तक/, weight: 2 },
    // English
    { re: /how many times|already told|again and again|still (not|waiting)/i, weight: 2 },
    { re: /\b(waste|worst|ridiculous|useless|frustrat\w*|annoy\w*)\b/i, weight: 2 },
    { re: /\bcomplaint\b/i, weight: 1 },
  ],
  WORRIED: [
    // Telugu — fear / anxiety / severe pain / sadness
    { re: /భయం|భయపడ|ఆందోళన|కంగారు|టెన్షన్/, weight: 2 },
    { re: /(చాలా|విపరీత\w*|ఎక్కువ)\s*(నొప్పి|బాధ)/, weight: 2 },
    { re: /(నొప్పి|బాధ)\s*(చాలా|ఎక్కువ|తట్టుకోలే)/, weight: 2 },
    { re: /తట్టుకోలే|ఓర్చుకోలే/, weight: 3 },                        // "can't bear it"
    { re: /ఏడుపు|ఏడుస్తు|కన్నీ(ళ్ళు|ళ్లు)/, weight: 3 },
    { re: /నిద్ర ?(పట్టడం ?లేదు|రావడం ?లేదు|లేదు)/, weight: 2 },
    { re: /దిగులు|బెంగ|బాధగా ?ఉంది/, weight: 2 },
    // Hindi
    { re: /डर|घबराहट|घबरा|चिंता|टेंशन|परेशान/, weight: 2 },
    { re: /(बहुत|ज़्यादा|ज्यादा)\s*(दर्द|तकलीफ)/, weight: 2 },
    { re: /बर्दाश्त ?नहीं|सहा ?नहीं ?जाता/, weight: 3 },
    { re: /नींद ?नहीं|रो ?(रहा|रही)/, weight: 2 },
    // English
    { re: /\b(scared|afraid|worried|anxious|nervous|tension)\b/i, weight: 2 },
    { re: /(too much|very bad|severe|unbearable|terrible).{0,12}pain|pain.{0,12}(too much|unbearable|very bad|severe)/i, weight: 2 },
    { re: /can'?t (sleep|bear|take it)|crying/i, weight: 2 },
    { re: /\burgent\b/i, weight: 1 },
  ],
  CONFUSED: [
    // Telugu
    { re: /అర్థం ?(కాలేదు|కావడం ?లేదు|అవ్వలేదు)/, weight: 3 },
    { re: /అంటే ?ఏంటి|ఏం ?అడుగుతున్నారు/, weight: 2 },
    { re: /మళ్ళీ ?చెప్పండి|మల్లీ ?చెప్పండి|ఇంకోసారి ?చెప్పండి/, weight: 2 },
    { re: /ఎలా ?చెప్పాలో ?తెలియ/, weight: 2 },
    // Hindi
    { re: /समझ ?(नहीं|में ?नहीं)/, weight: 3 },
    { re: /मतलब ?क्या|क्या ?पूछ ?रह/, weight: 2 },
    { re: /फिर ?से ?(बताइए|बोलिए)|दोबारा ?बताइए/, weight: 2 },
    // English
    { re: /(don'?t|didn'?t|do not) (understand|get it|follow)/i, weight: 3 },
    { re: /what do you mean|which one|confus\w*|repeat that|say (that|it) again/i, weight: 2 },
  ],
  HAPPY: [
    // Telugu — relief / improvement
    { re: /తగ్గింది|నయం ?అయ(్యింది|ింది)|బెటర్/, weight: 2 },
    { re: /బాగుంది|చాలా ?మంచి|హాయిగా/, weight: 2 },
    // Hindi
    { re: /आराम ?(है|मिला)|ठीक ?हो ?गया|बेहतर/, weight: 2 },
    { re: /अच्छा ?लग ?रहा|बहुत ?अच्छा/, weight: 2 },
    // English
    { re: /much better|feeling (better|good|great)|improved|relief|recovered/i, weight: 2 },
    { re: /thank you so much|\b(super|great|wonderful)\b/i, weight: 1 },
  ],
};

// A same-word repeated 3+ times in one utterance ("నొప్పి నొప్పి నొప్పి") reads as agitation.
const repetitionSignal = (text: string): boolean => {
  const counts: Record<string, number> = {};
  for (const w of text.split(/\s+/)) {
    if (w.length < 3) continue;
    counts[w] = (counts[w] || 0) + 1;
    if (counts[w] >= 3) return true;
  }
  return false;
};

const THRESHOLD = 2;   // min score to enter/refresh an emotional state
const STEP = 2;        // score-to-intensity: intensity = 1 + floor(score/STEP), capped at 3

export class EmotionEngine {
  emotion: EmotionName = 'NEUTRAL';
  intensity = 0;                       // 0 (neutral) … 3
  trend: EmotionTrend = 'steady';
  bargeIns = 0;                        // voice talk-overs this call (strong frustration signal)
  private calmTurns = 0;
  private escalationFlagged = false;

  /** Score one finalized patient utterance and update the state machine. */
  update(text: string): void {
    const t = String(text || '');
    const scores: Record<string, number> = { FRUSTRATED: 0, WORRIED: 0, CONFUSED: 0, HAPPY: 0 };
    for (const [emotion, entries] of Object.entries(LEXICON)) {
      for (const { re, weight } of entries) if (re.test(t)) scores[emotion] += weight;
    }
    if (repetitionSignal(t)) scores.FRUSTRATED += 1;

    let top: EmotionName = 'NEUTRAL';
    let val = 0;
    for (const [emotion, score] of Object.entries(scores)) {
      if (score > val) { top = emotion as EmotionName; val = score; }
    }

    if (val >= THRESHOLD) {
      const newIntensity = Math.min(3, 1 + Math.floor(val / STEP));
      this.trend = (top === this.emotion && newIntensity > this.intensity) || (top !== this.emotion && newIntensity >= 2)
        ? 'rising' : 'steady';
      this.emotion = top;
      this.intensity = newIntensity;
      this.calmTurns = 0;
      return;
    }

    // Calm turn: decay one intensity level per 2 calm turns instead of resetting — the
    // patient is still tender right after a distressed moment.
    this.calmTurns++;
    if (this.calmTurns >= 2 && this.intensity > 0) {
      this.intensity--;
      this.calmTurns = 0;
      this.trend = 'cooling';
      if (this.intensity === 0) { this.emotion = 'NEUTRAL'; this.trend = 'steady'; }
    }
  }

  /** A real voice talk-over happened (feeds the frustration signal per the spec). */
  recordBargeIn(): void { this.bargeIns++; }

  /** The invisible control header injected before each LLM turn. */
  header(): string {
    return `[EMOTION: ${this.emotion} | INTENSITY: ${this.intensity} | TREND: ${this.trend}]`;
  }

  /** Which pre-generated filler-audio set matches this moment. */
  fillerSet(): FillerSet {
    switch (this.emotion) {
      case 'FRUSTRATED': return 'calm';
      case 'WORRIED':    return 'soft';
      case 'CONFUSED':   return 'patient';
      case 'HAPPY':      return 'bright';
      default:           return 'standard';
    }
  }

  get escalationRecommended(): boolean {
    return (this.emotion === 'FRUSTRATED' && this.intensity >= 3) || this.bargeIns >= 3;
  }

  /** True exactly once — the first turn escalation becomes recommended — so the caller
   *  can log/annotate without repeating itself every turn. */
  shouldFlagEscalation(): boolean {
    if (this.escalationFlagged || !this.escalationRecommended) return false;
    this.escalationFlagged = true;
    return true;
  }
}

export type { Lang };
