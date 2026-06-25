import fs from 'fs';
import path from 'path';

// Wipe the throwaway SQLite DB before the suite so each run starts fresh
// (the data layer creates + seeds the DB on first import).
export default function setup() {
  const base = path.join(process.cwd(), 'test', '.tmp-test.sqlite');
  for (const f of [base, base + '-wal', base + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}
