import { sql, poolPromise } from "./dbconnection.js";
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import cacheService, { CACHE_PATTERNS } from './cache-service.js';

// Interfaces
export interface Session {
  id: string;
  patient_id: number;
  patient_name: string;
  provider?: string;
  status: string;
  start_time: Date;
  end_time?: Date | null;
  red_flags_detected: number;
  created_at: Date;
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

export interface RedFlagEvent {
    id: number;
    session_id: string;
    symptoms: string;
    severity: string;
    timestamp: Date;
    resolved: boolean;
    clinician_notified: boolean;
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

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
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

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async createSession(session: Omit<Session, 'id' | 'created_at'>): Promise<Session> {
      const result = await this.runQueryWithInputByType<Session>(
        `INSERT INTO sessions (patient_id, patient_name, provider, status, start_time, end_time, red_flags_detected, created_at)
        OUTPUT INSERTED.*
        VALUES (@patient_id, @patient_name, @provider, @status, @start_time, @end_time, @red_flags_detected, GETDATE())`,
        [
          { name: 'patient_id', type: sql.BigInt, value: session.patient_id || null },
          { name: 'patient_name', type: sql.VarChar(250), value: session.patient_name || null },
          { name: 'provider', type: sql.VarChar(50), value: session.provider || null },
          { name: 'status', type: sql.VarChar(50), value: session.status },
          { name: 'start_time', type: sql.DateTime, value: session.start_time },
          { name: 'end_time', type: sql.DateTime, value: session.end_time ?? null },
          { name: 'red_flags_detected', type: sql.Int, value: session.red_flags_detected }
        ]
      );

        // Invalidate cache for sessions and counts
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSIONS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSION_COUNTS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.DASHBOARD_SUMMARY);

        return result[0]; // first (and only) inserted row
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

    public async deleteSession(sessionId: string): Promise<void> {
        await this.runQueryWithInput(
            `DELETE FROM sessions WHERE id = @id`,
            [{ name: 'id', type: sql.VarChar, value: sessionId }]
        );

        // Invalidate cache for sessions and related data
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSIONS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.SESSION_COUNTS);
        cacheService.invalidateByPattern(CACHE_PATTERNS.DASHBOARD_SUMMARY);
        cacheService.invalidateByPattern(`${CACHE_PATTERNS.LOGS}:${sessionId}`);
        cacheService.invalidateByPattern(`${CACHE_PATTERNS.TRANSCRIPT}:${sessionId}`);
        cacheService.invalidateByPattern(`${CACHE_PATTERNS.RED_FLAGS}:${sessionId}`);
        cacheService.delete(`session:${sessionId}`);
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

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async getRecentConversationLogs(): Promise<ConversationLog[]> {
        return this.runQuery<ConversationLog>(`
      SELECT * FROM conversation_logs WHERE timestamp > DATEADD(HOUR, -24, GETDATE()) ORDER BY timestamp DESC
    `);
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
                { name: 'message', type: sql.VarChar(sql.MAX), value: log.message },
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

        // Cache the result
        cacheService.set(cacheKey, result);
        return result;
    }

    public async getRecentRedFlagEvents(): Promise<RedFlagEvent[]> {
        return this.runQuery<RedFlagEvent>(`
      SELECT * FROM red_flag_events WHERE timestamp > DATEADD(HOUR, -24, GETDATE()) ORDER BY timestamp DESC
    `);
    }

    public async saveRedFlagEvent(event: Omit<RedFlagEvent, 'id' | 'timestamp'>): Promise<void> {
        await this.runQueryWithInput(
            `INSERT INTO red_flag_events (session_id, symptoms, severity, resolved, clinician_notified, timestamp)
       VALUES (@session_id, @symptoms, @severity, @resolved, @clinician_notified, GETDATE())`,
            [
                { name: 'session_id', type: sql.VarChar, value: event.session_id },
                { name: 'symptoms', type: sql.VarChar(250), value: event.symptoms },
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

    // --------------------- INTAKE RESPONSES ---------------------

    // CREATE
    public async createIntakeResponse(response: Omit<IntakeResponse, 'id' | 'timestamp'>): Promise<void> {
        await this.runQueryWithInput(
            `INSERT INTO intake_responses (session_id, question, answer, category, timestamp)
       VALUES (@session_id, @question, @answer, @category, GETDATE())`,
            [
                { name: 'session_id', type: sql.VarChar, value: response.session_id },
                { name: 'question', type: sql.VarChar(250), value: response.question },
                { name: 'answer', type: sql.VarChar(8000), value: response.answer },
                { name: 'category', type: sql.VarChar(250), value: response.category }
            ]
        );

        // Invalidate intake response caches
        cacheService.invalidateByPattern('intake-responses');
    }

    // READ all
    public async getAllIntakeResponses(): Promise<IntakeResponse[]> {
        return this.runQuery<IntakeResponse>(`SELECT * FROM intake_responses ORDER BY timestamp DESC`);
    }

    public async getAllIntakeResponsesBySession(sessionId: string): Promise<Session[]> {
        return await this.runQueryWithInput<Session>(
            `SELECT * FROM intake_responses WHERE session_id =  @id;`,
            [
                { name: 'id', type: sql.VarChar, value: sessionId }
            ]
        );
    }

    // READ by ID
    public async getIntakeResponse(id: number): Promise<IntakeResponse | null> {
        const result = await this.runQueryWithInput<IntakeResponse>(
            `SELECT * FROM intake_responses WHERE id = @id`,
            [{ name: 'id', type: sql.BigInt, value: id }]
        );
        return result.length > 0 ? result[0] : null;
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

    public async registerUser(username: string, email: string, password: string) {
        const passwordHash = await bcrypt.hash(password, 10);

        await this.runQueryWithInput(
            `INSERT INTO users (username, email, password_hash) VALUES (@username, @email, @password_hash)`,
            [
                { name: 'username', type: sql.VarChar(250), value: username },
                { name: 'email', type: sql.VarChar(250), value: email },
                { name: 'password_hash', type: sql.VarChar(500), value: passwordHash }
            ]
        );
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
            let passwordMatch = false;

            // Check if password_hash is a valid bcrypt hash (starts with $2b$ or $2a$)
            if (user.password_hash.startsWith('$2b$') || user.password_hash.startsWith('$2a$')) {
                // It's a proper bcrypt hash
                passwordMatch = await bcrypt.compare(password, user.password_hash);
            } else {
                // It's plain text (temporary fallback for existing users)
                passwordMatch = password === user.password_hash;
            }

            if (passwordMatch) {
                successful = true;

                // Generate JWT token
                // Extended expiration for better user experience
                const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, 'A7f9K2dL8qX3pV0b' , { expiresIn: '7d' });

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
}

export default new DataService();
