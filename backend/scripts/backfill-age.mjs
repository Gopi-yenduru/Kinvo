// One-off backfill: rewrite existing patients.age that was stored as spoken text (often
// Telugu, e.g. "నా వయసు పద్దెనిమిది సంవత్సరాలు") into a plain English number ("18").
// Going forward the voice agent already normalizes age at capture (SarvamProvider.normalizeAge);
// this just fixes rows captured before that. Safe to re-run — already-numeric ages are skipped.
//
// Run from backend/:  node scripts/backfill-age.mjs
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { SarvamAIClient } from 'sarvamai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const digitsToAscii = (t) => String(t || '')
  .replace(/[౦-౯]/g, d => String(d.charCodeAt(0) - 0x0c66))   // Telugu numerals
  .replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x0966));  // Devanagari numerals

const pickAge = (s) => { const m = digitsToAscii(s).match(/\d{1,3}/); if (m) { const n = +m[0]; if (n > 0 && n < 120) return String(n); } return null; };

const client = process.env.SARVAM_API_KEY ? new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY }) : null;

async function llmAge(text) {
  if (!client) return null;
  try {
    const resp = await client.chat.completions({
      model: 'sarvam-30b',
      messages: [
        { role: 'system', content: "Extract the person's age in years from the message and reply with ONLY the number in plain digits (e.g. 35). If there is no clear age, reply NA." },
        { role: 'user', content: String(text).slice(0, 160) }
      ],
      temperature: 0, max_tokens: 5, reasoning_effort: null
    });
    return pickAge(resp?.choices?.[0]?.message?.content || '');
  } catch (e) { console.error('  LLM extract failed:', e?.message || e); return null; }
}

async function main() {
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'db', 'medintake.sqlite');
  const db = new Database(dbPath);
  const rows = db.prepare('SELECT id, age FROM patients WHERE age IS NOT NULL AND TRIM(age) <> \'\'').all();
  const update = db.prepare('UPDATE patients SET age = @age, updated_at = datetime(\'now\') WHERE id = @id');

  let fixed = 0, alreadyOk = 0, skipped = 0;
  for (const r of rows) {
    const cur = String(r.age).trim();
    if (/^\d{1,3}$/.test(cur)) { alreadyOk++; continue; }            // already a plain number
    let age = pickAge(cur) || await llmAge(cur);
    if (age && age !== cur) { update.run({ age, id: r.id }); console.log(`  patient ${r.id}: "${cur}" -> ${age}`); fixed++; }
    else { console.log(`  patient ${r.id}: could NOT parse an age from "${cur}" (left unchanged)`); skipped++; }
  }
  db.close();
  console.log(`\nDone. fixed=${fixed}, already-numeric=${alreadyOk}, unparseable=${skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
