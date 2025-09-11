const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Database file path
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/medical_intake.db');
const DB_DIR = path.dirname(DB_PATH);

// Ensure database directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

class DatabaseManager {
  private db: any;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initializeTables();
    console.log('✅ Database initialized at:', DB_PATH);
  }

  private initializeTables() {
    // Create tables for storing intake session data

    // Sessions table - core session information
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        patient_name TEXT,
        status TEXT DEFAULT 'active',
        start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        end_time DATETIME,
        red_flags_detected INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Settings table - user-configurable system settings
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        model TEXT DEFAULT 'gpt-4o-realtime-preview',
        openai_api_key TEXT,
        medical_instructions TEXT,
        voice TEXT DEFAULT 'alloy',
        temperature REAL DEFAULT 0.6,
        max_response_length INTEGER DEFAULT 200,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Insert default settings if not exists
      INSERT OR IGNORE INTO settings (id, model, voice, temperature, max_response_length,
        medical_instructions, updated_at)
      VALUES (1, 'gpt-4o-realtime-preview', 'alloy', 0.6, 200,
        'Collect structured medical intake information. Gather symptoms, history, and patient concerns.', CURRENT_TIMESTAMP);
    `);

    // Conversation logs - store all conversation exchanges
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        speaker TEXT NOT NULL, -- 'patient', 'agent', 'system', 'alert'
        message TEXT NOT NULL,
        audio_data TEXT, -- JSON string for audio metadata
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      );
    `);

    // FHIR resources - store structured medical data
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fhir_resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        resource_type TEXT NOT NULL, -- 'Patient', 'Condition', 'Observation', etc.
        resource_id TEXT, -- FHIR resource ID
        resource_data TEXT NOT NULL, -- JSON string for FHIR resource
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      );
    `);

    // Patient responses - structured intake data
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intake_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        category TEXT NOT NULL, -- 'symptoms', 'history', 'medications', etc.
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      );
    `);

    // Red flag events - critical alerts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS red_flag_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        symptoms TEXT NOT NULL, -- JSON array
        severity TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved BOOLEAN DEFAULT FALSE,
        clinician_notified BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      );
    `);

    // Audit log - for HIPAA compliance
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        user_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('📊 Database tables initialized successfully');
  }

  // Session-related methods
  createSession(sessionData: any) {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, patient_id, patient_name, status)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(
      sessionData.id,
      sessionData.patientId || null,
      sessionData.patientName || null,
      sessionData.status || 'active'
    );
  }

  updateSessionStatus(sessionId: string, status: string) {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET status = ?, end_time = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE end_time END
      WHERE id = ?
    `);
    return stmt.run(status, status, sessionId);
  }

  getSession(sessionId: string) {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(sessionId);
  }

  getActiveSessions() {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions
      WHERE status IN ('active', 'paused')
      AND start_time > datetime('now', '-24 hours')
      ORDER BY start_time DESC
    `);
    return stmt.all();
  }

  // Conversation logging methods
  saveConversationLog(sessionId: string, speaker: string, message: string, audioData?: any, timestamp?: string) {
    if (timestamp) {
      const stmt = this.db.prepare(`
        INSERT INTO conversation_logs (session_id, speaker, message, audio_data, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);
      return stmt.run(sessionId, speaker, message, audioData ? JSON.stringify(audioData) : null, timestamp);
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO conversation_logs (session_id, speaker, message, audio_data)
        VALUES (?, ?, ?, ?)
      `);
      return stmt.run(sessionId, speaker, message, audioData ? JSON.stringify(audioData) : null);
    }
  }

  getSessionConversationLogs(sessionId: string) {
    const stmt = this.db.prepare(`
      SELECT * FROM conversation_logs
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(sessionId);
  }

  // FHIR resource storage methods
  saveFHIRResource(sessionId: string, resourceType: string, resourceData: any, resourceId?: string) {
    const stmt = this.db.prepare(`
      INSERT INTO fhir_resources (session_id, resource_type, resource_id, resource_data)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(sessionId, resourceType, resourceId || null, JSON.stringify(resourceData));
  }

  getSessionFHIRResources(sessionId: string, resourceType?: string) {
    let query = 'SELECT * FROM fhir_resources WHERE session_id = ?';
    let params = [sessionId];

    if (resourceType) {
      query += ' AND resource_type = ?';
      params.push(resourceType);
    }

    query += ' ORDER BY created_at ASC';

    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }

  // Intake responses storage
  saveIntakeResponse(sessionId: string, question: string, answer: string, category: string) {
    const stmt = this.db.prepare(`
      INSERT INTO intake_responses (session_id, question, answer, category)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(sessionId, question, answer, category);
  }

  getSessionIntakeResponses(sessionId: string, category?: string) {
    let query = 'SELECT * FROM intake_responses WHERE session_id = ?';
    let params = [sessionId];

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    query += ' ORDER BY timestamp ASC';

    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }

  // Red flag event logging
  saveRedFlagEvent(sessionId: string, symptoms: string[], severity: string) {
    const stmt = this.db.prepare(`
      INSERT INTO red_flag_events (session_id, symptoms, severity)
      VALUES (?, ?, ?)
    `);
    return stmt.run(sessionId, JSON.stringify(symptoms), severity);

    // Also update session to flag red flag detection
    this.db.prepare('UPDATE sessions SET red_flags_detected = red_flags_detected + 1 WHERE id = ?')
         .run(sessionId);
  }

  getRedFlagEvents(sessionId: string, unresolved?: boolean) {
    let query = 'SELECT * FROM red_flag_events WHERE session_id = ?';
    let params: any[] = [sessionId];

    if (unresolved !== undefined) {
      query += ' AND resolved = ?';
      params.push(unresolved ? 1 : 0);
    }

    query += ' ORDER BY timestamp DESC';

    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }

  // Audit logging for HIPAA compliance
  logAuditEvent(action: string, details: any, sessionId?: string, userId?: string, ip?: string, userAgent?: string) {
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (session_id, user_id, action, details, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      sessionId || null,
      userId || null,
      action,
      JSON.stringify(details),
      ip || null,
      userAgent || null
    );
  }

  getAuditLogs(sessionId: string, limit: number = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(sessionId, limit);
  }

  // Settings management methods
  getSettings() {
    const stmt = this.db.prepare('SELECT * FROM settings WHERE id = 1');
    return stmt.get();
  }

  saveSettings(settings: any) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO settings (
        id, model, openai_api_key, medical_instructions,
        voice, temperature, max_response_length, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    return stmt.run(
      settings.model,
      settings.openaiApiKey,
      settings.medicalInstructions,
      settings.voice || 'alloy',
      settings.temperature || 0.6,
      settings.maxResponseLength || 200
    );
  }

  // Report generation helpers
  generateIntakeReport(sessionId: string) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const conversationLogs = this.getSessionConversationLogs(sessionId);
    const fhirResources = this.getSessionFHIRResources(sessionId);
    const intakeResponses = this.getSessionIntakeResponses(sessionId);
    const redFlags = this.getRedFlagEvents(sessionId);

    return {
      sessionId,
      timestamp: new Date(),
      status: session.status,
      duration: session.end_time ? Number(new Date(session.end_time)) - Number(new Date(session.start_time)) : 0,
      redFlagsDetected: redFlags.length,
      conversationSummary: this.summarizeConversation(conversationLogs),
      intakeData: this.organizeIntakeData(intakeResponses),
      redFlags,
      auditTrail: this.getAuditLogs(sessionId)
    };
  }

  private summarizeConversation(conversationLogs: any[]) {
    const agentMessages = conversationLogs.filter(log => log.speaker === 'agent').length;
    const patientMessages = conversationLogs.filter(log => log.speaker === 'patient').length;
    const alerts = conversationLogs.filter(log => log.speaker === 'alert').length;

    return {
      totalExchanges: conversationLogs.length,
      agentStatements: agentMessages,
      patientStatements: patientMessages,
      alertsGenerated: alerts,
      duration: conversationLogs.length > 0 ?
        Number(new Date(conversationLogs[conversationLogs.length - 1].timestamp)) - Number(new Date(conversationLogs[0].timestamp))
        : 0
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

  // Database maintenance
  cleanupOldSessions(olderThanDays: number = 30) {
    // Archive sessions older than N days
    const date = new Date();
    date.setDate(date.getDate() - olderThanDays);

    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sessions
      WHERE end_time < ? AND status = 'completed'
    `);
    const result = stmt.get(date.toISOString());
    return result.count;
  }

  close() {
    if (this.db) {
      this.db.close();
      console.log('Database connection closed');
    }
  }
}

export default new DatabaseManager();