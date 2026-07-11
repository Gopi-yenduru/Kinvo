import { describe, it, expect } from 'vitest';
import { EmotionEngine } from '../src/providers/EmotionEngine.js';
import { FILLER_TEXTS, allFillerTexts, fillerLibrary } from '../src/providers/FillerAudio.js';

// Naturalness regression guard (VANI spec §5): the empathy engine must detect the
// patient's emotional state from their words in Telugu / Hindi / English, decay it
// gradually instead of resetting, and recommend escalation for persistent distress.

describe('EmotionEngine: lexicon detection across languages', () => {
  const cases: Array<[string, string, string]> = [
    // [label, utterance, expected emotion]
    ['te: severe pain + fear',   'నొప్పి చాలా ఎక్కువగా ఉంది, భయంగా ఉంది',            'WORRIED'],
    ['te: cannot bear it',       'ఈ నొప్పి తట్టుకోలేకపోతున్నాను',                      'WORRIED'],
    ['te: told you already',     'చెప్పాను కదా అండి, మళ్ళీ మళ్ళీ అడుగుతున్నారు',       'FRUSTRATED'],
    ['te: did not understand',   'నాకు అర్థం కాలేదు, మళ్ళీ చెప్పండి',                  'CONFUSED'],
    ['te: feeling better',       'ఇప్పుడు చాలా బాగుంది, నొప్పి తగ్గింది',              'HAPPY'],
    ['hi: fear + pain',          'बहुत दर्द हो रहा है और मुझे डर लग रहा है',           'WORRIED'],
    ['hi: how many times',       'कितनी बार बताऊँ, बार बार वही पूछ रहे हैं',           'FRUSTRATED'],
    ['hi: confused',             'समझ नहीं आया, फिर से बताइए',                          'CONFUSED'],
    ['hi: relief',               'अब आराम है, ठीक हो गया',                              'HAPPY'],
    ['en: scared + pain',        'I am really scared, the pain is unbearable',          'WORRIED'],
    ['en: frustrated',           'I already told you this, this is ridiculous',         'FRUSTRATED'],
    ['en: confused',             "Sorry, I don't understand what do you mean",          'CONFUSED'],
    ['en: much better',          'I am feeling much better now, thank you so much',     'HAPPY'],
  ];
  it.each(cases)('detects %s', (_label, utterance, expected) => {
    const e = new EmotionEngine();
    e.update(utterance);
    expect(e.emotion).toBe(expected);
    expect(e.intensity).toBeGreaterThanOrEqual(1);
  });

  it('stays NEUTRAL on ordinary intake answers', () => {
    const e = new EmotionEngine();
    for (const text of ['నా పేరు రమేష్', 'నా వయసు ముప్పై ఐదు', 'రెండు రోజుల నుంచి జ్వరం ఉంది', 'my name is Ramesh']) {
      e.update(text);
    }
    expect(e.emotion).toBe('NEUTRAL');
    expect(e.intensity).toBe(0);
  });
});

describe('EmotionEngine: state machine', () => {
  it('decays one intensity level per 2 calm turns instead of resetting', () => {
    const e = new EmotionEngine();
    e.update('నొప్పి చాలా ఎక్కువ, భయంగా ఉంది, తట్టుకోలేకపోతున్నాను'); // strong WORRIED
    const peak = e.intensity;
    expect(peak).toBeGreaterThanOrEqual(2);
    e.update('సరే');                          // calm turn 1 — still tender
    expect(e.emotion).toBe('WORRIED');
    expect(e.intensity).toBe(peak);
    e.update('మూడు రోజుల నుంచి');             // calm turn 2 — one level down
    expect(e.intensity).toBe(peak - 1);
    expect(e.trend).toBe('cooling');
  });

  it('produces the LLM control header in the spec format', () => {
    const e = new EmotionEngine();
    expect(e.header()).toBe('[EMOTION: NEUTRAL | INTENSITY: 0 | TREND: steady]');
    e.update('I am really scared, the pain is unbearable');
    expect(e.header()).toMatch(/^\[EMOTION: WORRIED \| INTENSITY: [1-3] \| TREND: (rising|steady)\]$/);
  });

  it('recommends escalation after 3 voice barge-ins', () => {
    const e = new EmotionEngine();
    e.recordBargeIn(); e.recordBargeIn();
    expect(e.escalationRecommended).toBe(false);
    e.recordBargeIn();
    expect(e.escalationRecommended).toBe(true);
    expect(e.shouldFlagEscalation()).toBe(true);   // flags exactly once
    expect(e.shouldFlagEscalation()).toBe(false);
  });

  it('maps emotions to the matching filler set', () => {
    const e = new EmotionEngine();
    expect(e.fillerSet()).toBe('standard');
    e.update('कितनी बार बताऊँ, बार बार वही पूछ रहे हैं');
    expect(e.fillerSet()).toBe('calm');
  });
});

describe('FillerAudio: text sets and library', () => {
  it('has at least 4 variants per set per language (so repetition is never noticed)', () => {
    for (const sets of Object.values(FILLER_TEXTS)) {
      for (const texts of Object.values(sets)) {
        expect(texts.length).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('never picks one of the two most recent fillers', () => {
    const texts = FILLER_TEXTS['te-IN'].standard;
    for (const t of texts) fillerLibrary.put('sarvam', 'te-IN', 'neha', t, Buffer.from([0, 0]));
    const exclude = texts.slice(0, 2);
    for (let i = 0; i < 25; i++) {
      const clip = fillerLibrary.pick('sarvam', 'te-IN', 'neha', 'standard', exclude);
      expect(clip).not.toBeNull();
      expect(exclude).not.toContain(clip!.text);
    }
  });

  it('returns null (no filler, no crash) when nothing is cached for the voice', () => {
    expect(fillerLibrary.pick('sarvam', 'te-IN', 'uncached-voice', 'soft', [])).toBeNull();
  });

  it('deduplicates clip texts across sets for pre-warming', () => {
    const all = allFillerTexts('te-IN');
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });
});
