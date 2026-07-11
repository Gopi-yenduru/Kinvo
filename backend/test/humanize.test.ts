import { describe, it, expect } from 'vitest';
import { GapSampler, PaceJitter, BreathScheduler, generateBreath, countSelfCorrections } from '../src/providers/Humanize.js';

// Humanization regression guard (VANI upgrades 2–5): the timing sampler must never
// repeat, the pace jitter must never repeat, breaths must respect their cadence and
// stay quiet, and the disfluency budget counter must catch violations.

describe('GapSampler (upgrade 4)', () => {
  it('stays inside the range for each turn kind', () => {
    const s = new GapSampler();
    for (let i = 0; i < 300; i++) {
      const short = s.sample('short');
      expect(short).toBeGreaterThanOrEqual(GapSampler.RANGES.short.lo);
      expect(short).toBeLessThanOrEqual(GapSampler.RANGES.short.hi);
      const normal = s.sample('normal');
      expect(normal).toBeGreaterThanOrEqual(GapSampler.RANGES.normal.lo);
      expect(normal).toBeLessThanOrEqual(GapSampler.RANGES.normal.hi);
    }
  });

  it('never returns the same value twice in a row', () => {
    const s = new GapSampler();
    let last = -1;
    for (let i = 0; i < 500; i++) {
      const v = s.sample(i % 2 ? 'short' : 'normal');
      expect(v).not.toBe(last);
      last = v;
    }
  });

  it('actually varies (not a constant with one wiggle)', () => {
    const s = new GapSampler();
    const values = new Set<number>();
    for (let i = 0; i < 100; i++) values.add(s.sample('normal'));
    expect(values.size).toBeGreaterThan(20);
  });
});

describe('PaceJitter (upgrade 2)', () => {
  it('stays within ±0.031 of the base and never repeats consecutively', () => {
    const j = new PaceJitter();
    let last = -1;
    for (let i = 0; i < 500; i++) {
      const v = j.jitter(0.9);
      expect(Math.abs(v - 0.9)).toBeLessThanOrEqual(0.031);
      expect(v).not.toBe(last);
      last = v;
    }
  });
});

describe('BreathScheduler (upgrade 3)', () => {
  it('never breathes on short replies', () => {
    const b = new BreathScheduler();
    for (let i = 0; i < 20; i++) expect(b.next(5)).toBeNull();
  });

  it('breathes at most once per two turns even on long replies', () => {
    const b = new BreathScheduler();
    let prevBreathed = false;
    let breaths = 0;
    for (let i = 0; i < 40; i++) {
      const breathed = b.next(15) !== null;
      expect(prevBreathed && breathed).toBe(false);   // never two turns in a row
      if (breathed) breaths++;
      prevBreathed = breathed;
    }
    expect(breaths).toBeGreaterThan(0);
    expect(breaths).toBeLessThanOrEqual(20);
  });

  it('rotates variants — never the same buffer twice in a row', () => {
    const b = new BreathScheduler();
    let last: Buffer | null = null;
    for (let i = 0; i < 30; i++) {
      const breath = b.next(15);
      b.next(2); // spacer turn so the cadence limit allows the next breath
      if (breath) {
        if (last) expect(breath.equals(last)).toBe(false);
        last = breath;
      }
    }
  });

  it('generates quiet PCM (a breath is felt, not heard)', () => {
    const pcm = generateBreath(220, 0.15);
    expect(pcm.length).toBe(Math.round(0.22 * 24000) * 2);
    let peak = 0, sum = 0;
    const n = pcm.length / 2;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      peak = Math.max(peak, v);
      sum += v * v;
    }
    expect(peak).toBeLessThan(4000);                   // well under −18 dBFS
    expect(Math.sqrt(sum / n)).toBeLessThan(900);      // quiet on average too
    expect(peak).toBeGreaterThan(50);                  // ...but not silence
  });
});

describe('countSelfCorrections (upgrade 5 budget)', () => {
  it('ignores clean replies and ordinary "sorry" usage', () => {
    expect(countSelfCorrections('మీ వయసు ఎంత అండి?')).toBe(0);
    expect(countSelfCorrections('sorry అండి, సరిగ్గా వినపడలేదు... మళ్ళీ చెప్తారా?')).toBe(0);
  });

  it('counts a mid-sentence self-correction', () => {
    expect(countSelfCorrections('డాక్టర్ గారు ఇప్పుడే... sorry, కొద్ది సేపట్లో చూస్తారు అండి.')).toBe(1);
  });

  it('counts stacked imperfections so telemetry can flag them', () => {
    expect(countSelfCorrections('అది రేపు... sorry, ఎల్లుండి... అదే, సోమవారం అండి.')).toBe(2);
  });
});
