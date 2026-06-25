// Multi-turn check: drives several patient turns and verifies the agent advances
// through DIFFERENT intake questions (no repeats), half-duplex.
import WebSocket from 'ws';
import { SarvamAIClient } from 'sarvamai';
import 'dotenv/config';

const BASE = 'http://localhost:3002';
const TURNS = 5;
// Chief complaint = right-leg/foot pain. Follow-ups are generic. The agent's questions
// (especially "associated symptoms") should adapt to LEG PAIN, not ask about fever/cough.
const CHIEF = 'నా కుడి కాలికి చాలా నొప్పిగా ఉంది';
const ANSWER = 'రెండు రోజులుగా ఉంది';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function wavToPcm16(buf) {
  const idx = buf.indexOf(Buffer.from('data'));
  const start = idx >= 0 ? idx + 8 : 44;
  const pcmBuf = buf.subarray(start);
  const out = new Array(pcmBuf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = pcmBuf.readInt16LE(i * 2);
  return out;
}

async function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (cond()) return true; await sleep(150); }
  log(`   ⚠️ timeout waiting for ${label}`);
  return false;
}

async function main() {
  const lr = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const { token } = await lr.json();
  const sr = await fetch(`${BASE}/api/sessions/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ patientName: 'Multiturn Test', consentGiven: true }) });
  const { sessionId } = await sr.json();
  log(`session ${sessionId}`);

  const sv = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });
  const synth = async (text) => {
    const t = await sv.textToSpeech.convert({ text, target_language_code: 'te-IN', speaker: 'anushka', model: 'bulbul:v2', speech_sample_rate: 24000 });
    return wavToPcm16(Buffer.from(t.audios[0], 'base64'));
  };
  const chiefPcm = await synth(CHIEF);
  const genericPcm = await synth(ANSWER);

  const ws = new WebSocket(`ws://localhost:3002/ws`);
  let status = 'idle';
  const agentTurns = [];   // { responseId, text }
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'status') status = m.state;
    if (m.type === 'agent_transcript' && m.text) agentTurns.push({ id: m.responseId, text: m.text });
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'join_session', sessionId, token }));

  const sendAnswer = async (pcm) => {
    const CHUNK = 4800;
    for (let i = 0; i < pcm.length; i += CHUNK) { ws.send(JSON.stringify({ type: 'audio_data', data: { pcm16: pcm.slice(i, i + CHUNK), sampleRate: 24000 } })); await sleep(110); }
    const silence = new Array(CHUNK).fill(0);
    for (let i = 0; i < 18; i++) { ws.send(JSON.stringify({ type: 'audio_data', data: { pcm16: silence, sampleRate: 24000 } })); await sleep(110); }
  };

  // Greeting turn
  await waitFor(() => agentTurns.length >= 1, 12000, 'greeting');
  await waitFor(() => status === 'listening', 8000, 'listening after greeting');

  for (let t = 1; t <= TURNS; t++) {
    const before = agentTurns.length;
    await sendAnswer(t === 1 ? chiefPcm : genericPcm); // turn 1 = chief complaint (leg pain)
    await waitFor(() => agentTurns.length > before, 16000, `agent reply ${t}`);
    await waitFor(() => status === 'listening', 6000, `listening ${t}`);
  }
  ws.close();
  await sleep(300);

  log(`\n===== AGENT QUESTIONS (${agentTurns.length}) =====`);
  agentTurns.forEach((a, i) => log(`  ${i + 1}. ${a.text}`));

  const texts = agentTurns.map(a => a.text.trim());
  const unique = new Set(texts);
  const exactDupes = texts.length - unique.size;
  log(`\n  total turns: ${texts.length}, unique: ${unique.size}, exact repeats: ${exactDupes}`);
  const ok = texts.length >= TURNS && exactDupes === 0;
  log(`  OVERALL: ${ok ? '✅ NO REPEATED QUESTIONS — script advances' : '⚠️ repeats detected'}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
