import { sql, poolPromise } from "./dbconnection.js";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import cacheService, { CACHE_PATTERNS } from './cache-service.js';
import { getJwtSecret, JWT_EXPIRES_IN } from './auth.js';
import { encryptField, decryptField, decryptRows, hashIdentifier } from './crypto-service.js';

// Interfaces
export interface Session {
  id: string;
  patient_id: number;
  patient_name: string;
  provider?: string;
  language?: string;        // te-IN | hi-IN | en-IN (Sarvam pipeline)
  status: string;
  start_time: Date;
  end_time?: Date | null;
  red_flags_detected: number;
  created_at: Date;
  source?: string;          // 'staff' (in-clinic) | 'remote-link' (patient self-service link)
  patient_phone?: string | null;   // joined from patients table for list views (not a sessions column)
}

export interface Setting {
  id: number;
  provider?: string;
  model: string;
  openai_api_key?: string | null;
  retellai_api_key?: string | null;
  retellai_agent_id?: string | null;
  medical_instructions?: string | null;
  voice: string;
  temperature: number;
  max_response_length: number;
  updated_at: Date;
}

export interface ConversationLog {
    id: number;
    session_id: string;
    timestamp?: Date; // Made optional for backward compatibility with existing code
    speaker: string;
    message: string;
    audio_data?: string | null;
}

export interface FhirResource {
    id: number;
    session_id: string;
    resource_type: string;
    resource_id?: string | null;
    resource_data: string;
    created_at: Date;
}

export interface IntakeResponse {
    id: number;
    session_id: string;
    question: string;
    answer: string;
    category: string;
    timestamp: Date;
}

export interface Patient {
  id: number;
  phone?: string;          // decrypted for reads; matched via phone_hash
  name?: string;
  age?: string;
  visit_count: number;
  medical_summary?: string;
  first_visit_at?: Date;
  last_visit_at?: Date;
}

// A shareable, single-patient remote intake link. The `token` is the unguessable URL secret.
export interface IntakeLink {
  id: string;
  token: string;
  created_by?: string | null;
  patient_id?: number | null;
  patient_name?: string | null;   // encrypted at rest (PHI)
  phone?: string | null;          // encrypted at rest (PHI)
  phone_hash?: string | null;
  language: string;               // te-IN | hi-IN | en-IN
  status: string;                 // pending | in_progress | completed | revoked (expiry derived from expires_at)
  session_id?: string | null;
  expires_at?: Date | null;
  created_at?: Date;
  used_at?: Date | null;
  completed_at?: Date | null;
  // Derived/joined for list views (not stored columns):
  session_status?: string | null; // live status of the linked session
  has_report?: boolean;
}

export interface RedFlagEvent {
    id: number;
    session_id: string;
    symptoms: string;
    severity: string;
    timestamp: Date;
    resolved: boolean;
    clinician_notified: boolean;
    language?: string;        // joined from sessions (te-IN | hi-IN | en-IN) for the dashboard
}

export interface AuditLog {
    id: number;
    session_id?: string | null;
    user_id?: number | null;
    action: string;
    resource_type?: string | null;
    details?: string | null;
    ip_address?: string | null;
    user_agent?: string | null;
    timestamp: Date;
}

export interface SessionTokenUsage {
    session_id: string;
    model: string;
    input_audio_tokens: number;
    output_audio_tokens: number;
    text_input_tokens: number;
    text_output_tokens: number;
    input_audio_duration: number;
    output_audio_duration: number;
    estimated_cost: number;
    timestamp: Date;
}

export interface Report {
    id: number;
    session_id: string;
    report_content: string;
    generated_at: Date;
    cost: number | null;
    version: number;
    status?: string;          // 'pending' | 'approved'
    reviewed_by?: string | null;
    reviewed_at?: Date | null;
}

export interface User {
  id: string; // Actually uniqueidentifier/GUID in database
  username: string;
  email: string;
  password_hash: string;
  role: string;
  created_at: Date;
}

export interface LoginAttempt {
  user_id: number;
  successful: boolean;
  ip_address?: string;
  user_agent?: string;
}

// --------------------- SERVICE CLASS ---------------------
export class DataService {

    private async runQuery<T>(query: string): Promise<T[]> {
        const pool = await poolPromise;
        const result = await pool.request().query<T>(query);
        return result.recordset;
    }

    /** Lightweight DB connectivity check for health monitoring. */
    public async ping(): Promise<boolean> {
        try { await this.runQuery('SELECT 1 AS ok'); return true; }
        catch { return false; }
    }

    private async runQueryWithInput<T>(query: string, inputs: { name: string, type: any, value: any }[]): Promise<T[]> {
        const pool = await poolPromise;
        const request = pool.request();
        inputs.forEach(input => request.input(input.name, input.type, input.value));
        const result = await request.query<T>(query);
        return result.recordset;
    }

    private async runQueryWithInputByType<T>(query: string, inputs: { name: string; type: any; value: any }[]): Promise<T[]> {
        const pool = await poolPromise;
        const request = pool.request();
        inputs.forEach(input => request.input(input.name, input.type, input.value));
        const result = await request.query<T>(query);
        return result.recordset;
    }

    // --------------------- SESSIONS ---------------------
    public async getSession(sessionId: string): Promise<Session | null> {
        const cacheKey = `session:${sessionId}`;

        // Try cache first
        const cached = cacheService.get<Session>(cacheKey);
        if (cached) {
            return cached;
        }

        // Fetch from database
        const sessions = await this.runQueryWithInput<Session>(
            `SELECT *
            FROM sessions
            WHERE id = @id;`,
            [
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );

        if (!sessions) return null;
        const session = sessions.length > 0 ? sessions[0] : null;
        if (!session) return null;

        const result = {...session};
        result.patient_name = decryptField(result.patient_name);

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async getAllSessions(): Promise<Session[]> {
        const cacheKey = `${CACHE_PATTERNS.SESSIONS}:all`;

        // Try cache first
        const cached = cacheService.get<Session[]>(cacheKey);
        if (cached) {
            return cached;
        }

        // Fetch from database
        const result = await this.runQuery<Session>(`
      SELECT *
      FROM sessions
      ORDER BY start_time DESC
    `);
        decryptRows(result, 'patient_name');

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async getSessionsPaginated(page: number = 1, limit: number = 50, status?: string): Promise<{ sessions: Session[], total: number, totalPages: number, currentPage: number }> {
        const offset = (page - 1) * limit;

        // Get total count for pagination metadata
        let countQuery = 'SELECT COUNT(*) as count FROM sessions';
        let params: any[] = [];

        if (status) {
            countQuery += ' WHERE status = @status';
            params.push({ name: 'status', type: sql.VarChar(50), value: status });
        }

        const countResult = await this.runQueryWithInput<{ count: number }>(countQuery, params);
        const total = countResult[0]?.count || 0;
        const totalPages = Math.ceil(total / limit);

        // Get paginated sessions
        let dataQuery = `
            SELECT s.*, p.phone AS patient_phone
            FROM sessions s
            LEFT JOIN patients p ON s.patient_id = p.id
            WHERE 1=1
        `;

        const dataParams: any[] = [
            { name: 'offset', type: sql.Int, value: offset },
            { name: 'limit', type: sql.Int, value: limit }
        ];

        if (status) {
            dataQuery += ' AND s.status = @status';
            dataParams.push({ name: 'status', type: sql.VarChar(50), value: status });
        }

        dataQuery += ' ORDER BY s.start_time DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY';

        const sessions = await this.runQueryWithInput<Session>(dataQuery, dataParams);
        decryptRows(sessions, 'patient_name');
        decryptRows(sessions, 'patient_phone');   // patient phone is stored encrypted on the patients table

        // Cache each session individually for future lookups (already decrypted)
        sessions.forEach(session => {
            const sessionCacheKey = `session:${session.id}`;
            cacheService.set(sessionCacheKey, session);
        });

        return {
            sessions,
            total,
            totalPages,
            currentPage: page
        };
    }

    public async getSessionCounts(): Promise<{ totalSessions: number, completedToday: number }> {
        const cacheKey = `${CACHE_PATTERNS.SESSION_COUNTS}`;

        // Try cache first
        const cached = cacheService.get<{ totalSessions: number, completedToday: number }>(cacheKey);
        if (cached) {
            return cached;
        }

        // Fetch from database
        const totalResult = await this.runQuery<{ count: number }>(`
            SELECT COUNT(*) as count FROM sessions
        `);
        const totalSessions = totalResult[0]?.count || 0;

        const todayResult = await this.runQuery<{ count: number }>(`
            SELECT COUNT(*) as count FROM sessions
            WHERE CAST(start_time AS DATE) = CAST(GETDATE() AS DATE)
        `);
        const completedToday = todayResult[0]?.count || 0;

        const result = { totalSessions, completedToday };

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async generateIntakeReport(sessionId: string) {
        const session = await this.getSession(sessionId);

        const conversationLogs = await this.getSessionConversationLogs(sessionId);
        //const fhirResources = await this.getAllFhirResourcesBySession(sessionId);
        const intakeResponses = await this.getAllIntakeResponsesBySession(sessionId);
        const redFlags = await this.getRedFlagEvents(sessionId);

        return {
            sessionId,
            timestamp: new Date(),
            status: session?.status,
            duration: session?.end_time ? Number(new Date(session.end_time)) - Number(new Date(session.start_time)) : 0,
            redFlagsDetected: redFlags.length,
            conversationSummary: this.summarizeConversation(conversationLogs),
            intakeData: this.organizeIntakeData(intakeResponses),
            redFlags,
            auditTrail: await this.getAllAuditLogsBySession(sessionId)
        };
    }

    public async getActiveSessions(): Promise<Session[]> {
        const cacheKey = `${CACHE_PATTERNS.DASHBOARD_SUMMARY}:active-sessions`;

        // Try cache first
        const cached = cacheService.get<Session[]>(cacheKey);
        if (cached) {
            return cached;
        }

        // Fetch from database
        const result = await this.runQuery<Session>(`
      SELECT *
      FROM sessions
      WHERE status IN ('active', 'paused') AND start_time > DATEADD(HOUR, -24, GETDATE())
      ORDER BY start_time DESC
    `);
        decryptRows(result, 'patient_name');

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async createSession(session: Omit<Session, 'id' | 'created_at'>): Promise<Session> {
      const result = await this.runQueryWithInputByType<Session>(
        `INSERT INTO sessions (patient_id, patient_name, provider, language, status, start_time, end_time, red_flags_detected, source, created_at)
        OUTPUT INSERTED.*
        VALUES (@patient_id, @patient_name, @provider, @language, @status, @start_time, @end_time, @red_flags_detected, @source, GETDATE())`,
        [
          { name: 'patient_id', type: sql.BigInt, value: session.patient_id || null },
          { name: 'patient_name', type: sql.VarChar(250), value: encryptField(session.patient_name) || null },
          { name: 'provider', type: sql.VarChar(50), value: session.provider || null },
          { name: 'language', type: sql.VarChar(10), value: session.language || null },
          { name: 'status', type: sql.VarChar(50), value: session.status },
          { name: 'start_time', type: sql.DateTime, value: session.start_time },
          { name: 'end_time', type: sql.DateTime, value: session.end_time ?? null },
          { name: 'red_flags_detected', type: sql.Int, value: session.red_flags_detected },
          { name: 'source', type: sql.VarChar(20), value: session.source || 'staff' }
        ]
      );

        // Invalidate cache for sessions and counts
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSIONS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSION_COUNTS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.DASHBOARD_SUMMARY);

        if (result[0]) result[0].patient_name = decryptField(result[0].patient_name);
        return result[0]; // first (and only) inserted row
    }

    /** Record that the patient gave consent for this intake session. */
    public async recordConsent(sessionId: string): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE sessions SET consent_given = @consent, consent_at = GETDATE() WHERE id = @id`,
            [
                { name: 'consent', type: sql.Bit, value: true },
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSIONS);
        cacheService.delete(`session:${sessionId}`);
    }

    public async updateSessionRedFlagCount(sessionId: string): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE sessions SET red_flags_detected = red_flags_detected + 1 WHERE id = @id`,
            [
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );

        // Invalidate cache for sessions and related data
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSIONS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSION_COUNTS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.DASHBOARD_SUMMARY);
    }

    public async updateSessionStatus(sessionId: string, status: string): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE sessions SET status = @status, end_time = CASE WHEN @status = 'completed' THEN CURRENT_TIMESTAMP ELSE end_time END WHERE id = @id`,
            [
                { name: 'status', type: sql.VarChar(50), value: status },
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );

        // Invalidate cache for sessions and related data
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSIONS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSION_COUNTS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.DASHBOARD_SUMMARY);
        cacheService.invalidateByPattern(`${CACHE_PATTERNS.LOGS}:${sessionId}`);
        cacheService.invalidateByPattern(`${CACHE_PATTERNS.TRANSCRIPT}:${sessionId}`);
    }

    public async updateSessionPatientName(sessionId: string, patientName: string): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE sessions SET patient_name = @patient_name WHERE id = @id`,
            [
                { name: 'patient_name', type: sql.VarChar(250), value: encryptField(patientName) || null },
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );

        // Invalidate cache for sessions and related data
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSIONS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSION_COUNTS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.DASHBOARD_SUMMARY);
    }

    // ─── Patients: stored + recognized across visits (keyed by hashed phone/ID) ──────────
    public async findPatientByPhone(phone: string): Promise<Patient | null> {
        const hash = hashIdentifier(phone);
        if (!hash) return null;
        const rows = await this.runQueryWithInput<Patient>(
            `SELECT * FROM patients WHERE phone_hash = @hash`,
            [{ name: 'hash', type: sql.VarChar(64), value: hash }]
        );
        const p = rows[0];
        if (!p) return null;
        p.phone = decryptField(p.phone as any);
        p.name = decryptField(p.name as any);
        p.medical_summary = decryptField(p.medical_summary as any);
        return p;
    }

    public async createPatient(phone: string): Promise<Patient> {
        const rows = await this.runQueryWithInputByType<Patient>(
            `INSERT INTO patients (phone_hash, phone, visit_count) OUTPUT INSERTED.* VALUES (@hash, @phone, 0)`,
            [
                { name: 'hash', type: sql.VarChar(64), value: hashIdentifier(phone) },
                { name: 'phone', type: sql.VarChar(250), value: encryptField(phone) || null }
            ]
        );
        const p = rows[0];
        if (p) { p.phone = decryptField(p.phone as any); p.name = decryptField(p.name as any); }
        return p;
    }

    /** Mark that a (new or returning) visit is starting: bump the counter + last-seen time. */
    public async incrementPatientVisit(patientId: number): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE patients SET visit_count = visit_count + 1, last_visit_at = GETDATE(), updated_at = GETDATE() WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: patientId }]
        );
    }

    /** Fill the name only if we don't already have one — never overwrite a known name with a
     *  possibly-misheard one on a return visit. */
    public async updatePatientNameIfEmpty(patientId: number, name: string): Promise<void> {
        const rows = await this.runQueryWithInput<{ name: string }>(
            `SELECT name FROM patients WHERE id = @id`, [{ name: 'id', type: sql.BigInt, value: patientId }]
        );
        const existing = decryptField(rows[0]?.name as any);
        if (existing && String(existing).trim()) return;
        await this.runQueryWithInput(
            `UPDATE patients SET name = @name, updated_at = GETDATE() WHERE id = @id`,
            [
                { name: 'name', type: sql.VarChar(250), value: encryptField(name) || null },
                { name: 'id', type: sql.BigInt, value: patientId }
            ]
        );
    }

    public async updatePatientAge(patientId: number, age: string): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE patients SET age = @age, updated_at = GETDATE() WHERE id = @id`,
            [
                { name: 'age', type: sql.VarChar(50), value: age || null },
                { name: 'id', type: sql.BigInt, value: patientId }
            ]
        );
    }

    /** Append this visit's notes to the patient's rolling medical history (capped). */
    public async appendPatientMedicalSummary(patientId: number, entry: string): Promise<void> {
        if (!entry || !entry.trim()) return;
        const rows = await this.runQueryWithInput<{ medical_summary: string }>(
            `SELECT medical_summary FROM patients WHERE id = @id`, [{ name: 'id', type: sql.BigInt, value: patientId }]
        );
        const prev = decryptField(rows[0]?.medical_summary as any) || '';
        let combined = (prev ? prev + '\n\n' : '') + entry.trim();
        if (combined.length > 8000) combined = combined.slice(combined.length - 8000); // keep the most recent
        await this.runQueryWithInput(
            `UPDATE patients SET medical_summary = @s, updated_at = GETDATE() WHERE id = @id`,
            [
                { name: 's', type: sql.VarChar(sql.MAX), value: encryptField(combined) || null },
                { name: 'id', type: sql.BigInt, value: patientId }
            ]
        );
    }

    public async getPatientById(patientId: number): Promise<Patient | null> {
        const rows = await this.runQueryWithInput<Patient>(
            `SELECT * FROM patients WHERE id = @id`, [{ name: 'id', type: sql.BigInt, value: patientId }]
        );
        const p = rows[0];
        if (!p) return null;
        p.phone = decryptField(p.phone as any);
        p.name = decryptField(p.name as any);
        p.medical_summary = decryptField(p.medical_summary as any);
        return p;
    }

    /** Paginated patient directory (most recently seen first), without the bulky history. */
    public async getPatientsPaginated(page = 1, limit = 25): Promise<{ patients: Patient[], total: number, totalPages: number, currentPage: number }> {
        const offset = (page - 1) * limit;
        const countResult = await this.runQuery<{ count: number }>('SELECT COUNT(*) as count FROM patients');
        const total = countResult[0]?.count || 0;

        const patients = await this.runQueryWithInput<Patient>(
            `SELECT id, phone, name, age, visit_count, first_visit_at, last_visit_at FROM patients
             ORDER BY last_visit_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
            [
                { name: 'offset', type: sql.Int, value: offset },
                { name: 'limit', type: sql.Int, value: limit }
            ]
        );
        decryptRows(patients, 'name');
        decryptRows(patients, 'phone');
        return { patients, total, totalPages: Math.ceil(total / limit), currentPage: page };
    }

    /** All sessions (visits) for one patient, newest first. */
    public async getSessionsByPatientId(patientId: number): Promise<Session[]> {
        const sessions = await this.runQueryWithInput<Session>(
            `SELECT * FROM sessions WHERE patient_id = @pid ORDER BY start_time DESC`,
            [{ name: 'pid', type: sql.BigInt, value: patientId }]
        );
        decryptRows(sessions, 'patient_name');
        return sessions;
    }

    public async deleteSession(sessionId: string): Promise<void> {
        // Remember which patient this session (visit) belonged to, so we can reconcile their
        // record afterwards — deleting a session must also remove that visit from the patient.
        const owner = await this.runQueryWithInput<{ patient_id: number }>(
            `SELECT patient_id FROM sessions WHERE id = @id`,
            [{ name: 'id', type: sql.VarChar, value: sessionId }]
        ).catch(() => [] as { patient_id: number }[]);
        const patientId = Number(owner?.[0]?.patient_id) || 0;

        // Remove the session AND all its dependent rows (no FK cascade in this schema).
        const childTables = ['conversation_logs', 'red_flag_events', 'intake_responses', 'reports', 'session_token_usage', 'fhir_resources'];
        for (const t of childTables) {
            await this.runQueryWithInput(
                `DELETE FROM ${t} WHERE session_id = @id`,
                [{ name: 'id', type: sql.VarChar, value: sessionId }]
            ).catch(() => { /* table/col may not exist on older schemas */ });
        }
        await this.runQueryWithInput(
            `DELETE FROM sessions WHERE id = @id`,
            [{ name: 'id', type: sql.VarChar, value: sessionId }]
        );

        // The patient's visit LIST already reads live from `sessions`, but their cached
        // aggregates (visit_count / first_visit_at / last_visit_at) must be recomputed so the
        // deleted visit also disappears from the patient's record and counts.
        if (patientId > 0) await this.reconcilePatientAggregates(patientId);

        this.invalidateSessionCaches(sessionId);
    }

    /** Recompute a patient's visit_count / first_visit_at / last_visit_at from the sessions they
     *  still have, so deleting a session keeps the patient record consistent (no orphan visits). */
    private async reconcilePatientAggregates(patientId: number): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE patients
                SET visit_count    = (SELECT COUNT(*)        FROM sessions WHERE patient_id = @pid),
                    first_visit_at = (SELECT MIN(start_time) FROM sessions WHERE patient_id = @pid),
                    last_visit_at  = (SELECT MAX(start_time) FROM sessions WHERE patient_id = @pid),
                    updated_at     = GETDATE()
              WHERE id = @pid`,
            [{ name: 'pid', type: sql.BigInt, value: patientId }]
        ).catch((e: any) => console.error('reconcile patient aggregates failed:', e?.message || e));
    }

    /** Admin: delete a patient AND all of their sessions/visits and dependent rows. */
    public async deletePatient(patientId: number): Promise<void> {
        // Drop dependent rows for every session this patient owns, then the sessions, then the
        // patient (no FK cascade in this schema). The IN-subquery is dialect-safe.
        const childTables = ['conversation_logs', 'red_flag_events', 'intake_responses', 'reports', 'session_token_usage', 'fhir_resources'];
        for (const t of childTables) {
            await this.runQueryWithInput(
                `DELETE FROM ${t} WHERE session_id IN (SELECT id FROM sessions WHERE patient_id = @pid)`,
                [{ name: 'pid', type: sql.BigInt, value: patientId }]
            ).catch(() => { /* table/col may not exist on older schemas */ });
        }
        await this.runQueryWithInput(
            `DELETE FROM sessions WHERE patient_id = @pid`,
            [{ name: 'pid', type: sql.BigInt, value: patientId }]
        );
        await this.runQueryWithInput(
            `DELETE FROM patients WHERE id = @pid`,
            [{ name: 'pid', type: sql.BigInt, value: patientId }]
        );
        // Their sessions are gone too, so refresh the session/dashboard caches.
        this.invalidateSessionCaches();
    }

    /** Admin: delete ALL session data (keeps patients/users/settings). Returns rows removed. */
    public async deleteAllSessions(): Promise<number> {
        const before = await this.runQuery<{ c: number }>(`SELECT COUNT(*) AS c FROM sessions`);
        const removed = before[0]?.c || 0;
        const tables = ['conversation_logs', 'red_flag_events', 'intake_responses', 'reports', 'session_token_usage', 'fhir_resources', 'sessions'];
        for (const t of tables) {
            await this.runQuery(`DELETE FROM ${t}`).catch(() => { /* ignore missing tables */ });
        }
        // Patients are kept, but with no sessions left their visit aggregates must reset too.
        await this.runQuery(
            `UPDATE patients SET visit_count = 0, first_visit_at = NULL, last_visit_at = NULL, updated_at = GETDATE()`
        ).catch(() => { /* patients table may not exist on older schemas */ });
        this.invalidateSessionCaches();
        return removed;
    }

    private invalidateSessionCaches(sessionId?: string): void {
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSIONS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSION_COUNTS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.DASHBOARD_SUMMARY);
        cacheService.invalidateByPattern(CACHE_PATTERNS.RED_FLAGS);
        if (sessionId) {
            cacheService.invalidateByPattern(`${CACHE_PATTERNS.LOGS}:${sessionId}`);
            cacheService.invalidateByPattern(`${CACHE_PATTERNS.TRANSCRIPT}:${sessionId}`);
            cacheService.invalidateByPattern(`${CACHE_PATTERNS.RED_FLAGS}:${sessionId}`);
            cacheService.delete(`session:${sessionId}`);
        }
    }

    // --------------------- INTAKE LINKS (remote patient self-service) ---------------------
    /** Create a shareable intake link. `token` is the unguessable URL secret; name/phone are
     *  encrypted at rest. `expires_at` is computed by the caller (created_at + 24h). */
    public async createIntakeLink(link: {
        token: string;
        created_by?: string | null;
        patient_id?: number | null;
        patient_name?: string | null;
        phone?: string | null;
        language: string;
        expires_at: Date;
    }): Promise<IntakeLink> {
        const rows = await this.runQueryWithInputByType<IntakeLink>(
            `INSERT INTO intake_links (token, created_by, patient_id, patient_name, phone, phone_hash, language, status, expires_at, created_at)
             OUTPUT INSERTED.*
             VALUES (@token, @created_by, @patient_id, @patient_name, @phone, @phone_hash, @language, 'pending', @expires_at, GETDATE())`,
            [
                { name: 'token', type: sql.VarChar(128), value: link.token },
                { name: 'created_by', type: sql.VarChar(250), value: link.created_by ?? null },
                { name: 'patient_id', type: sql.BigInt, value: link.patient_id || null },
                { name: 'patient_name', type: sql.VarChar(250), value: encryptField(link.patient_name ?? null) ?? null },
                { name: 'phone', type: sql.VarChar(250), value: encryptField(link.phone ?? null) ?? null },
                { name: 'phone_hash', type: sql.VarChar(64), value: hashIdentifier(link.phone ?? null) },
                { name: 'language', type: sql.VarChar(10), value: link.language },
                { name: 'expires_at', type: sql.DateTime, value: link.expires_at }
            ]
        );
        const row = rows[0];
        if (row) { row.patient_name = decryptField(row.patient_name as any); row.phone = decryptField(row.phone as any); }
        return row;
    }

    public async getIntakeLinkByToken(token: string): Promise<IntakeLink | null> {
        const rows = await this.runQueryWithInput<IntakeLink>(
            `SELECT * FROM intake_links WHERE token = @token`,
            [{ name: 'token', type: sql.VarChar(128), value: token }]
        );
        const row = rows[0];
        if (!row) return null;
        row.patient_name = decryptField(row.patient_name as any);
        row.phone = decryptField(row.phone as any);
        return row;
    }

    public async getIntakeLinkById(id: string): Promise<IntakeLink | null> {
        const rows = await this.runQueryWithInput<IntakeLink>(
            `SELECT * FROM intake_links WHERE id = @id`,
            [{ name: 'id', type: sql.VarChar(64), value: id }]
        );
        const row = rows[0];
        if (!row) return null;
        row.patient_name = decryptField(row.patient_name as any);
        row.phone = decryptField(row.phone as any);
        return row;
    }

    /** Admin list — newest first, with the linked session's live status and whether a report
     *  exists (scalar subquery avoids row duplication if a session ever has multiple reports). */
    public async getIntakeLinksPaginated(page = 1, limit = 25): Promise<{ links: IntakeLink[], total: number, totalPages: number, currentPage: number }> {
        const offset = (page - 1) * limit;
        const countResult = await this.runQuery<{ count: number }>('SELECT COUNT(*) as count FROM intake_links');
        const total = countResult[0]?.count || 0;

        const links = await this.runQueryWithInput<IntakeLink>(
            `SELECT l.*, s.status AS session_status,
                    (SELECT COUNT(*) FROM reports r WHERE r.session_id = l.session_id) AS has_report
             FROM intake_links l
             LEFT JOIN sessions s ON s.id = l.session_id
             ORDER BY l.created_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
            [
                { name: 'offset', type: sql.Int, value: offset },
                { name: 'limit', type: sql.Int, value: limit }
            ]
        );
        decryptRows(links, 'patient_name');
        decryptRows(links, 'phone');
        links.forEach(l => { (l as any).has_report = Number((l as any).has_report) > 0; });
        return { links, total, totalPages: Math.ceil(total / limit), currentPage: page };
    }

    /** Patient started the intake: bind the created session and flip to in_progress. */
    public async setIntakeLinkSession(id: string, sessionId: string): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE intake_links SET session_id = @session_id, status = 'in_progress', used_at = GETDATE() WHERE id = @id`,
            [
                { name: 'session_id', type: sql.VarChar, value: sessionId },
                { name: 'id', type: sql.VarChar(64), value: id }
            ]
        );
    }

    /** Permanently remove an intake-link record. Does NOT touch the linked session / intake
     *  data — that lives in `sessions` and the patient record and is kept. */
    public async deleteIntakeLink(id: string): Promise<void> {
        await this.runQueryWithInput(
            `DELETE FROM intake_links WHERE id = @id`,
            [{ name: 'id', type: sql.VarChar(64), value: id }]
        );
    }

    /** Set link status ('completed' | 'revoked' | ...). Stamps completed_at on completion. */
    public async setIntakeLinkStatus(id: string, status: string): Promise<void> {
        await this.runQueryWithInput(
            `UPDATE intake_links SET status = @status, completed_at = CASE WHEN @status = 'completed' THEN GETDATE() ELSE completed_at END WHERE id = @id`,
            [
                { name: 'status', type: sql.VarChar(50), value: status },
                { name: 'id', type: sql.VarChar(64), value: id }
            ]
        );
    }

    // --------------------- SETTINGS ---------------------
    public async getAllSettings(): Promise<Setting[]> {
        const cacheKey = `${CACHE_PATTERNS.SETTINGS}:all`;

        // Try cache first
        const cached = cacheService.get<Setting[]>(cacheKey);
        if (cached) {
            return cached;
        }

        // Fetch from database
        const result = await this.runQuery<Setting>(`SELECT * FROM settings WHERE id = 1`);

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async getRecentSettings(): Promise<Setting[]> {
        return this.runQuery<Setting>(`
      SELECT * FROM settings WHERE updated_at > DATEADD(HOUR, -24, GETDATE()) ORDER BY updated_at DESC
    `);
    }

    public async saveSettings(setting: Partial<Setting> & { id?: number }): Promise<void> {
      const temperature: number = Number(setting.temperature ?? 0.6);
      const maxLength: number = Number(setting.max_response_length ?? 200);
      // If ID exists, update. Otherwise, insert
      if (setting.id) {
        // Update existing settings
        const setClauses = [
          "provider = @provider",
          "model = @model",
          "openai_api_key = @openai_api_key",
          "retellai_api_key = @retellai_api_key",
          "retellai_agent_id = @retellai_agent_id",
          "medical_instructions = @medical_instructions",
          "voice = @voice",
          "temperature = @temperature",
          "max_response_length = @max_response_length",
          "updated_at = GETDATE()"
        ].join(", ");

        const inputs = [
          { name: "id", type: sql.BigInt, value: setting.id },
          { name: "provider", type: sql.VarChar(250), value: setting.provider ?? "openai" },
          { name: "model", type: sql.VarChar(250), value: setting.model ?? "gpt-4o-realtime-preview" },
          { name: "openai_api_key", type: sql.VarChar(sql.MAX), value: setting.openai_api_key ?? null },
          { name: "retellai_api_key", type: sql.VarChar(sql.MAX), value: setting.retellai_api_key ?? null },
          { name: "retellai_agent_id", type: sql.VarChar(250), value: setting.retellai_agent_id ?? null },
          { name: "medical_instructions", type: sql.VarChar(sql.MAX), value: setting.medical_instructions ?? null },
          { name: "voice", type: sql.VarChar(250), value: setting.voice ?? "alloy" },
          { name: "temperature", type: sql.Decimal(5, 1), value: temperature },
          { name: "max_response_length", type: sql.BigInt, value: maxLength }
        ];

        await this.runQueryWithInput(
          `UPDATE settings SET ${setClauses} WHERE id = @id`,
          inputs
        );

      } else {
        // Insert new settings
        const newId = Date.now(); // or generate a proper unique ID/UUID

        const inputs = [
          { name: "id", type: sql.BigInt, value: newId },
          { name: "provider", type: sql.VarChar(250), value: setting.provider ?? "openai" },
          { name: "model", type: sql.VarChar(250), value: setting.model ?? "gpt-4o-realtime-preview" },
          { name: "openai_api_key", type: sql.VarChar(sql.MAX), value: setting.openai_api_key ?? null },
          { name: "retellai_api_key", type: sql.VarChar(sql.MAX), value: setting.retellai_api_key ?? null },
          { name: "retellai_agent_id", type: sql.VarChar(250), value: setting.retellai_agent_id ?? null },
          { name: "medical_instructions", type: sql.VarChar(sql.MAX), value: setting.medical_instructions ?? null },
          { name: "voice", type: sql.VarChar(250), value: setting.voice ?? "alloy" },
          { name: "temperature", type: sql.Decimal(5, 1), value: temperature },
          { name: "max_response_length", type: sql.BigInt, value: maxLength }
        ];

        await this.runQueryWithInput(
          `INSERT INTO settings (id, provider, model, openai_api_key, retellai_api_key, retellai_agent_id, medical_instructions, voice, temperature, max_response_length, updated_at)
        VALUES (@id, @provider, @model, @openai_api_key, @retellai_api_key, @retellai_agent_id, @medical_instructions, @voice, @temperature, @max_response_length, GETDATE())`,
          inputs
        );
      }

        // Invalidate settings cache
        cacheService.invalidateByPattern(CACHE_PATTERNS.SETTINGS);
    }

    public async updateSetting(setting: Partial<Setting> & { id: number }): Promise<void> {
        const setClauses = Object.entries(setting)
            .filter(([key]) => key !== 'id')
            .map(([key]) => `${key} = @${key}`)
            .join(', ');

        const inputs = Object.entries(setting)
            .map(([key, value]) => ({ name: key, type: sql.VarChar, value }));

        await this.runQueryWithInput(
            `UPDATE settings SET ${setClauses} WHERE id = @id`,
            inputs
        );

        // Invalidate settings cache
        cacheService.invalidateByPattern(CACHE_PATTERNS.SETTINGS);
    }

    // --------------------- CONVERSATION LOGS ---------------------
    public async getSessionConversationLogs(sessionId: string): Promise<ConversationLog[]> {
        const cacheKey = `${CACHE_PATTERNS.LOGS}:${sessionId}`;

        // Try cache first
        const cached = cacheService.get<ConversationLog[]>(cacheKey);
        if (cached) {
            return cached;
        }

        // Fetch from database - convert varbinary audio_data back to varchar for JSON parsing
        const result = await this.runQueryWithInput<ConversationLog>(
            `SELECT id, session_id, timestamp, speaker, message,
                    CASE WHEN audio_data IS NOT NULL THEN CONVERT(varchar(max), audio_data) ELSE NULL END as audio_data
             FROM conversation_logs
             WHERE session_id = @id
             ORDER BY timestamp ASC `,
            [
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );

        // Decrypt PHI (message) before caching/returning.
        decryptRows(result, 'message');

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async getRecentConversationLogs(): Promise<ConversationLog[]> {
        const rows = await this.runQuery<ConversationLog>(`
      SELECT * FROM conversation_logs WHERE timestamp > DATEADD(HOUR, -24, GETDATE()) ORDER BY timestamp DESC
    `);
        return decryptRows(rows, 'message');
    }

    // FIXED: Now accepts optional timestamp parameter to preserve chronological ordering (backward compatible)
    public async saveConversationLog(log: Omit<ConversationLog, 'id'>): Promise<void> {
        // Use provided timestamp or current time for backward compatibility
        const timestampToUse = log.timestamp ?? new Date();

        await this.runQueryWithInput(
            `INSERT INTO conversation_logs (session_id, speaker, message, audio_data, timestamp)
        VALUES (@session_id, @speaker, @message, CONVERT(varbinary(max), @audio_data), @timestamp)`,
            [
                { name: 'session_id', type: sql.VarChar, value: log.session_id },
                { name: 'speaker', type: sql.VarChar(250), value: log.speaker },
                { name: 'message', type: sql.VarChar(sql.MAX), value: encryptField(log.message) },
                { name: 'audio_data', type: sql.VarChar(sql.MAX), value: log.audio_data || null },
                { name: 'timestamp', type: sql.DateTime, value: timestampToUse } // ✅ Uses provided timestamp or defaults to current time
            ]
        );

        // Invalidate cache for conversation logs of this session
        cacheService.invalidateByPattern(`${CACHE_PATTERNS.LOGS}:${log.session_id}`);
        cacheService.invalidateByPattern(`${CACHE_PATTERNS.TRANSCRIPT}:${log.session_id}`);
    }

    public async deleteConversationLog(logId: number): Promise<void> {
        // First get the session ID to invalidate cache properly
        const logs = await this.runQueryWithInput<ConversationLog>(
            `SELECT session_id FROM conversation_logs WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: logId }]
        );

        await this.runQueryWithInput(
            `DELETE FROM conversation_logs WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: logId }]
        );

        // Invalidate cache if we found the log
        if (logs && logs.length > 0) {
            const sessionId = logs[0].session_id;
            cacheService.invalidateByPattern(`${CACHE_PATTERNS.LOGS}:${sessionId}`);
            cacheService.invalidateByPattern(`${CACHE_PATTERNS.TRANSCRIPT}:${sessionId}`);
        }
    }

    // --------------------- RED FLAG EVENTS ---------------------
    public async getAllRedFlagEvents(): Promise<RedFlagEvent[]> {
        const cacheKey = `${CACHE_PATTERNS.RED_FLAGS}:all`;

        // Try cache first
        const cached = cacheService.get<RedFlagEvent[]>(cacheKey);
        if (cached) {
            return cached;
        }

        // Fetch from database
        const result = await this.runQuery<RedFlagEvent>(`SELECT * FROM red_flag_events ORDER BY timestamp DESC`);
        decryptRows(result, 'symptoms');

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async getRedFlagEvents(sessionId: string): Promise<Session[]> {
        const cacheKey = `${CACHE_PATTERNS.RED_FLAGS}:${sessionId}`;

        // Try cache first
        const cached = cacheService.get<Session[]>(cacheKey);
        if (cached) {
            return cached;
        }

        // Fetch from database
        const result = await this.runQueryWithInput<Session>(
            `SELECT * FROM red_flag_events WHERE session_id =  @id;`,
            [
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );
        decryptRows(result, 'symptoms');

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async getRecentRedFlagEvents(hoursBack: number = 24): Promise<RedFlagEvent[]> {
        const cacheKey = `${CACHE_PATTERNS.RED_FLAGS}:recent_${hoursBack}hrs`;

        // Try cache first
        const cached = cacheService.get<RedFlagEvent[]>(cacheKey);
        if (cached) {
            return cached;
        }

        // Query recent red flag events directly (much more efficient than loading all sessions),
        // joining the session to surface its language for the dashboard.
        const result = await this.runQuery<RedFlagEvent>(`
            SELECT r.*, s.language AS language FROM red_flag_events r
            LEFT JOIN sessions s ON s.id = r.session_id
            WHERE r.timestamp > DATEADD(HOUR, -${hoursBack}, GETDATE())
            ORDER BY r.timestamp DESC
        `);
        decryptRows(result, 'symptoms');

        // Cache the result for 5 minutes
        cacheService.set(cacheKey, result, 5 * 60 * 1000);
        return result;
    }

    public async getRedFlagEventsCount(hoursBack: number = 24): Promise<number> {
        const cacheKey = `${CACHE_PATTERNS.RED_FLAGS}:count_${hoursBack}hrs`;

        // Try cache first
        const cached = cacheService.get<number>(cacheKey);
        if (cached !== null) {
            return cached;
        }

        const result = await this.runQuery<{
            count: number
        }>(`
            SELECT COUNT(*) as count FROM red_flag_events
            WHERE timestamp > DATEADD(HOUR, -${hoursBack}, GETDATE())
        `);

        const count = result[0]?.count || 0;
        cacheService.set(cacheKey, count, 5 * 60 * 1000);
        return count;
    }

    public async saveRedFlagEvent(event: Omit<RedFlagEvent, 'id' | 'timestamp'>): Promise<void> {
        await this.runQueryWithInput(
            `INSERT INTO red_flag_events (session_id, symptoms, severity, resolved, clinician_notified, timestamp)
       VALUES (@session_id, @symptoms, @severity, @resolved, @clinician_notified, GETDATE())`,
            [
                { name: 'session_id', type: sql.VarChar, value: event.session_id },
                { name: 'symptoms', type: sql.VarChar(250), value: encryptField(event.symptoms) },
                { name: 'severity', type: sql.VarChar(250), value: event.severity },
                { name: 'resolved', type: sql.Bit, value: event.resolved },
                { name: 'clinician_notified', type: sql.Bit, value: event.clinician_notified }
            ]
        );

        // Invalidate cache for red flags
        cacheService.invalidateByPattern(CACHE_PATTERNS.RED_FLAGS);
        cacheService.invalidateByPattern(`${CACHE_PATTERNS.RED_FLAGS}:${event.session_id}`);
    }

    public async deleteRedFlagEvent(eventId: number): Promise<void> {
        // First get the session ID to invalidate cache properly
        const events = await this.runQueryWithInput<RedFlagEvent>(
            `SELECT session_id FROM red_flag_events WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: eventId }]
        );

        await this.runQueryWithInput(
            `DELETE FROM red_flag_events WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: eventId }]
        );

        // Invalidate cache if we found the event
        if (events && events.length > 0) {
            const sessionId = events[0].session_id;
            cacheService.invalidateByPattern(CACHE_PATTERNS.RED_FLAGS);
            cacheService.invalidateByPattern(`${CACHE_PATTERNS.RED_FLAGS}:${sessionId}`);
        }
    }

    // --------------------- AUDIT LOGS ---------------------
    public async getAllAuditLogs(): Promise<AuditLog[]> {
        return this.runQuery<AuditLog>(`SELECT * FROM audit_logs ORDER BY timestamp DESC`);
    }

    public async getAllAuditLogsBySession(sessionId: string): Promise<Session[]> {
        return await this.runQueryWithInput<Session>(
            `SELECT * FROM audit_logs WHERE session_id =  @id;`,
            [
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );
    }

    public async getRecentAuditLogs(): Promise<AuditLog[]> {
        return this.runQuery<AuditLog>(`
      SELECT * FROM audit_logs WHERE timestamp > DATEADD(HOUR, -24, GETDATE()) ORDER BY timestamp DESC
    `);
    }

    public async insertAuditLog(log: Omit<AuditLog, 'id' | 'timestamp'>): Promise<void> {
        await this.runQueryWithInput(
            `INSERT INTO audit_logs (session_id, user_id, action, resource_type, details, ip_address, user_agent, timestamp)
       VALUES (@session_id, @user_id, @action, @resource_type, @details, @ip_address, @user_agent, GETDATE())`,
            [
                { name: 'session_id', type: sql.VarChar, value: log.session_id ?? null },
                { name: 'user_id', type: sql.BigInt, value: log.user_id ?? null },
                { name: 'action', type: sql.VarChar(250), value: log.action },
                { name: 'resource_type', type: sql.VarChar(250), value: log.resource_type ?? null },
                { name: 'details', type: sql.VarChar(sql.MAX), value: log.details ?? null },
                { name: 'ip_address', type: sql.VarChar(250), value: log.ip_address ?? null },
                { name: 'user_agent', type: sql.VarChar(250), value: log.user_agent ?? null }
            ]
        );

        // Invalidate audit log caches
        cacheService.invalidateByPattern('audit-logs');
    }

    public async deleteAuditLog(logId: number): Promise<void> {
        await this.runQueryWithInput(
            `DELETE FROM audit_logs WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: logId }]
        );

        // Invalidate audit log caches
        cacheService.invalidateByPattern('audit-logs');
    }

    // --------------------- FHIR RESOURCES ---------------------

    // CREATE
    public async createFhirResource(resource: Omit<FhirResource, 'id' | 'created_at'>): Promise<void> {
        await this.runQueryWithInput(
            `INSERT INTO fhir_resources (session_id, resource_type, resource_id, resource_data, created_at)
       VALUES (@session_id, @resource_type, @resource_id, @resource_data, GETDATE())`,
            [
                { name: 'session_id', type: sql.VarChar, value: resource.session_id },
                { name: 'resource_type', type: sql.VarChar(250), value: resource.resource_type },
                { name: 'resource_id', type: sql.VarChar(250), value: resource.resource_id ?? null },
                { name: 'resource_data', type: sql.VarChar(250), value: resource.resource_data },
            ]
        );

        // Invalidate FHIR resource caches
        cacheService.invalidateByPattern('fhir-resources');
    }

    // READ all
    public async getAllFhirResources(): Promise<FhirResource[]> {
        return this.runQuery<FhirResource>(`SELECT * FROM fhir_resources ORDER BY created_at DESC`);
    }

    public async getAllFhirResourcesBySession(sessionId: string): Promise<Session[]> {
        return await this.runQueryWithInput<Session>(
            `SELECT * FROM fhir_resources WHERE session_id =  @id;`,
            [
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );
    }

    // READ by ID
    public async getFhirResource(id: number): Promise<FhirResource | null> {
        const result = await this.runQueryWithInput<FhirResource>(
            `SELECT * FROM fhir_resources WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: id }]
        );
        return result.length > 0 ? result[0] : null;
    }

    // UPDATE
    public async updateFhirResource(resource: Partial<FhirResource> & { id: number }): Promise<void> {
        const setClauses = Object.entries(resource)
            .filter(([key]) => key !== 'id')
            .map(([key]) => `${key} = @${key}`)
            .join(', ');

        const inputs = Object.entries(resource)
            .map(([key, value]) => ({ name: key, type: sql.VarChar, value }));

        await this.runQueryWithInput(
            `UPDATE fhir_resources SET ${setClauses} WHERE id = @id`,
            inputs
        );

        // Invalidate FHIR resource caches
        cacheService.invalidateByPattern('fhir-resources');
    }

    // DELETE
    public async deleteFhirResource(id: number): Promise<void> {
        await this.runQueryWithInput(
            `DELETE FROM fhir_resources WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: id }]
        );

        // Invalidate FHIR resource caches
        cacheService.invalidateByPattern('fhir-resources');
    }

    // --------------------- REPORTS ---------------------
    public async getReport(sessionId: string): Promise<Report | null> {
        const result = await this.runQueryWithInput<Report>(
            `SELECT * FROM reports WHERE session_id = @session_id`,
            [{ name: 'session_id', type: sql.VarChar, value: sessionId }]
        );
        if (result.length === 0) return null;
        result[0].report_content = decryptField(result[0].report_content);
        return result[0];
    }

    public async saveReport(report: Omit<Report, 'id'>): Promise<void> {
        await this.runQueryWithInput(
            `INSERT INTO reports (session_id, report_content, generated_at, cost, version)
             VALUES (@session_id, @report_content, @generated_at, @cost, @version)`,
            [
                { name: 'session_id', type: sql.VarChar, value: report.session_id },
                { name: 'report_content', type: sql.VarChar(sql.MAX), value: encryptField(report.report_content) },
                { name: 'generated_at', type: sql.DateTime, value: report.generated_at },
                { name: 'cost', type: sql.Decimal(10, 6), value: report.cost },
                { name: 'version', type: sql.Int, value: report.version }
            ]
        );
    }

    /** Doctor edits and/or approves a report. status: 'pending' | 'approved'. */
    public async reviewReport(sessionId: string, opts: { content?: string; status: string; reviewedBy: string }): Promise<void> {
        if (typeof opts.content === 'string') {
            await this.runQueryWithInput(
                `UPDATE reports SET report_content = @content, status = @status, reviewed_by = @reviewed_by, reviewed_at = GETDATE() WHERE session_id = @session_id`,
                [
                    { name: 'content', type: sql.VarChar(sql.MAX), value: encryptField(opts.content) },
                    { name: 'status', type: sql.VarChar(50), value: opts.status },
                    { name: 'reviewed_by', type: sql.VarChar(250), value: opts.reviewedBy },
                    { name: 'session_id', type: sql.VarChar, value: sessionId }
                ]
            );
        } else {
            await this.runQueryWithInput(
                `UPDATE reports SET status = @status, reviewed_by = @reviewed_by, reviewed_at = GETDATE() WHERE session_id = @session_id`,
                [
                    { name: 'status', type: sql.VarChar(50), value: opts.status },
                    { name: 'reviewed_by', type: sql.VarChar(250), value: opts.reviewedBy },
                    { name: 'session_id', type: sql.VarChar, value: sessionId }
                ]
            );
        }
    }

    // --------------------- INTAKE RESPONSES ---------------------

    // CREATE
    public async createIntakeResponse(response: Omit<IntakeResponse, 'id' | 'timestamp'>): Promise<void> {
        await this.runQueryWithInput(
            `INSERT INTO intake_responses (session_id, question, answer, category, timestamp)
       VALUES (@session_id, @question, @answer, @category, GETDATE())`,
            [
                { name: 'session_id', type: sql.VarChar, value: response.session_id },
                { name: 'question', type: sql.VarChar(250), value: response.question },
                { name: 'answer', type: sql.VarChar(8000), value: encryptField(response.answer) },
                { name: 'category', type: sql.VarChar(250), value: response.category }
            ]
        );

        // Invalidate intake response caches
        cacheService.invalidateByPattern('intake-responses');
    }

    // READ all
    public async getAllIntakeResponses(): Promise<IntakeResponse[]> {
        const rows = await this.runQuery<IntakeResponse>(`SELECT * FROM intake_responses ORDER BY timestamp DESC`);
        return decryptRows(rows, 'answer');
    }

    public async getAllIntakeResponsesBySession(sessionId: string): Promise<Session[]> {
        const rows = await this.runQueryWithInput<Session>(
            `SELECT * FROM intake_responses WHERE session_id =  @id;`,
            [
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );
        return decryptRows(rows, 'answer');
    }

    // READ by ID
    public async getIntakeResponse(id: number): Promise<IntakeResponse | null> {
        const result = await this.runQueryWithInput<IntakeResponse>(
            `SELECT * FROM intake_responses WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: id }]
        );
        if (result.length === 0) return null;
        result[0].answer = decryptField(result[0].answer);
        return result[0];
    }

    // UPDATE
    public async updateIntakeResponse(response: Partial<IntakeResponse> & { id: number }): Promise<void> {
        const setClauses = Object.entries(response)
            .filter(([key]) => key !== 'id')
            .map(([key]) => `${key} = @${key}`)
            .join(', ');

        const inputs = Object.entries(response)
            .map(([key, value]) => ({ name: key, type: sql.VarChar, value }));

        await this.runQueryWithInput(
            `UPDATE intake_responses SET ${setClauses} WHERE id = @id`,
            inputs
        );

        // Invalidate intake response caches
        cacheService.invalidateByPattern('intake-responses');
    }

    // DELETE
    public async deleteIntakeResponse(id: number): Promise<void> {
        await this.runQueryWithInput(
            `DELETE FROM intake_responses WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: id }]
        );

        // Invalidate intake response caches
        cacheService.invalidateByPattern('intake-responses');
    }

    public async registerUser(username: string, email: string, password: string, role: string = 'clinician') {
        const passwordHash = await bcrypt.hash(password, 10);

        await this.runQueryWithInput(
            `INSERT INTO users (username, email, password_hash, role) VALUES (@username, @email, @password_hash, @role)`,
            [
                { name: 'username', type: sql.VarChar(250), value: username },
                { name: 'email', type: sql.VarChar(250), value: email },
                { name: 'password_hash', type: sql.VarChar(500), value: passwordHash },
                { name: 'role', type: sql.VarChar(50), value: role }
            ]
        );
    }

    public async listUsers(): Promise<{ id: string; username: string; email: string; role: string; created_at: Date }[]> {
        return this.runQuery(`SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC`);
    }

    // --------------------- SESSION TOKEN USAGE ---------------------

    // Save session token usage when session ends
    public async saveSessionTokenUsage(usage: Omit<SessionTokenUsage, 'timestamp'>): Promise<void> {
        await this.runQueryWithInput(
            `INSERT INTO session_token_usage (session_id, model, input_audio_tokens, output_audio_tokens,
             text_input_tokens, text_output_tokens, input_audio_duration, output_audio_duration,
             estimated_cost, timestamp)
             VALUES (@session_id, @model, @input_audio_tokens, @output_audio_tokens,
             @text_input_tokens, @text_output_tokens, @input_audio_duration, @output_audio_duration,
             @estimated_cost, GETDATE())`,
            [
                { name: 'session_id', type: sql.VarChar, value: usage.session_id },
                { name: 'model', type: sql.VarChar(250), value: usage.model },
                { name: 'input_audio_tokens', type: sql.BigInt, value: usage.input_audio_tokens },
                { name: 'output_audio_tokens', type: sql.BigInt, value: usage.output_audio_tokens },
                { name: 'text_input_tokens', type: sql.BigInt, value: usage.text_input_tokens },
                { name: 'text_output_tokens', type: sql.BigInt, value: usage.text_output_tokens },
                { name: 'input_audio_duration', type: sql.Decimal(10, 2), value: usage.input_audio_duration },
                { name: 'output_audio_duration', type: sql.Decimal(10, 2), value: usage.output_audio_duration },
                { name: 'estimated_cost', type: sql.Decimal(18, 6), value: usage.estimated_cost }
            ]
        );
    }

    // Get all token usage records
    public async getAllSessionTokenUsage(): Promise<SessionTokenUsage[]> {
        return this.runQuery<SessionTokenUsage>(`SELECT * FROM session_token_usage ORDER BY timestamp DESC`);
    }

    // Get token usage for specific session
    public async getSessionTokenUsage(sessionId: string): Promise<SessionTokenUsage[]> {
        return this.runQueryWithInput<SessionTokenUsage>(
            `SELECT * FROM session_token_usage WHERE session_id = @session_id ORDER BY timestamp DESC`,
            [{ name: 'session_id', type: sql.VarChar, value: sessionId }]
        );
    }

    // Get token usage summary statistics
    public async getTokenUsageSummary(): Promise<{
        totalSessions: number;
        totalCost: number;
        averageCostPerSession: number;
        totalAudioTokens: number;
        totalTextTokens: number;
        costByModel: { model: string; cost: number }[];
    }> {
        const usage = await this.runQuery<{
            total_sessions: number;
            total_cost: number;
            avg_cost_per_session: number;
            total_audio_tokens: number;
            total_text_tokens: number;
        }>(`
            SELECT
                COUNT(DISTINCT session_id) as total_sessions,
                SUM(estimated_cost) as total_cost,
                AVG(estimated_cost) as avg_cost_per_session,
                SUM(input_audio_tokens + output_audio_tokens) as total_audio_tokens,
                SUM(text_input_tokens + text_output_tokens) as total_text_tokens
            FROM session_token_usage
        `);

        const costByModel = await this.runQuery<{ model: string; cost: number }>(`
            SELECT model, SUM(estimated_cost) as cost
            FROM session_token_usage
            GROUP BY model
            ORDER BY cost DESC
        `);

        return {
            totalSessions: usage[0]?.total_sessions || 0,
            totalCost: Math.round((usage[0]?.total_cost || 0) * 10000) / 10000,
            averageCostPerSession: Math.round((usage[0]?.avg_cost_per_session || 0) * 10000) / 10000,
            totalAudioTokens: usage[0]?.total_audio_tokens || 0,
            totalTextTokens: usage[0]?.total_text_tokens || 0,
            costByModel
        };
    }

    public async getTokenUsageForPeriod(startDate: Date, endDate: Date): Promise<{
        periodUsage: SessionTokenUsage[];
        periodSummary: {
            totalSessions: number;
            totalCost: number;
            modelsUsed: string[];
        };
    }> {
        const periodUsage = await this.runQueryWithInput<SessionTokenUsage>(
            `SELECT * FROM session_token_usage
             WHERE timestamp >= @start_date AND timestamp <= @end_date
             ORDER BY timestamp DESC`,
            [
                { name: 'start_date', type: sql.DateTime, value: startDate },
                { name: 'end_date', type: sql.DateTime, value: endDate }
            ]
        );

        const summary = await this.runQueryWithInput<{
            total_sessions: number;
            total_cost: number;
            models_used: string;
        }>(
            `SELECT
                COUNT(DISTINCT session_id) as total_sessions,
                SUM(estimated_cost) as total_cost,
                STRING_AGG(DISTINCT model, ',') as models_used
             FROM session_token_usage
             WHERE timestamp >= @start_date AND timestamp <= @end_date`,
            [
                { name: 'start_date', type: sql.DateTime, value: startDate },
                { name: 'end_date', type: sql.DateTime, value: endDate }
            ]
        );

        return {
            periodUsage,
            periodSummary: {
                totalSessions: summary[0]?.total_sessions || 0,
                totalCost: Math.round((summary[0]?.total_cost || 0) * 10000) / 10000,
                modelsUsed: summary[0]?.models_used ? summary[0].models_used.split(',') : []
            }
        };
    }

    // --------------------- USERS & AUTHENTICATION ---------------------
    public async loginUser(username: string, password: string, ip: string | undefined, userAgent: string) {
        // First find user by username only
        const users = await this.runQueryWithInputByType<User>(
            `SELECT * FROM users WHERE username = @username`,
            [
                { name: 'username', type: sql.VarChar(250), value: username }
            ]
        );

        const user = users[0];

        let successful = false;

        if (user) {
            // Passwords are ALWAYS verified against a bcrypt hash. No plaintext fallback.
            const isBcrypt = user.password_hash.startsWith('$2b$') || user.password_hash.startsWith('$2a$') || user.password_hash.startsWith('$2y$');
            const passwordMatch = isBcrypt ? await bcrypt.compare(password, user.password_hash) : false;

            if (passwordMatch) {
                successful = true;

                // Sign with the shared, env-provided secret (same one auth.ts verifies with).
                const token = jwt.sign(
                    { id: user.id, username: user.username, role: user.role },
                    getJwtSecret(),
                    { expiresIn: JWT_EXPIRES_IN as any }
                );

                // Save login history
                await this.runQueryWithInput(
                    `INSERT INTO user_logins (user_id, successful, ip_address, user_agent) VALUES (@user_id, @successful, @ip_address, @user_agent)`,
                    [
                        { name: 'user_id', type: sql.UniqueIdentifier, value: user.id },
                        { name: 'successful', type: sql.Bit, value: true },
                        { name: 'ip_address', type: sql.VarChar(50), value: ip },
                        { name: 'user_agent', type: sql.VarChar(250), value: userAgent }
                    ]
                );
                const userData = {
                    username: user.username,
                    email: user.email,
                    role: user.role
                };

                return { token, userData };
            } else {
                // Log failed attempt for wrong password
                await this.runQueryWithInput(
                    `INSERT INTO user_logins (user_id, successful, ip_address, user_agent) VALUES (@user_id, @successful, @ip_address, @user_agent)`,
                    [
                        { name: 'user_id', type: sql.UniqueIdentifier, value: user.id },
                        { name: 'successful', type: sql.Bit, value: false },
                        { name: 'ip_address', type: sql.VarChar(50), value: ip },
                        { name: 'user_agent', type: sql.VarChar(250), value: userAgent }
                    ]
                );
                throw new Error('Invalid username or password');
            }
        } else {
            throw new Error('Invalid username or password');
        }
    }

    private summarizeConversation(conversationLogs: ConversationLog[]) {
        const agentMessages = conversationLogs.filter(log => log.speaker === 'agent').length;
        const patientMessages = conversationLogs.filter(log => log.speaker === 'patient').length;
        const alerts = conversationLogs.filter(log => log.speaker === 'alert').length;

        const lastLog = conversationLogs[conversationLogs.length - 1];
        const firstLog = conversationLogs[0];
        const lastTimestamp = lastLog?.timestamp ? Number(new Date(lastLog.timestamp)) : null;
        const firstTimestamp = firstLog?.timestamp ? Number(new Date(firstLog.timestamp)) : null;

        return {
            totalExchanges: conversationLogs.length,
            agentStatements: agentMessages,
            patientStatements: patientMessages,
            alertsGenerated: alerts,
            duration: (firstTimestamp && lastTimestamp) ? lastTimestamp - firstTimestamp : 0
        };
    }

    private organizeIntakeData(intakeResponses: any[]) {
        const categories: { [key: string]: any[] } = {};
        intakeResponses.forEach(response => {
            if (!categories[response.category]) {
                categories[response.category] = [];
            }
            categories[response.category].push({
                question: response.question,
                answer: response.answer,
                timestamp: response.timestamp
            });
        });
        return categories;
    }

    // Database optimization methods
    public async createPerformanceIndexes(): Promise<void> {
        const indexes = [
            { name: 'IX_sessions_start_time_status', table: 'sessions', columns: 'start_time DESC, status' },
            { name: 'IX_sessions_status', table: 'sessions', columns: 'status' },
            { name: 'IX_conversation_logs_session_id_timestamp', table: 'conversation_logs', columns: 'session_id, timestamp' },
            { name: 'IX_red_flag_events_timestamp', table: 'red_flag_events', columns: 'timestamp DESC' }
        ];

        for (const index of indexes) {
            try {
                // SQLite creates the index only if it does not already exist.
                await this.runQuery(`CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table} (${index.columns})`);
                console.log(`✓ Index ensured: ${index.name}`);
            } catch (error: any) {
                console.error(`Failed to create index ${index.name}:`, error.message);
                // Continue with other indexes if one fails
            }
        }
    }
}

export default new DataService();
