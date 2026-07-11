// Naturalness bake-off (VANI upgrade 6): render the SAME scripted 8-turn agent side of
// a Telugu intake call through up to three voices, produce blind-test WAVs with
// randomized names + an answer key, and separate greeting-only clips (openings are
// judged hardest, so they get their own comparison).
//
//   node scripts/naturalness-bakeoff.mjs [--telephony]
//
// Voices rendered (each skipped with a warning if its key/voice isn't configured):
//   sarvam-stock  Bulbul v3, BAKEOFF_SARVAM_VOICE or TTS_SPEAKER_TE or 'neha'
//   sarvam-alt    Bulbul v3, BAKEOFF_SARVAM_ALT or 'priya' — the stand-in for a Sarvam
//                 clone until Sarvam's enterprise cloning provisions a custom speaker
//   elevenlabs    ELEVENLABS_VOICE_TE (point this at your clone from clone-voice.mjs)
//
// --telephony post-processes everything to 8 kHz + 300–3400 Hz band-pass, approximating
// a phone line (the original VANI spec's target). Default output is the pipeline's
// native 24 kHz, which is what patients actually hear in this browser-based app.
//
// Output: backend/bakeoff-output/
//   sample_A.wav / sample_B.wav / ...      full 8-turn call, shuffled labels
//   greeting_A.wav / greeting_B.wav / ...  first turn only (≤5 s), same labels
//   answer_key.json                        label → voice mapping (don't show listeners!)
//   playlist.txt                           instructions to hand the listeners
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { SarvamAIClient } from 'sarvamai';

const SAMPLE_RATE = 24000;
const TELEPHONY = process.argv.includes('--telephony');
const OUT_DIR = path.resolve('bakeoff-output');

// The scripted agent side of one first-visit intake (patient replies omitted — the
// listeners judge the agent's voice). Turn 1 doubles as the greeting clip.
const SCRIPT = [
  'నమస్కారం అండి! నేను ఆరోగ్య సహాయకి... డాక్టర్ గారు చూసే ముందు కొన్ని వివరాలు అడుగుతాను. మీరు మొదటిసారి వస్తున్నారా?',
  'అలాగా, సరే అండి. మీ పేరు ఏమిటి?',
  'చాలా మంచి పేరు అండి... మీ వయసు ఎంత?',
  'సరే. ఈ రోజు మీకు ఏ సమస్యతో ఇబ్బందిగా ఉంది?',
  'అయ్యో... మూడు రోజుల నుంచి జ్వరమా. ఒంట్లో నొప్పులు కూడా ఉన్నాయా?',
  'అర్థమైంది అండి. జ్వరం రాత్రి ఎక్కువ వస్తుందా, పగలు వస్తుందా?',
  'పర్వాలేదండి, బాధ పడకండి... మనం అన్నీ డాక్టర్ గారికి చెప్దాం. ప్రస్తుతం ఏమైనా మందులు వాడుతున్నారా?',
  'సరే అండి, ధన్యవాదాలు! మీ వివరాలన్నీ డాక్టర్ గారికి పంపించాను... ఇప్పుడు డాక్టర్ గారు మిమ్మల్ని చూస్తారు. మంచి రోజు అండి!',
];

// ── Renderers (return PCM16 mono @ 24 kHz per line) ────────────────────────────────
const sarvamKey = process.env.SARVAM_API_KEY;
const elevenKey = process.env.ELEVENLABS_API_KEY;
const elevenVoice = (process.env.ELEVENLABS_VOICE_TE || process.env.ELEVENLABS_VOICE_ID || '').trim();

async function renderSarvam(text, speaker) {
  const client = new SarvamAIClient({ apiSubscriptionKey: sarvamKey });
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let tts = null, idle = null, safety = null;
    const finish = (err) => {
      if (settled) return; settled = true;
      clearTimeout(idle); clearTimeout(safety);
      try { tts?.close(); } catch {}
      if (!err && chunks.length) resolve(Buffer.concat(chunks));
      else reject(err || new Error('no audio'));
    };
    (async () => {
      try {
        tts = await client.textToSpeechStreaming.connect({
          model: 'bulbul:v3', send_completion_event: 'true', 'Api-Subscription-Key': sarvamKey
        });
        tts.on('message', (msg) => {
          if (msg?.type === 'audio' && msg?.data?.audio) {
            chunks.push(Buffer.from(String(msg.data.audio), 'base64'));
            clearTimeout(idle); idle = setTimeout(() => finish(), 1500);
          } else if (msg?.type === 'event' && msg?.data?.event_type === 'final') finish();
        });
        tts.on('error', (e) => finish(e));
        tts.on('close', () => finish());
        if (typeof tts.waitForOpen === 'function') await tts.waitForOpen();
        tts.configureConnection({
          target_language_code: 'te-IN', speaker, model: 'bulbul:v3',
          pace: 0.9, enable_preprocessing: true,
          output_audio_codec: 'linear16', speech_sample_rate: SAMPLE_RATE
        });
        tts.convert(text);
        tts.flush();
        safety = setTimeout(() => finish(), 20000);
      } catch (e) { finish(e); }
    })();
  });
}

async function renderEleven(text) {
  const model = (process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2').trim();
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoice}/stream?output_format=pcm_24000`, {
    method: 'POST',
    headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model })
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, buf.length - (buf.length % 2));
}

// ── Simple DSP for --telephony (linear resample to 8 kHz + 300–3400 Hz band-pass) ──
function toTelephony(pcm) {
  const inRate = SAMPLE_RATE, outRate = 8000;
  const nIn = pcm.length / 2;
  const nOut = Math.floor(nIn * outRate / inRate);
  const out = Buffer.alloc(nOut * 2);
  // One-pole high-pass (300 Hz) + low-pass (3400 Hz) applied at the source rate.
  const dt = 1 / inRate;
  const rcH = 1 / (2 * Math.PI * 300), aH = rcH / (rcH + dt);
  const rcL = 1 / (2 * Math.PI * 3400), aL = dt / (rcL + dt);
  let prevX = 0, hp = 0, lp = 0;
  const filtered = new Float32Array(nIn);
  for (let i = 0; i < nIn; i++) {
    const x = pcm.readInt16LE(i * 2) / 32768;
    hp = aH * (hp + x - prevX); prevX = x;      // high-pass
    lp = lp + aL * (hp - lp);                    // low-pass
    filtered[i] = lp;
  }
  for (let i = 0; i < nOut; i++) {
    const pos = i * inRate / outRate;
    const i0 = Math.floor(pos), i1 = Math.min(i0 + 1, nIn - 1), fr = pos - i0;
    const v = filtered[i0] * (1 - fr) + filtered[i1] * fr;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  return { pcm: out, rate: outRate };
}

const silence = (ms, rate) => Buffer.alloc(Math.round((ms / 1000) * rate) * 2);

const pcmToWav = (pcm, rate) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};

// ── Main ───────────────────────────────────────────────────────────────────────────
const voices = [];
if (sarvamKey) {
  voices.push({ id: 'sarvam-stock', render: (t) => renderSarvam(t, (process.env.BAKEOFF_SARVAM_VOICE || process.env.TTS_SPEAKER_TE || 'neha').trim()) });
  voices.push({ id: 'sarvam-alt',   render: (t) => renderSarvam(t, (process.env.BAKEOFF_SARVAM_ALT || 'priya').trim()) });
} else console.warn('⚠️  SARVAM_API_KEY unset — skipping both Bulbul voices.');
if (elevenKey && elevenVoice) {
  voices.push({ id: 'elevenlabs', render: renderEleven });
} else console.warn('⚠️  ELEVENLABS_API_KEY / ELEVENLABS_VOICE_TE unset — skipping the ElevenLabs (clone) voice. Run clone-voice.mjs first.');
if (voices.length === 0) { console.error('❌ No voice is configured — nothing to render.'); process.exit(1); }

fs.mkdirSync(OUT_DIR, { recursive: true });

const labels = 'ABCDEFG'.split('').slice(0, voices.length).sort(() => Math.random() - 0.5);
const answerKey = {};

for (let v = 0; v < voices.length; v++) {
  const voice = voices[v];
  const label = labels[v];
  answerKey[label] = voice.id + (TELEPHONY ? ' (telephony 8kHz)' : '');
  console.log(`🎙️  Rendering ${SCRIPT.length} turns with ${voice.id} → sample_${label}.wav ...`);
  const parts = [];
  let greeting = null;
  for (let i = 0; i < SCRIPT.length; i++) {
    const pcm = await voice.render(SCRIPT[i]);
    if (i === 0) greeting = pcm;
    parts.push(pcm, silence(700, SAMPLE_RATE));
    process.stdout.write(`   turn ${i + 1}/${SCRIPT.length}\r`);
  }
  let full = Buffer.concat(parts);
  let rate = SAMPLE_RATE;
  // Greeting clip = the opening turn, trimmed to its first 5 seconds.
  let greet = greeting.subarray(0, Math.min(greeting.length, 5 * SAMPLE_RATE * 2));
  if (TELEPHONY) {
    ({ pcm: full, rate } = toTelephony(full));
    ({ pcm: greet } = toTelephony(greet));
  }
  fs.writeFileSync(path.join(OUT_DIR, `sample_${label}.wav`), pcmToWav(full, rate));
  fs.writeFileSync(path.join(OUT_DIR, `greeting_${label}.wav`), pcmToWav(greet, rate));
  console.log(`   ✅ sample_${label}.wav + greeting_${label}.wav`);
}

fs.writeFileSync(path.join(OUT_DIR, 'answer_key.json'), JSON.stringify(answerKey, null, 2));
fs.writeFileSync(path.join(OUT_DIR, 'playlist.txt'), [
  'BLIND NATURALNESS TEST — instructions',
  '=====================================',
  'Play for 3+ native Telugu listeners, in this order. Do NOT show them answer_key.json.',
  '',
  '1) Greetings first (openings are judged hardest):',
  ...labels.map(l => `     greeting_${l}.wav`),
  '2) Then the full calls:',
  ...labels.map(l => `     sample_${l}.wav`),
  '',
  'For each sample, ask them to score 1–5:',
  '  • Sounds like a real person',
  '  • Pacing and pauses feel natural',
  '  • Language mixing (Telugu+English) feels natural',
  '  • Would NOT have guessed it is AI',
  '',
  'Ship gate (per the VANI spec): mean ≥ 4.0 and no sample below 3.',
  'For every clip scoring under 4, note the exact SECOND where it broke the illusion.',
].join('\n'));

console.log('');
console.log(`✅ Bake-off written to ${OUT_DIR}`);
console.log(`   Voices, blinded: ${labels.map(l => `sample_${l}`).join(', ')} — mapping in answer_key.json`);
console.log('   Hand listeners the files + playlist.txt. Keep answer_key.json to yourself.');
