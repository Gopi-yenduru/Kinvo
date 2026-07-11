/**
 * Humanize — timing, prosody and breath utilities that kill the "metronome" tells.
 * =====================================================================================
 * VANI humanization upgrades 2–4, adapted to this repo's browser pipeline. Pure,
 * dependency-free, unit-testable helpers; the SarvamProvider wires them per turn and
 * every one of them sits behind an env flag (see .env.example) so each can be A/B'd
 * independently.
 *
 *  • GapSampler     — the agent never replies after the exact same pause twice.
 *                     Humans take 350–800 ms to start talking, and the delay varies
 *                     with what they're about to say (quick "సరే" vs a real answer).
 *  • PaceJitter     — no two consecutive TTS requests use an identical pace value,
 *                     so the melody never loops even when the tone stays the same.
 *  • BreathScheduler— a quiet ~200 ms inhale before longer replies (max one per two
 *                     turns, three rotating variants), procedurally generated shaped
 *                     noise at −30 dBFS peak: felt more than heard.
 */

// ── Gaussian sampling (Box–Muller) ────────────────────────────────────────────────
const gaussian = (mean: number, sd: number): number => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type GapKind = 'short' | 'normal';

/** Response-gap sampler: how long after the patient stops should the agent's voice
 *  begin. Sampled from a clamped normal distribution per turn kind; never returns the
 *  same value twice in a row (a fixed gap is the #1 metronome tell). The provider only
 *  WAITS when the pipeline was faster than the target — it never slows a turn that is
 *  already at or over the target, so the spec's ≤1.2 s budget is untouched. */
export class GapSampler {
  private last = -1;

  static readonly RANGES: Record<GapKind, { lo: number; hi: number; mean: number; sd: number }> = {
    short:  { lo: 350, hi: 550, mean: 450, sd: 60 },   // quick confirmations, 2–4 word replies
    normal: { lo: 450, hi: 800, mean: 600, sd: 90 },   // regular conversational turns
  };

  sample(kind: GapKind): number {
    const r = GapSampler.RANGES[kind];
    let v = Math.round(clamp(gaussian(r.mean, r.sd), r.lo, r.hi));
    if (v === this.last) v = v + (v >= r.hi ? -17 : 17);  // nudge off an exact repeat
    this.last = v;
    return v;
  }
}

/** Per-turn pace jitter for Sarvam TTS: base(tone) ± uniform(0.03), 3 decimals, never
 *  the same value twice in a row. Bulbul repeats its melodic contour when pace is
 *  constant; a few-percent wobble per turn breaks the loop without sounding drunk. */
export class PaceJitter {
  private last = -1;

  jitter(base: number): number {
    for (let attempt = 0; attempt < 4; attempt++) {
      const v = Math.round((base + (Math.random() * 2 - 1) * 0.03) * 1000) / 1000;
      if (v !== this.last) { this.last = v; return v; }
    }
    const v = Math.round((base + 0.031) * 1000) / 1000;  // deterministic escape hatch
    this.last = v;
    return v;
  }
}

/** Self-correction cues in a reply ("... sorry," / "... అదే" / "... I mean") — the
 *  controlled-disfluency budget (upgrade 5) allows at most ONE per call and never two
 *  in one reply; the provider's robot-tell telemetry warns past those limits. */
export const countSelfCorrections = (reply: string): number =>
  (String(reply || '').match(/\.\.\.\s*(sorry|అదే|కాదు,|मतलब|I mean)/gi) || []).length;

// ── Breath layer ──────────────────────────────────────────────────────────────────
const BREATH_SAMPLE_RATE = 24000;          // matches the pipeline's TTS output
const BREATH_PEAK = 0.0316;                // −30 dBFS

/** One procedurally generated inhale: band-shaped noise under a smooth rise-and-release
 *  envelope. Not a perfect human breath, but at −30 dBFS under the first word it reads
 *  as "a person drew breath", not as a hiss. Replace with real recordings any time by
 *  swapping the buffers passed to BreathScheduler. */
export const generateBreath = (durationMs: number, seedBrightness: number): Buffer => {
  const n = Math.round((durationMs / 1000) * BREATH_SAMPLE_RATE);
  const out = Buffer.alloc(n * 2);
  // Two cascaded one-pole low-passes turn white noise into a soft "air" band; the
  // brightness coefficient differentiates the three variants.
  const a = clamp(seedBrightness, 0.05, 0.5);
  let lp1 = 0, lp2 = 0;
  const peakAt = 0.62;                     // inhale swells late, releases quickly
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    lp1 += a * (white - lp1);
    lp2 += a * (lp1 - lp2);
    const t = i / n;
    const env = t < peakAt
      ? Math.sin((t / peakAt) * (Math.PI / 2)) ** 2
      : Math.cos(((t - peakAt) / (1 - peakAt)) * (Math.PI / 2)) ** 2;
    const s = Math.round(lp2 * env * BREATH_PEAK * 32767 * 3.5); // ×3.5 recovers low-pass loss
    out.writeInt16LE(clamp(s, -32768, 32767), i * 2);
  }
  return out;
};

/** Decides when a breath plays and which variant: only before replies longer than
 *  `minWords`, never two turns in a row (max one per two turns), rotating three
 *  variants and never repeating the previous one. */
export class BreathScheduler {
  private readonly variants: Buffer[];
  private lastVariant = -1;
  private turnsSinceBreath = 99;

  constructor(variants?: Buffer[], private readonly minWords = 8) {
    this.variants = variants && variants.length > 0 ? variants : [
      generateBreath(180, 0.12),
      generateBreath(220, 0.18),
      generateBreath(260, 0.09),
    ];
  }

  /** Call once per agent turn with the reply's word count. Returns the breath PCM to
   *  prepend, or null when this turn goes without one. */
  next(wordCount: number): Buffer | null {
    this.turnsSinceBreath++;
    if (wordCount <= this.minWords) return null;
    if (this.turnsSinceBreath < 2) return null;          // max one breath per 2 turns
    let idx = Math.floor(Math.random() * this.variants.length);
    if (idx === this.lastVariant) idx = (idx + 1) % this.variants.length;
    this.lastVariant = idx;
    this.turnsSinceBreath = 0;
    return this.variants[idx];
  }
}
