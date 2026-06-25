import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import db from '../src/database-manager.js';
import { getJwtSecret, requireRole } from '../src/auth.js';
import { encryptField, decryptField, encryptionEnabled } from '../src/crypto-service.js';
import { buildFhirBundle } from '../src/fhir-service.js';

// Minimal mock of Express req/res for middleware tests.
function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

describe('auth: JWT secret', () => {
  it('uses the env-provided secret (no hardcoded fallback)', () => {
    expect(getJwtSecret()).toBe('test_jwt_secret_at_least_32_chars_long_xxxxx');
  });
});

describe('auth: requireRole (RBAC)', () => {
  it('allows an allowed role', () => {
    let called = false;
    const mw = requireRole('admin');
    const res = mockRes();
    mw({ user: { role: 'admin' } } as any, res as any, () => { called = true; });
    expect(called).toBe(true);
  });

  it('blocks a disallowed role with 403', () => {
    let called = false;
    const mw = requireRole('admin');
    const res = mockRes();
    mw({ user: { role: 'nurse' } } as any, res as any, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('blocks when no user/role present', () => {
    const mw = requireRole('doctor', 'admin');
    const res = mockRes();
    mw({} as any, res as any, () => { /* should not run */ });
    expect(res.statusCode).toBe(403);
  });
});

describe('users + login', () => {
  it('logs in the seeded admin with bcrypt and returns a valid JWT', async () => {
    const result = await db.loginUser('admin', 'admin123', '127.0.0.1', 'vitest');
    expect(result.token).toBeTruthy();
    const decoded: any = jwt.verify(result.token, getJwtSecret());
    expect(decoded.username).toBe('admin');
    expect(decoded.role).toBe('admin');
    expect(result.userData.role).toBe('admin');
  });

  it('rejects a wrong password', async () => {
    await expect(db.loginUser('admin', 'wrongpass', '127.0.0.1', 'vitest')).rejects.toThrow();
  });

  it('rejects an unknown user', async () => {
    await expect(db.loginUser('ghost', 'whatever', '127.0.0.1', 'vitest')).rejects.toThrow();
  });

  it('registers a user with a role and lists it', async () => {
    await db.registerUser('dr_unit', 'dr@x.com', 'StrongPass123', 'doctor');
    const users = await db.listUsers();
    const created = users.find(u => u.username === 'dr_unit');
    expect(created).toBeTruthy();
    expect(created!.role).toBe('doctor');
  });

  it('the registered doctor can log in with bcrypt', async () => {
    const r = await db.loginUser('dr_unit', 'StrongPass123', '127.0.0.1', 'vitest');
    expect(r.userData.role).toBe('doctor');
  });
});

describe('sessions (INSERT + RETURNING + uuid + pagination)', () => {
  it('creates a session and returns a generated id', async () => {
    const s = await db.createSession({
      patient_id: 0, patient_name: 'Unit Patient', provider: 'sarvam',
      status: 'active', start_time: new Date(), end_time: null, red_flags_detected: 0
    } as any);
    expect(s.id).toBeTruthy();
    expect(String(s.id).length).toBeGreaterThan(10); // uuid-like
    const fetched = await db.getSession(String(s.id));
    expect(fetched?.patient_name).toBe('Unit Patient');
  });

  it('paginates sessions (OFFSET/FETCH translation)', async () => {
    for (let i = 0; i < 3; i++) {
      await db.createSession({ patient_id: 0, patient_name: `P${i}`, provider: 'sarvam', status: 'active', start_time: new Date(), end_time: null, red_flags_detected: 0 } as any);
    }
    const page = await db.getSessionsPaginated(1, 2);
    expect(page.sessions.length).toBe(2);
    expect(page.total).toBeGreaterThanOrEqual(4);
    expect(page.currentPage).toBe(1);
  });

  it('computes session counts (GETDATE/CAST AS DATE translation)', async () => {
    const counts = await db.getSessionCounts();
    expect(counts.totalSessions).toBeGreaterThan(0);
    expect(typeof counts.completedToday).toBe('number');
  });
});

describe('PHI field encryption', () => {
  it('is enabled and round-trips', () => {
    expect(encryptionEnabled).toBe(true);
    const enc = encryptField('sensitive patient note');
    expect(typeof enc).toBe('string');
    expect(enc).toMatch(/^enc:v1:/);
    expect(decryptField(enc as string)).toBe('sensitive patient note');
  });

  it('leaves non-encrypted (legacy plaintext) values unchanged on decrypt', () => {
    expect(decryptField('plain text legacy')).toBe('plain text legacy');
  });

  it('stores patient name + transcript encrypted AT REST but reads them back in clear', async () => {
    const s = await db.createSession({ patient_id: 0, patient_name: 'Encrypted Patient', provider: 'sarvam', status: 'active', start_time: new Date(), end_time: null, red_flags_detected: 0 } as any);
    const sid = String(s.id);
    await db.saveConversationLog({ session_id: sid, speaker: 'patient', message: 'My secret symptom details' } as any);

    // App read path -> decrypted
    const fetched: any = await db.getSession(sid);
    expect(fetched.patient_name).toBe('Encrypted Patient');
    const logs = await db.getSessionConversationLogs(sid);
    expect(logs[0].message).toBe('My secret symptom details');

    // Raw DB (what an attacker who steals the file/dump sees) -> ciphertext
    const raw = new Database(path.join(process.cwd(), 'test', '.tmp-test.sqlite'), { readonly: true });
    const rawSession: any = raw.prepare('SELECT patient_name FROM sessions WHERE id = ?').get(sid);
    const rawLog: any = raw.prepare('SELECT message FROM conversation_logs WHERE session_id = ?').get(sid);
    raw.close();
    expect(rawSession.patient_name).toMatch(/^enc:v1:/);
    expect(rawSession.patient_name).not.toContain('Encrypted Patient');
    expect(rawLog.message).toMatch(/^enc:v1:/);
    expect(rawLog.message).not.toContain('secret symptom');
  });
});

describe('FHIR export', () => {
  it('builds a valid FHIR R4 Bundle from intake data', () => {
    const bundle = buildFhirBundle(
      { id: 'sess-1', patient_name: 'Test Patient', start_time: new Date(), end_time: new Date(), status: 'completed' },
      [{ question: 'Any pain?', answer: 'Headache for 2 days', category: 'symptoms' }],
      [{ symptoms: 'chest pain', severity: 'critical', timestamp: new Date() }],
      { report_content: 'Clinical summary text', status: 'approved', reviewed_by: 'admin' }
    );
    expect(bundle.resourceType).toBe('Bundle');
    const types = bundle.entry.map((e: any) => e.resource.resourceType);
    expect(types).toContain('Patient');
    expect(types).toContain('Encounter');
    expect(types).toContain('QuestionnaireResponse');
    expect(types).toContain('Flag');
    expect(types).toContain('DocumentReference');

    const qr = bundle.entry.find((e: any) => e.resource.resourceType === 'QuestionnaireResponse').resource;
    expect(qr.item[0].text).toBe('Any pain?');
    expect(qr.item[0].answer[0].valueString).toBe('Headache for 2 days');

    const doc = bundle.entry.find((e: any) => e.resource.resourceType === 'DocumentReference').resource;
    expect(Buffer.from(doc.content[0].attachment.data, 'base64').toString('utf8')).toBe('Clinical summary text');
  });
});

describe('patient consent', () => {
  it('defaults to not-consented and records consent on demand', async () => {
    const s = await db.createSession({ patient_id: 0, patient_name: 'Consent Patient', provider: 'sarvam', status: 'active', start_time: new Date(), end_time: null, red_flags_detected: 0 } as any);
    const sid = String(s.id);
    const before: any = await db.getSession(sid);
    expect(Boolean(before.consent_given)).toBe(false);
    await db.recordConsent(sid);
    const after: any = await db.getSession(sid);
    expect(Boolean(after.consent_given)).toBe(true);
    expect(after.consent_at).toBeTruthy();
  });
});

describe('report doctor-review workflow', () => {
  it('saves a report (pending), then edits + approves it', async () => {
    const s = await db.createSession({ patient_id: 0, patient_name: 'Report Patient', provider: 'sarvam', status: 'completed', start_time: new Date(), end_time: new Date(), red_flags_detected: 0 } as any);
    const sid = String(s.id);

    await db.saveReport({ session_id: sid, report_content: 'Initial report', generated_at: new Date(), cost: 0.01, version: 1 } as any);
    const r1 = await db.getReport(sid);
    expect(r1?.report_content).toBe('Initial report');
    expect((r1 as any)?.status).toBe('pending'); // default

    await db.reviewReport(sid, { content: 'Edited & reviewed report', status: 'approved', reviewedBy: 'admin' });
    const r2 = await db.getReport(sid);
    expect((r2 as any)?.status).toBe('approved');
    expect((r2 as any)?.reviewed_by).toBe('admin');
    expect(r2?.report_content).toBe('Edited & reviewed report');
  });
});

describe('analytics (token usage aggregation)', () => {
  it('records usage and summarizes it (SUM/AVG/COUNT DISTINCT)', async () => {
    const s = await db.createSession({ patient_id: 0, patient_name: 'Usage Patient', provider: 'sarvam', status: 'completed', start_time: new Date(), end_time: new Date(), red_flags_detected: 0 } as any);
    await db.saveSessionTokenUsage({
      session_id: String(s.id), model: 'sarvam-30b',
      input_audio_tokens: 0, output_audio_tokens: 0,
      text_input_tokens: 100, text_output_tokens: 50,
      input_audio_duration: 0, output_audio_duration: 0, estimated_cost: 0.0123
    } as any);
    const summary = await db.getTokenUsageSummary();
    expect(summary.totalSessions).toBeGreaterThan(0);
    expect(summary.totalTextTokens).toBeGreaterThanOrEqual(150);
    expect(summary.totalCost).toBeGreaterThan(0);
    expect(summary.costByModel.some(m => m.model === 'sarvam-30b')).toBe(true);
  });
});

describe('red flags', () => {
  it('saves a red flag and reads recent ones (DATEADD translation)', async () => {
    const s = await db.createSession({ patient_id: 0, patient_name: 'RF Patient', provider: 'sarvam', status: 'active', start_time: new Date(), end_time: null, red_flags_detected: 0 } as any);
    await db.saveRedFlagEvent({ session_id: String(s.id), symptoms: 'chest pain', severity: 'critical', resolved: false, clinician_notified: true } as any);
    const recent = await db.getRecentRedFlagEvents(24);
    expect(recent.some(r => r.symptoms === 'chest pain')).toBe(true);
  });
});

describe('deleting a session reconciles the patient record', () => {
  it('removes the visit from the patient and recomputes visit_count', async () => {
    // A patient with two visits.
    const patient = await db.createPatient('9990001234');
    const pid = Number(patient.id);
    const s1 = await db.createSession({ patient_id: pid, patient_name: 'Visit One', provider: 'sarvam', status: 'completed', start_time: new Date('2026-01-01'), end_time: new Date('2026-01-01'), red_flags_detected: 0 } as any);
    await db.incrementPatientVisit(pid);
    await db.createSession({ patient_id: pid, patient_name: 'Visit Two', provider: 'sarvam', status: 'completed', start_time: new Date('2026-02-01'), end_time: new Date('2026-02-01'), red_flags_detected: 0 } as any);
    await db.incrementPatientVisit(pid);

    // Before: both visits are on the patient.
    expect((await db.getSessionsByPatientId(pid)).length).toBe(2);
    expect(Number((await db.getPatientById(pid))!.visit_count)).toBe(2);

    // Delete one session from the (Sessions-page) delete path.
    await db.deleteSession(String(s1.id));

    // After: the deleted visit is gone from the patient's list AND their visit_count.
    const sessionsAfter = await db.getSessionsByPatientId(pid);
    expect(sessionsAfter.length).toBe(1);
    expect(sessionsAfter.some(s => String(s.id) === String(s1.id))).toBe(false);
    expect(Number((await db.getPatientById(pid))!.visit_count)).toBe(1);
  });
});
