// Tests the in-app help assistant endpoints with proper UTF-8 Telugu (defined here in
// a UTF-8 file, NOT passed through the shell, which mangles non-ASCII on Windows).
const BASE = 'http://localhost:3002';

const QUESTIONS = [
  ['ఈ యాప్ ఏం చేస్తుంది?', 'what it does'],
  ['దీన్ని ఎలా ఉపయోగించాలి?', 'how to use'],
  ['ఇది డాక్టరా? మందులు చెబుతుందా?', 'is it a doctor'],
  ['నా సమాచారం సురక్షితమేనా?', 'privacy'],
  ['ఎన్ని ప్రశ్నలు ఉంటాయి, ఎంత సమయం పడుతుంది?', 'duration'],
  ['నాకు కడుపు నొప్పిగా ఉంది, ఏ మందు వాడాలి?', 'MEDICAL -> defer to doctor'],
  ['ఈ రోజు హైదరాబాద్‌లో వాతావరణం ఎలా ఉంది?', 'OUT OF SCOPE -> defer to staff'],
  ['నమస్కారం', 'greeting'],
];

async function main() {
  const lr = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const { token } = await lr.json();
  if (!token) throw new Error('login failed');

  for (const [q, label] of QUESTIONS) {
    const r = await fetch(`${BASE}/api/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: q }),
    });
    const data = await r.json();
    console.log(`\nQ (${label}): ${q}`);
    console.log(`A: ${data.reply || data.error}`);
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
