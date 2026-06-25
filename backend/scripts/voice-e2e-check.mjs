// One-shot end-to-end voice pipeline check against a running backend (port 3002).
// login -> start session (consent) -> WS join -> capture greeting (Chat+TTS)
// -> synthesize Telugu speech and feed it as mic audio (STT->LLM->TTS full loop).
import WebSocket from 'ws';
import { SarvamAIClient } from 'sarvamai';
import 'dotenv/config';

const BASE = 'http://localhost:3002';
const WS_URL = 'ws://localhost:3002';
const TELUGU_UTTERANCE = 'నాకు రెండు రోజులుగా జ్వరం మరియు తలనొప్పి ఉంది';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wavToPcm16(buf) {
  // Find 'data' chunk to be robust to header size.
  const idx = buf.indexOf(Buffer.from('data'));
  const start = idx >= 0 ? idx + 8 : 44;
  const pcmBuf = buf.subarray(start);
  const samples = new Int16Array(pcmBuf.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = pcmBuf.readInt16LE(i * 2);
  return Array.from(samples);
}

async function main() {
  const errors = [];
  // 1. login
  const lr = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const { token } = await lr.json();
  if (!token) throw new Error('login failed');
  log('1. login OK');

  // 2. start session
  const sr = await fetch(`${BASE}/api/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ patientName: 'E2E Test', consentGiven: true }),
  });
  const sj = await sr.json();
  if (sr.status !== 200 || !sj.sessionId) throw new Error('session start failed: ' + JSON.stringify(sj));
  log(`2. session start OK  (provider=${sj.provider}, id=${sj.sessionId})`);
  const sessionId = sj.sessionId;

  // 3. pre-generate Telugu "mic" audio via Sarvam TTS REST
  const sv = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });
  const tts = await sv.textToSpeech.convert({
    text: TELUGU_UTTERANCE, target_language_code: 'te-IN',
    speaker: 'anushka', model: 'bulbul:v2', speech_sample_rate: 24000,
  });
  const wav = Buffer.from(tts.audios[0], 'base64');
  const pcm = wavToPcm16(wav);
  log(`3. synthesized mic audio OK  (${pcm.length} samples @24kHz, ~${(pcm.length / 24000).toFixed(1)}s)`);

  // 4. WS connect + drive
  const ws = new WebSocket(`${WS_URL}/ws`);
  const events = {};
  let greetingAudio = 0, replyAudio = 0, patientTranscripts = [], agentTexts = [];
  let phase = 'greeting';

  let greetingChunks = 0, replyChunks = 0;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    events[m.type] = (events[m.type] || 0) + 1;
    if (m.type === 'error') errors.push(m.message);
    if (m.type === 'agent_audio' && m.audio) {
      const bytes = Buffer.from(m.audio, 'base64').length;
      if (phase === 'greeting') { greetingAudio += bytes; greetingChunks++; }
      else { replyAudio += bytes; replyChunks++; }
    }
    if (m.type === 'agent_transcript' && m.text) agentTexts.push(m.text);
    if (m.type === 'patient_transcript' && m.text) patientTranscripts.push(m.text);
  });

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'join_session', sessionId, token }));
  log('4. WS open + join_session sent');

  // wait for greeting to be produced
  await sleep(9000);
  log(`   greeting: ${greetingAudio} bytes of TTS audio, agentTexts=${agentTexts.length}`);
  phase = 'reply';

  // 5. feed mic audio in 200ms chunks (4800 samples @24kHz)
  const CHUNK = 4800;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    ws.send(JSON.stringify({ type: 'audio_data', data: { pcm16: pcm.slice(i, i + CHUNK), timestamp: Date.now() } }));
    await sleep(120);
  }
  // Trailing silence so Sarvam VAD marks end-of-speech (a real mic streams continuously).
  const silence = new Array(CHUNK).fill(0);
  for (let i = 0; i < 20; i++) {
    ws.send(JSON.stringify({ type: 'audio_data', data: { pcm16: silence, timestamp: Date.now() } }));
    await sleep(120);
  }
  log('5. mic audio + trailing silence streamed, waiting for STT->LLM->TTS...');
  await sleep(14000);

  // leak check (#4): active sessions before vs after closing the socket
  const metrics = async () => {
    const r = await fetch(`${BASE}/api/admin/metrics`, { headers: { Authorization: `Bearer ${token}` } });
    return (await r.json()).activeSessions;
  };
  const activeBefore = await metrics();
  ws.close();
  await sleep(1500);
  const activeAfter = await metrics();
  log(`\n   active sessions: before close=${activeBefore}, after close=${activeAfter}`);
  await sleep(300);

  // report
  log('\n===== EVENT COUNTS =====');
  for (const [k, v] of Object.entries(events)) log(`   ${k}: ${v}`);
  log('\n===== RESULTS =====');
  const greetOk = greetingAudio > 1000;
  const replyOk = replyAudio > 1000;
  const transcriptOk = patientTranscripts.length > 0 || agentTexts.length >= 2;
  log(`   greeting audio (Chat+TTS): ${greetOk ? 'PASS' : 'FAIL'} (${greetingAudio} bytes in ${greetingChunks} streamed chunks)`);
  log(`   STT patient transcript:    ${patientTranscripts.length ? 'PASS' : 'n/a'} ${JSON.stringify(patientTranscripts.slice(0,2))}`);
  log(`   reply audio (LLM+TTS):     ${replyOk ? 'PASS' : 'FAIL'} (${replyAudio} bytes in ${replyChunks} streamed chunks)`);
  log(`   agent texts: ${JSON.stringify(agentTexts.slice(0, 4))}`);
  log(`   errors: ${errors.length ? JSON.stringify(errors) : 'none'}`);
  const leakOk = activeAfter < activeBefore || activeAfter === 0;
  log(`   session cleanup on disconnect: ${leakOk ? 'PASS' : 'FAIL'}`);
  const ok = greetOk && replyOk && leakOk && errors.length === 0;
  log(`\n   OVERALL: ${ok ? '✅ VOICE PIPELINE WORKING' : '⚠️ SEE ABOVE'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
