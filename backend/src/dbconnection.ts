/**
 * Database layer — supports SQLite (dev default) and PostgreSQL (production).
 * ---------------------------------------------------------------------------
 * Selected by DB_CLIENT ("sqlite" | "postgres", default "sqlite").
 *
 * The application was written against SQL Server (the `mssql` driver and T-SQL
 * dialect). This module keeps the exact public surface the data layer uses —
 *   import { sql, poolPromise } from "./dbconnection.js"
 *   const pool = await poolPromise;
 *   pool.request().input(name, sql.VarChar, value).query<T>(text) -> { recordset }
 * — and translates the handful of T-SQL constructs the queries use into the
 * dialect of the selected backend.
 *
 * PostgreSQL (production): set
 *   DB_CLIENT=postgres
 *   DATABASE_URL=postgres://user:pass@host:5432/dbname   (or PG* env vars)
 */
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const DB_CLIENT = (process.env.DB_CLIENT || 'sqlite').toLowerCase();

// `sql` type markers — the shim ignores declared types (both backends infer them),
// so each just needs to exist and be callable like the mssql counterparts
// (sql.VarChar, sql.VarChar(250), sql.VarChar(sql.MAX), sql.Decimal(5,1), ...).
const callable = () => callable;
const sql: any = new Proxy(
  { MAX: 2147483647 },
  { get(target: any, prop: string) { return prop in target ? target[prop] : callable; } }
);

interface DbPool { request(): DbRequest; }
interface DbRequest {
  input(name: string, typeOrValue: any, maybeValue?: any): DbRequest;
  query<T = any>(text: string): Promise<{ recordset: T[] }>;
}

let poolPromise: Promise<DbPool>;

/* ======================================================================== */
/*  PostgreSQL backend                                                       */
/* ======================================================================== */
if (DB_CLIENT === 'postgres' || DB_CLIENT === 'postgresql' || DB_CLIENT === 'pg') {
  // Return BIGINT (oid 20) and NUMERIC (oid 1700) as JS numbers, not strings.
  pg.types.setTypeParser(20, (v: string) => (v === null ? null : parseInt(v, 10)));
  pg.types.setTypeParser(1700, (v: string) => (v === null ? null : parseFloat(v)));

  const pool = process.env.DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
    : new pg.Pool({
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
        database: process.env.PGDATABASE || 'medintake'
      });

  const translatePg = (q: string): string => {
    let s = q;
    if (/OUTPUT\s+INSERTED\.\*/i.test(s)) {
      s = s.replace(/OUTPUT\s+INSERTED\.\*/i, ' ');
      if (!/RETURNING/i.test(s)) s = s.replace(/;?\s*$/, '') + ' RETURNING *';
    }
    s = s.replace(/CONVERT\s*\(\s*varbinary\s*\(\s*max\s*\)\s*,\s*([^)]*)\)/gi, '$1');
    s = s.replace(/CONVERT\s*\(\s*varchar\s*\(\s*max\s*\)\s*,\s*([^)]*)\)/gi, '$1');
    s = s.replace(/DATEADD\s*\(\s*HOUR\s*,\s*-?\s*(\d+)\s*,\s*GETDATE\s*\(\s*\)\s*\)/gi, "(NOW() - INTERVAL '$1 hours')");
    s = s.replace(/GETDATE\s*\(\s*\)/gi, 'NOW()');
    s = s.replace(/OFFSET\s+@(\w+)\s+ROWS\s+FETCH\s+NEXT\s+@(\w+)\s+ROWS\s+ONLY/gi, 'LIMIT @$2 OFFSET @$1');
    // CAST(x AS DATE), STRING_AGG(...), CURRENT_TIMESTAMP are all valid in Postgres.
    return s;
  };

  // Convert @name placeholders to positional $1,$2,... (reusing the index for repeats).
  const toPositional = (text: string, params: Record<string, any>): { text: string; values: any[] } => {
    const values: any[] = [];
    const seen: Record<string, string> = {};
    const out = text.replace(/@(\w+)/g, (_m, name: string) => {
      if (!(name in seen)) { values.push(params[name] !== undefined ? params[name] : null); seen[name] = '$' + values.length; }
      return seen[name];
    });
    return { text: out, values };
  };

  class PgRequest implements DbRequest {
    private params: Record<string, any> = {};
    input(name: string, typeOrValue: any, maybeValue?: any): this {
      const value = arguments.length >= 3 ? maybeValue : typeOrValue;
      this.params[name] = value === undefined ? null : value;
      return this;
    }
    async query<T = any>(text: string): Promise<{ recordset: T[] }> {
      const { text: q, values } = toPositional(translatePg(text), this.params);
      const r = await pool.query(q, values);
      return { recordset: r.rows as T[] };
    }
  }

  async function bootstrapPg(): Promise<DbPool> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        patient_id BIGINT,
        patient_name TEXT,
        provider TEXT,
        status TEXT NOT NULL,
        start_time TIMESTAMP NOT NULL DEFAULT NOW(),
        end_time TIMESTAMP,
        red_flags_detected INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS patients (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        phone_hash TEXT UNIQUE,
        phone TEXT,
        name TEXT,
        age TEXT,
        visit_count INTEGER NOT NULL DEFAULT 0,
        medical_summary TEXT,
        first_visit_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_visit_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS settings (
        id BIGINT PRIMARY KEY,
        provider TEXT, model TEXT NOT NULL,
        openai_api_key TEXT, retellai_api_key TEXT, retellai_agent_id TEXT,
        medical_instructions TEXT,
        voice TEXT NOT NULL DEFAULT 'alloy',
        temperature DOUBLE PRECISION NOT NULL DEFAULT 0.6,
        max_response_length BIGINT NOT NULL DEFAULT 200,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS conversation_logs (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT NOT NULL, speaker TEXT NOT NULL, message TEXT, audio_data TEXT,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS red_flag_events (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT NOT NULL, symptoms TEXT, severity TEXT,
        resolved BOOLEAN NOT NULL DEFAULT FALSE, clinician_notified BOOLEAN NOT NULL DEFAULT FALSE,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT, user_id BIGINT, action TEXT NOT NULL, resource_type TEXT,
        details TEXT, ip_address TEXT, user_agent TEXT,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS fhir_resources (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
        resource_data TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS reports (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT NOT NULL, report_content TEXT NOT NULL,
        generated_at TIMESTAMP NOT NULL DEFAULT NOW(), cost DOUBLE PRECISION, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS intake_responses (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT NOT NULL, question TEXT, answer TEXT, category TEXT,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        username TEXT NOT NULL UNIQUE, email TEXT, password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'clinician', created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_logins (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id TEXT NOT NULL, successful BOOLEAN NOT NULL,
        ip_address TEXT, user_agent TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS session_token_usage (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        session_id TEXT NOT NULL, model TEXT NOT NULL,
        input_audio_tokens BIGINT NOT NULL DEFAULT 0, output_audio_tokens BIGINT NOT NULL DEFAULT 0,
        text_input_tokens BIGINT NOT NULL DEFAULT 0, text_output_tokens BIGINT NOT NULL DEFAULT 0,
        input_audio_duration DOUBLE PRECISION NOT NULL DEFAULT 0, output_audio_duration DOUBLE PRECISION NOT NULL DEFAULT 0,
        estimated_cost NUMERIC NOT NULL DEFAULT 0, timestamp TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS intake_links (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        token TEXT UNIQUE NOT NULL,
        created_by TEXT,
        patient_id BIGINT,
        patient_name TEXT,
        phone TEXT,
        phone_hash TEXT,
        language TEXT NOT NULL DEFAULT 'te-IN',
        status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT,
        expires_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        used_at TIMESTAMP,
        completed_at TIMESTAMP
      );
    `);

    // Doctor-review columns on reports + patient consent on sessions (idempotent)
    await pool.query(`
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS consent_given BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS consent_at TIMESTAMP;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS language TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'staff';
    `);

    // Seed settings + bcrypt admin (idempotent)
    const sc = await pool.query('SELECT COUNT(*)::int AS c FROM settings');
    if (sc.rows[0].c === 0) {
      await pool.query(`INSERT INTO settings (id, provider, model, voice, temperature, max_response_length, medical_instructions)
        VALUES (1,'sarvam','sarvam-30b','anushka',0.6,200,'You are a medical intake assistant conducting a pre-consultation interview.')`);
    }
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminHash = bcrypt.hashSync(adminPassword, 10);
    const a = await pool.query("SELECT id, password_hash FROM users WHERE username='admin'");
    if (a.rows.length === 0) {
      await pool.query("INSERT INTO users (username,email,password_hash,role) VALUES ('admin','admin@example.com',$1,'admin')", [adminHash]);
    } else if (!String(a.rows[0].password_hash).startsWith('$2')) {
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [adminHash, a.rows[0].id]);
      console.log('🔐 Migrated admin password to bcrypt hash');
    }

    console.log(`✅ Connected to PostgreSQL (${process.env.DATABASE_URL ? 'DATABASE_URL' : (process.env.PGHOST || 'localhost')})`);
    return { request: () => new PgRequest() };
  }

  poolPromise = bootstrapPg();

} else {
  /* ====================================================================== */
  /*  SQLite backend (default)                                              */
  /* ====================================================================== */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const DB_PATH = process.env.SQLITE_PATH || path.join(here, '..', 'db', 'medintake.sqlite');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  const UUID = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))`;

  db.exec(`
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY DEFAULT (${UUID}), patient_id INTEGER, patient_name TEXT, provider TEXT, status TEXT NOT NULL, start_time TEXT NOT NULL DEFAULT (datetime('now')), end_time TEXT, red_flags_detected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_hash TEXT UNIQUE, phone TEXT, name TEXT, age TEXT, visit_count INTEGER NOT NULL DEFAULT 0, medical_summary TEXT, first_visit_at TEXT NOT NULL DEFAULT (datetime('now')), last_visit_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, provider TEXT, model TEXT NOT NULL, openai_api_key TEXT, retellai_api_key TEXT, retellai_agent_id TEXT, medical_instructions TEXT, voice TEXT NOT NULL DEFAULT 'alloy', temperature REAL NOT NULL DEFAULT 0.6, max_response_length INTEGER NOT NULL DEFAULT 200, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS conversation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, speaker TEXT NOT NULL, message TEXT, audio_data TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS red_flag_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, symptoms TEXT, severity TEXT, resolved INTEGER NOT NULL DEFAULT 0, clinician_notified INTEGER NOT NULL DEFAULT 0, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, user_id INTEGER, action TEXT NOT NULL, resource_type TEXT, details TEXT, ip_address TEXT, user_agent TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS fhir_resources (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, resource_data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, report_content TEXT NOT NULL, generated_at TEXT NOT NULL DEFAULT (datetime('now')), cost REAL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS intake_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, question TEXT, answer TEXT, category TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY DEFAULT (${UUID}), username TEXT NOT NULL UNIQUE, email TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'clinician', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS user_logins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, successful INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS session_token_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, model TEXT NOT NULL, input_audio_tokens INTEGER NOT NULL DEFAULT 0, output_audio_tokens INTEGER NOT NULL DEFAULT 0, text_input_tokens INTEGER NOT NULL DEFAULT 0, text_output_tokens INTEGER NOT NULL DEFAULT 0, input_audio_duration REAL NOT NULL DEFAULT 0, output_audio_duration REAL NOT NULL DEFAULT 0, estimated_cost REAL NOT NULL DEFAULT 0, timestamp TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS intake_links (id TEXT PRIMARY KEY DEFAULT (${UUID}), token TEXT UNIQUE NOT NULL, created_by TEXT, patient_id INTEGER, patient_name TEXT, phone TEXT, phone_hash TEXT, language TEXT NOT NULL DEFAULT 'te-IN', status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT, completed_at TEXT);
  `);

  if ((db.prepare('SELECT COUNT(*) AS c FROM settings').get() as any).c === 0) {
    db.prepare(`INSERT INTO settings (id, provider, model, voice, temperature, max_response_length, medical_instructions)
                VALUES (1,'sarvam','sarvam-30b','anushka',0.6,200,'You are a medical intake assistant conducting a pre-consultation interview.')`).run();
  }

  // Doctor-review columns on reports + patient consent on sessions (idempotent)
  const reportCols = (db.prepare("PRAGMA table_info(reports)").all() as any[]).map(c => c.name);
  if (!reportCols.includes('status')) db.exec("ALTER TABLE reports ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  if (!reportCols.includes('reviewed_by')) db.exec("ALTER TABLE reports ADD COLUMN reviewed_by TEXT");
  if (!reportCols.includes('reviewed_at')) db.exec("ALTER TABLE reports ADD COLUMN reviewed_at TEXT");
  const sessCols = (db.prepare("PRAGMA table_info(sessions)").all() as any[]).map(c => c.name);
  if (!sessCols.includes('consent_given')) db.exec("ALTER TABLE sessions ADD COLUMN consent_given INTEGER NOT NULL DEFAULT 0");
  if (!sessCols.includes('consent_at')) db.exec("ALTER TABLE sessions ADD COLUMN consent_at TEXT");
  if (!sessCols.includes('language')) db.exec("ALTER TABLE sessions ADD COLUMN language TEXT");
  if (!sessCols.includes('source')) db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'staff'");
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const adminHash = bcrypt.hashSync(adminPassword, 10);
  const adminRow = db.prepare("SELECT id, password_hash FROM users WHERE username='admin'").get() as any;
  if (!adminRow) {
    db.prepare(`INSERT INTO users (username, email, password_hash, role) VALUES ('admin','admin@example.com',?,'admin')`).run(adminHash);
  } else if (!String(adminRow.password_hash).startsWith('$2')) {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(adminHash, adminRow.id);
    console.log('🔐 Migrated admin password to bcrypt hash');
  }

  const translateSqlite = (query: string): string => {
    let s = query;
    if (/OUTPUT\s+INSERTED\.\*/i.test(s)) {
      s = s.replace(/OUTPUT\s+INSERTED\.\*/i, ' ');
      if (!/RETURNING/i.test(s)) s = s.replace(/;?\s*$/, '') + ' RETURNING *';
    }
    s = s.replace(/CONVERT\s*\(\s*varbinary\s*\(\s*max\s*\)\s*,\s*([^)]*)\)/gi, '$1');
    s = s.replace(/CONVERT\s*\(\s*varchar\s*\(\s*max\s*\)\s*,\s*([^)]*)\)/gi, '$1');
    s = s.replace(/DATEADD\s*\(\s*HOUR\s*,\s*-?\s*(\d+)\s*,\s*GETDATE\s*\(\s*\)\s*\)/gi, "datetime('now','-$1 hours')");
    s = s.replace(/GETDATE\s*\(\s*\)/gi, "datetime('now')");
    s = s.replace(/CAST\s*\(\s*(.+?)\s+AS\s+DATE\s*\)/gi, 'date($1)');
    s = s.replace(/OFFSET\s+@(\w+)\s+ROWS\s+FETCH\s+NEXT\s+@(\w+)\s+ROWS\s+ONLY/gi, 'LIMIT @$2 OFFSET @$1');
    s = s.replace(/STRING_AGG\s*\(\s*DISTINCT\s+(\w+)\s*,\s*'[^']*'\s*\)/gi, 'group_concat(DISTINCT $1)');
    s = s.replace(/STRING_AGG\s*\(\s*(\w+)\s*,\s*'([^']*)'\s*\)/gi, "group_concat($1, '$2')");
    return s;
  };
  const normalizeSqlite = (value: any): any => {
    if (value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  };

  class SqliteRequest implements DbRequest {
    private params: Record<string, any> = {};
    input(name: string, typeOrValue: any, maybeValue?: any): this {
      const value = arguments.length >= 3 ? maybeValue : typeOrValue;
      this.params[name] = normalizeSqlite(value);
      return this;
    }
    async query<T = any>(text: string): Promise<{ recordset: T[] }> {
      const sqlText = translateSqlite(text);
      const stmt = db.prepare(sqlText);
      const hasParams = Object.keys(this.params).length > 0;
      const returnsRows = /^\s*(SELECT|WITH)/i.test(sqlText) || /RETURNING/i.test(sqlText);
      if (returnsRows) return { recordset: (hasParams ? stmt.all(this.params) : stmt.all()) as T[] };
      if (hasParams) stmt.run(this.params); else stmt.run();
      return { recordset: [] as T[] };
    }
  }

  console.log(`✅ Connected to SQLite at ${DB_PATH}`);
  poolPromise = Promise.resolve({ request: () => new SqliteRequest() });
}

export { sql, poolPromise };
