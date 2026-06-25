import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import db from '../src/database-manager.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('intake links: lifecycle', () => {
  it('creates a pending link with a token and decrypts name/phone on read', async () => {
    const link = await db.createIntakeLink({
      token: 'tok_create_' + Date.now(),
      created_by: 'admin',
      patient_id: null,
      patient_name: 'Link Patient',
      phone: '9876500001',
      language: 'te-IN',
      expires_at: new Date(Date.now() + DAY_MS)
    });
    expect(link.id).toBeTruthy();
    expect(link.status).toBe('pending');
    expect(link.patient_name).toBe('Link Patient');
    expect(link.phone).toBe('9876500001');

    const byToken = await db.getIntakeLinkByToken(link.token);
    expect(byToken?.id).toBe(link.id);
    expect(byToken?.patient_name).toBe('Link Patient');
  });

  it('binds a session (in_progress) then completes', async () => {
    const link = await db.createIntakeLink({
      token: 'tok_flow_' + Date.now(), created_by: 'admin', patient_id: null,
      patient_name: 'Flow Patient', phone: '9876500002', language: 'hi-IN',
      expires_at: new Date(Date.now() + DAY_MS)
    });
    const session = await db.createSession({
      patient_id: 0, patient_name: 'Flow Patient', provider: 'sarvam', language: 'hi-IN',
      status: 'active', start_time: new Date(), end_time: null, red_flags_detected: 0, source: 'remote-link'
    } as any);

    await db.setIntakeLinkSession(link.id, String(session.id));
    const started = await db.getIntakeLinkById(link.id);
    expect(started?.status).toBe('in_progress');
    expect(started?.session_id).toBe(String(session.id));
    expect(started?.used_at).toBeTruthy();

    await db.setIntakeLinkStatus(link.id, 'completed');
    const done = await db.getIntakeLinkById(link.id);
    expect(done?.status).toBe('completed');
    expect(done?.completed_at).toBeTruthy();
  });

  it('records the remote-link source on the created session', async () => {
    const session = await db.createSession({
      patient_id: 0, patient_name: 'Source Patient', provider: 'sarvam', language: 'te-IN',
      status: 'active', start_time: new Date(), end_time: null, red_flags_detected: 0, source: 'remote-link'
    } as any);
    const fetched: any = await db.getSession(String(session.id));
    expect(fetched.source).toBe('remote-link');
  });

  it('can be revoked', async () => {
    const link = await db.createIntakeLink({
      token: 'tok_revoke_' + Date.now(), created_by: 'admin', patient_id: null,
      patient_name: null, phone: null, language: 'en-IN',
      expires_at: new Date(Date.now() + DAY_MS)
    });
    await db.setIntakeLinkStatus(link.id, 'revoked');
    const revoked = await db.getIntakeLinkById(link.id);
    expect(revoked?.status).toBe('revoked');
  });

  it('lists links newest-first with the linked session status joined', async () => {
    const link = await db.createIntakeLink({
      token: 'tok_list_' + Date.now(), created_by: 'admin', patient_id: null,
      patient_name: 'List Patient', phone: '9876500003', language: 'te-IN',
      expires_at: new Date(Date.now() + DAY_MS)
    });
    const session = await db.createSession({
      patient_id: 0, patient_name: 'List Patient', provider: 'sarvam', language: 'te-IN',
      status: 'completed', start_time: new Date(), end_time: new Date(), red_flags_detected: 0, source: 'remote-link'
    } as any);
    await db.setIntakeLinkSession(link.id, String(session.id));

    const page = await db.getIntakeLinksPaginated(1, 50);
    expect(page.total).toBeGreaterThan(0);
    const found: any = page.links.find(l => l.id === link.id);
    expect(found).toBeTruthy();
    expect(found.session_status).toBe('completed');
    expect(found.has_report).toBe(false);
    expect(found.patient_name).toBe('List Patient'); // decrypted in list view
  });

  it('stores link patient_name + phone ENCRYPTED at rest', async () => {
    const link = await db.createIntakeLink({
      token: 'tok_enc_' + Date.now(), created_by: 'admin', patient_id: null,
      patient_name: 'Secret Name', phone: '9998887777', language: 'te-IN',
      expires_at: new Date(Date.now() + DAY_MS)
    });
    const raw = new Database(path.join(process.cwd(), 'test', '.tmp-test.sqlite'), { readonly: true });
    const row: any = raw.prepare('SELECT patient_name, phone FROM intake_links WHERE id = ?').get(link.id);
    raw.close();
    expect(row.patient_name).toMatch(/^enc:v1:/);
    expect(row.patient_name).not.toContain('Secret Name');
    expect(row.phone).toMatch(/^enc:v1:/);
    expect(row.phone).not.toContain('9998887777');
  });
});
