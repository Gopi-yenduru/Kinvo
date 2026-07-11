import { Lang } from '../emergency.js';
import { FillerSet } from './EmotionEngine.js';

/**
 * FillerAudio — pre-generated acknowledgment clips that cover LLM "thinking" time.
 * =====================================================================================
 * The single biggest humanness trick from the Project VANI naturalness spec (§7.3):
 * a real person never goes dead-silent after you speak — they say "ఊఁ...", "సరే...",
 * "hmm..." while they think. So the provider pre-synthesises a small library of short
 * acknowledgment clips IN THE SESSION'S OWN VOICE, and if the real reply's first audio
 * hasn't arrived ~350 ms after the patient stops talking, one clip (matched to the
 * patient's current emotional state, never repeating the last two) is played instantly.
 * The real reply then queues gaplessly behind it in the browser player.
 *
 * This module owns the TEXT sets and the process-wide clip cache (keyed by engine +
 * language + voice + text, so clips survive across sessions and are generated once).
 * Synthesis itself lives in SarvamProvider, which owns the TTS clients.
 */

// Minimum 4 variants per set so repetition is never noticed. Every clip is short
// (≈ 0.5–1.2 s of audio) — a filler must never feel like a sentence.
export const FILLER_TEXTS: Record<Lang, Record<FillerSet, string[]>> = {
  'te-IN': {
    standard: ['ఊఁ...', 'సరే...', 'అలాగా...', 'సరే అండి...', 'హ్మ్... ఒక్క నిమిషం...'],
    calm:     ['సరే అండి...', 'అర్థమైంది...', 'ఊఁ... వింటున్నాను...', 'చెప్పండి అండి...'],
    soft:     ['అయ్యో...', 'అర్థమవుతోంది అండి...', 'పర్వాలేదండి...', 'ఊఁ...'],
    patient:  ['పర్వాలేదండి...', 'ఒక్క నిమిషం అండి...', 'సరే... మెల్లగా చూద్దాం...', 'ఊఁ... సరే...'],
    bright:   ['ఆఁ!', 'సరే సరే!', 'చాలా మంచిది...', 'బాగుంది...'],
  },
  'hi-IN': {
    standard: ['हम्म...', 'अच्छा...', 'जी...', 'ठीक है...', 'एक मिनट जी...'],
    calm:     ['जी... समझ गई...', 'अच्छा... बताइए...', 'हम्म...', 'जी जी...'],
    soft:     ['अरे...', 'समझ रही हूँ...', 'कोई बात नहीं...', 'हम्म...'],
    patient:  ['कोई बात नहीं...', 'एक मिनट जी...', 'अच्छा... आराम से देखते हैं...', 'जी...'],
    bright:   ['अरे वाह!', 'बहुत अच्छा...', 'ठीक है जी!', 'अच्छा अच्छा!'],
  },
  'en-IN': {
    standard: ['Hmm...', 'Okay...', 'Right...', 'I see...', 'One moment...'],
    calm:     ['Okay... I hear you...', 'Alright...', 'Hmm...', 'Okay...'],
    soft:     ['Oh...', 'I understand...', "It's okay...", 'Hmm...'],
    patient:  ['No problem...', 'One second...', "Okay... let's take it slowly...", 'Alright...'],
    bright:   ['Oh nice!', 'Okay, great...', "That's good...", 'Lovely...'],
  },
};

/** Every distinct clip text for a language (for pre-warming the cache). */
export const allFillerTexts = (lang: Lang): string[] =>
  [...new Set(Object.values(FILLER_TEXTS[lang] || {}).flat())];

export interface FillerClip { text: string; audio: Buffer }

/** Process-wide cache of synthesised clips: generated once, reused by every session
 *  with the same engine + language + voice. */
class FillerLibrary {
  private clips = new Map<string, Buffer>();

  private key(engine: string, lang: string, voice: string, text: string): string {
    return `${engine}|${lang}|${voice}|${text}`;
  }

  has(engine: string, lang: string, voice: string, text: string): boolean {
    return this.clips.has(this.key(engine, lang, voice, text));
  }

  put(engine: string, lang: string, voice: string, text: string, audio: Buffer): void {
    this.clips.set(this.key(engine, lang, voice, text), audio);
  }

  /** A random cached clip from the set, excluding the given recent texts so the same
   *  filler is never heard twice in a row. Null when nothing is cached yet (pre-warm
   *  still running or synthesis failed) — the turn simply plays without a filler. */
  pick(engine: string, lang: Lang, voice: string, set: FillerSet, excludeTexts: string[]): FillerClip | null {
    const texts = (FILLER_TEXTS[lang]?.[set] || []).filter(t => !excludeTexts.includes(t));
    const available = texts
      .map(text => ({ text, audio: this.clips.get(this.key(engine, lang, voice, text)) }))
      .filter((c): c is FillerClip => !!c.audio);
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  }
}

export const fillerLibrary = new FillerLibrary();
