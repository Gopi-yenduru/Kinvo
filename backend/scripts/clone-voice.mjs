// Voice cloning (VANI upgrade 1): turn a 2–5 minute casual-Telugu recording into the
// agent's own voice. See docs/recording_brief.md for how to make the recording.
//
//   node scripts/clone-voice.mjs --file voice_sample.wav --name "Aarogya Telugu"
//                                [--engine elevenlabs|sarvam] [--test]
//
//   --engine elevenlabs  (default) Instant Voice Cloning via POST /v1/voices/add
//                        (verified against https://elevenlabs.io/docs 2026-07-07).
//                        Requires ELEVENLABS_API_KEY in backend/.env and a paid
//                        ElevenLabs plan (Starter or above — IVC is not on Free).
//   --engine sarvam      Sarvam advertises consent-based cloning for Bulbul v3, but as
//                        of 2026-07-07 the PUBLIC API (docs.sarvam.ai) exposes no
//                        cloning endpoint — it is an enterprise/sales feature. This
//                        path explains that and exits; it does NOT invent an endpoint.
//   --test               After cloning, renders one Telugu test line with the new
//                        voice to clone-test.wav so you can hear it immediately.
//
// On success it prints the voice ID plus the exact .env lines that activate the clone
// for Telugu sessions. The filler-audio library regenerates itself automatically for
// the new voice on the next session (the cache is keyed by engine+language+voice).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const file = arg('file');
const name = arg('name', 'Aarogya Telugu Clone');
const engine = (arg('engine', 'elevenlabs') || '').toLowerCase();

const die = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };

if (!file) die('Usage: node scripts/clone-voice.mjs --file <recording.wav> [--name "..."] [--engine elevenlabs|sarvam] [--test]');
if (!fs.existsSync(file)) die(`File not found: ${file}`);

// ── Sanity-check the recording (RIFF/WAV header → duration, rate, channels) ────────
const buf = fs.readFileSync(file);
if (buf.length < 1000) die('That file is nearly empty.');
if (buf.length > 50 * 1024 * 1024) die('File over 50 MB — trim the recording to 2–5 minutes.');
if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const byteRate = buf.readUInt32LE(28);
  const seconds = byteRate > 0 ? Math.round((buf.length - 44) / byteRate) : 0;
  console.log(`🎧 ${path.basename(file)} — ${seconds}s, ${rate} Hz, ${channels === 1 ? 'mono' : channels + ' ch'}`);
  if (rate < 16000) console.warn('⚠️  Sample rate under 16 kHz — the brief asks for 16 kHz+; the clone may sound dull.');
  if (channels !== 1) console.warn('⚠️  Not mono — acceptable, but mono is preferred.');
  if (seconds && seconds < 110) console.warn(`⚠️  Only ~${seconds}s of audio — the brief asks for 2–5 minutes; short samples clone worse.`);
  if (seconds > 330) console.warn(`⚠️  ~${Math.round(seconds / 60)} min — longer than needed; the first ~5 minutes are what matter.`);
} else {
  console.warn('⚠️  Not a WAV file — ElevenLabs accepts mp3/m4a too, but lossless WAV clones best.');
}

// ── ElevenLabs Instant Voice Cloning ───────────────────────────────────────────────
async function cloneElevenLabs() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) die('ELEVENLABS_API_KEY is not set in backend/.env (IVC also needs a paid ElevenLabs plan — Starter or above).');

  console.log(`🧬 Cloning "${name}" on ElevenLabs (this uploads the recording)...`);
  const form = new FormData();
  form.append('name', name);
  form.append('files', new Blob([buf], { type: 'audio/wav' }), path.basename(file));
  form.append('description', 'Casual conversational Telugu — hospital pre-consultation intake agent (consented recording).');
  form.append('remove_background_noise', 'true');
  form.append('labels', JSON.stringify({ language: 'te', use_case: 'conversational' }));

  const res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    die(`ElevenLabs voice creation failed (${res.status}): ${detail.slice(0, 400)}`);
  }
  const out = await res.json();
  const voiceId = out?.voice_id;
  if (!voiceId) die(`No voice_id in response: ${JSON.stringify(out).slice(0, 300)}`);

  console.log('');
  console.log(`✅ Cloned voice created: ${voiceId}${out.requires_verification ? '  (requires verification in the ElevenLabs dashboard)' : ''}`);
  console.log('');
  console.log('To make Telugu sessions use the clone, add to backend/.env and restart:');
  console.log(`   ELEVENLABS_VOICE_TE=${voiceId}`);
  console.log('   TTS_ENGINE_TE=elevenlabs');
  console.log('');
  console.log('Filler clips ("ఊఁ...", "సరే...") regenerate automatically in this voice on the next session.');

  if (has('test')) {
    console.log('🔊 Rendering a test line to clone-test.wav ...');
    const model = (process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2').trim();
    const tRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'నమస్కారం అండి! నేను ఆరోగ్య సహాయకి... డాక్టర్ గారు చూసే ముందు, మీ వివరాలు కొన్ని అడుగుతాను. మీరు మొదటిసారి వస్తున్నారా?',
        model_id: model
      })
    });
    if (!tRes.ok) { console.warn(`⚠️  Test render failed (${tRes.status}) — the voice itself was still created.`); return; }
    const pcm = Buffer.from(await tRes.arrayBuffer());
    fs.writeFileSync('clone-test.wav', pcmToWav(pcm, 24000));
    console.log('✅ Wrote clone-test.wav — listen before switching the agent over.');
  }
}

const pcmToWav = (pcm, rate) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};

if (engine === 'elevenlabs') {
  cloneElevenLabs().catch(e => die(e?.message || e));
} else if (engine === 'sarvam') {
  console.log(`
Sarvam voice cloning — status as of 2026-07-07
────────────────────────────────────────────────
Sarvam advertises consent-based voice cloning for Bulbul v3, but their PUBLIC API
(docs.sarvam.ai) exposes NO cloning endpoint — it is offered as an enterprise
feature through their sales team. Rather than invent an endpoint, this script stops here.

What you can do:
  1. Contact Sarvam (sarvam.ai → enterprise) about Bulbul v3 voice cloning; if they
     provision a cloned speaker for your account, set it in backend/.env:
        TTS_SPEAKER_TE=<the speaker id they give you>
     and everything (fillers included) picks it up automatically.
  2. Meanwhile use the ElevenLabs path from the SAME recording:
        node scripts/clone-voice.mjs --file ${file} --engine elevenlabs --test
`);
  process.exit(2);
} else {
  die(`Unknown engine "${engine}" — use elevenlabs or sarvam.`);
}
