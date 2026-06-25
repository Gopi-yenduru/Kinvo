const BASE = 'http://localhost:3002';
const TEXT = 'ఈ యాప్ మీ ఆరోగ్య సమాచారాన్ని డాక్టర్ కోసం సేకరిస్తుంది';
const lr = await fetch(`${BASE}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:'admin',password:'admin123'}) });
const { token } = await lr.json();
const H = { 'Content-Type':'application/json', Authorization:`Bearer ${token}` };

// 1) TTS: text -> wav
const tr = await fetch(`${BASE}/api/assistant/tts`, { method:'POST', headers:H, body: JSON.stringify({ text: TEXT }) });
const td = await tr.json();
const wavB64 = td.audio;
console.log('TTS:', wavB64 ? `OK (${Buffer.from(wavB64,'base64').length} bytes wav)` : `FAIL ${JSON.stringify(td)}`);

// 2) STT round-trip: send that wav to transcribe
if (wavB64) {
  const sr = await fetch(`${BASE}/api/assistant/transcribe`, { method:'POST', headers:H, body: JSON.stringify({ audio: wavB64, mime:'audio/wav' }) });
  const sd = await sr.json();
  console.log('STT:', sd.text ? `OK -> "${sd.text}"` : `FAIL ${JSON.stringify(sd)}`);
}
