// Database backup — works for both SQLite (dev) and PostgreSQL (prod).
//   npm run backup
// Output goes to backend/backups/ (timestamped). Schedule it via cron (Linux)
// or Task Scheduler (Windows) for automated backups; copy off-box for safety.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupsDir = path.join(process.cwd(), 'backups');
fs.mkdirSync(backupsDir, { recursive: true });

const client = (process.env.DB_CLIENT || 'sqlite').toLowerCase();

try {
  if (client === 'postgres' || client === 'postgresql' || client === 'pg') {
    const url = process.env.DATABASE_URL ||
      `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || ''}` +
      `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'medintake'}`;
    const out = path.join(backupsDir, `medintake-${ts}.sql`);
    // Requires the postgresql-client (pg_dump) to be installed.
    execSync(`pg_dump "${url}" -f "${out}"`, { stdio: 'inherit' });
    console.log(`✅ PostgreSQL backup written: ${out}`);
  } else {
    const dbPath = process.env.SQLITE_PATH || path.join(process.cwd(), 'db', 'medintake.sqlite');
    if (!fs.existsSync(dbPath)) throw new Error(`SQLite DB not found at ${dbPath}`);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });
    const out = path.join(backupsDir, `medintake-${ts}.sqlite`);
    await db.backup(out); // consistent online backup (safe while the app is running)
    db.close();
    console.log(`✅ SQLite backup written: ${out}`);
  }
} catch (err) {
  console.error('❌ Backup failed:', err.message);
  process.exit(1);
}
