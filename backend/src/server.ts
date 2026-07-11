import 'dotenv/config';   // MUST be first — other modules read process.env at import time
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import * as http from 'http';
import { OpenAI } from 'openai';
import { SarvamAIClient } from 'sarvamai';
import jwt from 'jsonwebtoken';
import { authenticateJWT, requireRole, getJwtSecret, AuthRequest } from "./auth.js";
import { buildFhirBundle } from "./fhir-service.js";
import { answerQuestion as assistantAnswer, speak as assistantSpeak, transcribe as assistantTranscribe } from "./assistant-service.js";
import { createIntakeSession, IntakeSessionError } from "./intake-service.js";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3002;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Import our modules
import realtimeManager from './realtime.js';
import { MEDICAL_INTAKE_INSTRUCTIONS_NEW, REALTIME_CONFIG } from './constants.js';
import db from './database-manager.js';
import ProviderFactory from './providers/ProviderFactory.js';
import RetellAIProvider from './providers/RetellAIProvider.js';

// --- Security middleware ---
app.use(helmet());

// Restrict CORS to the configured frontend origin(s). Comma-separate multiple.
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // allow same-origin / curl (no Origin header) and any explicitly allowed origin.
    // Disallowed origins get cb(null, false): the browser blocks it via missing
    // CORS headers (clean) rather than the request throwing a 500.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));

// Rate limiting. Authenticated requests are keyed by USER (decoded from the JWT,
// not verified here — that's the auth gate's job) so that all staff behind a
// single hospital NAT IP are not throttled as one. Unauthenticated requests fall
// back to a per-IP key.
const rateKey = (req: any): string => {
  const h = req.headers?.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) {
    try {
      const decoded: any = jwt.decode(h.slice(7));
      if (decoded && decoded.id) return `u:${decoded.id}`;
    } catch { /* fall through to IP */ }
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
};

// Brute-force protection on login (per IP).
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts, please try again later.' } });
// General API cap (per user / per IP).
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, keyGenerator: rateKey, standardHeaders: true, legacyHeaders: false });
// Stricter cap on expensive, paid operations (each triggers Sarvam API usage).
const expensiveLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, keyGenerator: rateKey, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests for this operation — please slow down.' } });
app.use('/api/login', loginLimiter);
app.use('/api/', apiLimiter);

// Request logging (avoid logging tokens/PHI here).
app.use((req: any, res: any, next: any) => {
  console.log(`📡 ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

// Health check (public) — also verifies DB connectivity so monitors/load-balancers
// detect a database outage (returns 503 when the DB is unreachable).
app.get('/health', async (req: any, res: any) => {
  const dbUp = await db.ping();
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'OK' : 'DEGRADED',
    db: dbUp ? 'up' : 'down',
    uptimeSeconds: Math.round(process.uptime()),
    message: 'Medical Intake Voice Agent Backend'
  });
});

// Operational metrics (admin only) — for dashboards/monitoring.
app.get('/api/admin/metrics', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const counts = await db.getSessionCounts();
    const active = await db.getActiveSessions();
    const users = await db.listUsers();
    res.json({
      uptimeSeconds: Math.round(process.uptime()),
      activeSessions: active.length,
      totalSessions: counts.totalSessions,
      completedToday: counts.completedToday,
      users: users.length,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// --- GLOBAL AUTH GATE ---
// Every /api/ route requires a valid JWT EXCEPT /api/login. This protects all
// patient data (transcripts, reports, analytics, logs) and paid actions
// (report generation) which must never be reachable without authentication.
app.use((req: any, res: any, next: any) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/login') return next();
  // Public patient-intake-link endpoints authorize via the link token itself (the patient has
  // no account), so they sit outside the JWT gate — like /api/login. They are still rate-limited
  // by apiLimiter and must never return 401/403 (see the route handlers).
  if (req.path.startsWith('/api/public/')) return next();
  return authenticateJWT(req, res, next);
});

// Initialize performance indexes (one-time setup)
app.post('/api/setup-indexes', async (req: any, res: any) => {
  try {
    console.log('🛠️ Setting up database performance indexes...');
    await db.createPerformanceIndexes();
    console.log('✅ Database performance indexes setup complete');

    res.json({
      success: true,
      message: 'Database performance indexes have been created/improved'
    });
  } catch (error: any) {
    console.error('Failed to setup performance indexes:', error);
    res.status(500).json({
      error: 'Failed to setup performance indexes',
      details: error.message
    });
  }
});

// Debug route to test database savings
app.post('/api/test-agent-response', async (req: any, res: any) => {
  try {
    const { sessionId, text } = req.body;
    console.log(`🧪 TEST: Saving test agent response "${text}" to session ${sessionId}`);

    await db.saveConversationLog({
      session_id: sessionId,        // number
      speaker: 'agent',             // string
      message: text,                // string
      audio_data: JSON.stringify({ type: 'test' }) // optional, convert object to string or Buffer
    });

    // Query back to verify it was saved
    const logs = await db.getSessionConversationLogs(sessionId);
    const agentLogs = logs?.filter((log: any) => log.speaker === 'agent');

    console.log(`🧪 TEST: Found ${agentLogs?.length || 0} agent logs after saving`);

    res.json({
      success: true,
      message: 'Test agent response saved',
      totalAgentLines: agentLogs?.length || 0,
      latestAgentLine: agentLogs?.[agentLogs.length - 1]?.message || null
    });
  } catch (error: any) {
    console.error('Test agent response save failed:', error);
    res.status(500).json({ error: 'Failed to save test response' });
  }
});

// Debug endpoint to check red flag events table directly
app.get('/api/debug/red-flags', async (req: any, res: any) => {
  try {
    console.log('🔍 DEBUG: Checking red_flag_events table directly');
    const redFlags = await db.getAllRedFlagEvents();

    console.log(`🔍 DEBUG: Found ${redFlags?.length || 0} red flag events in database`);

    res.json({
      success: true,
      redFlags,
      count: redFlags?.length || 0
    });
  } catch (error: any) {
    console.error('Failed to query red_flag_events table:', error);
    res.status(500).json({ error: 'Failed to query red flag events', details: error.message });
  }
});

// Test red flag detection
app.post('/api/test-red-flag-detection', async (req: any, res: any) => {
  try {
    const { sessionId, transcript } = req.body;

    if (!sessionId || !transcript) {
      return res.status(400).json({
        error: 'sessionId and transcript are required'
      });
    }

    console.log(`🧪 TEST: Testing red flag detection for session ${sessionId} with transcript: "${transcript}"`);

    // Import constants
    const { RED_FLAG_PATTERNS, RED_FLAG_SEVERITY_MAP, RED_FLAG_SEVERITY } = await import('./constants.js');

    const lowerTranscript = transcript.toLowerCase();
    const detectedFlags: string[] = [];
    let maxSeverity = RED_FLAG_SEVERITY.LOW;

    // Check each red flag pattern
    for (const pattern of RED_FLAG_PATTERNS) {
      if (lowerTranscript.includes(pattern.toLowerCase())) {
        detectedFlags.push(pattern);
        const severity = RED_FLAG_SEVERITY_MAP[pattern] || RED_FLAG_SEVERITY.MEDIUM;
        if (severity === RED_FLAG_SEVERITY.CRITICAL) {
          maxSeverity = RED_FLAG_SEVERITY.CRITICAL;
        } else if (severity === RED_FLAG_SEVERITY.HIGH && maxSeverity !== RED_FLAG_SEVERITY.CRITICAL) {
          maxSeverity = RED_FLAG_SEVERITY.HIGH;
        }
      }
    }

    const result: any = {
      transcript: transcript,
      detectedFlags: detectedFlags,
      severity: maxSeverity,
      redFlagDetected: detectedFlags.length > 0
    };

    // If red flags detected, try to save them (only if session exists)
    if (detectedFlags.length > 0) {
      try {
        await db.saveRedFlagEvent({
          session_id: sessionId,
          symptoms: JSON.stringify(detectedFlags),
          severity: maxSeverity,
          resolved: false,
          clinician_notified: true
        });

        //db.saveRedFlagEvent(sessionId, detectedFlags, maxSeverity);
        //db.logAuditEvent('red_flag_detected_test', result, sessionId);

        await db.insertAuditLog({
          action: 'red_flag_detected_test',
          details: JSON.stringify(result),
          session_id: sessionId,
          ip_address: req.ip || null
        });
        console.log(`🚨 TEST: Red flags saved to database for session ${sessionId}`);
      } catch (saveError: any) {
        console.log(`🚨 TEST: Could not save to database (session may not exist): ${saveError.message}`);
        result.databaseSaveError = saveError.message;
      }
    }

    res.json({
      success: true,
      message: 'Red flag detection test completed',
      result: result
    });

  } catch (error: any) {
    console.error('Test red flag detection failed:', error);
    res.status(500).json({ error: 'Failed to test red flag detection', details: error.message });
  }
});

// Start a new intake session (staff / in-clinic). Thin wrapper over the shared
// createIntakeSession helper — the same helper backs the public patient-link flow.
app.post('/api/sessions/start', expensiveLimiter, authenticateJWT, async (req: any, res: any) => {
  try {
    const { patientName, consentGiven, language, phone } = req.body;
    const result = await createIntakeSession({
      patientName,
      consentGiven,
      language,
      phone,
      source: 'staff',
      ip: req.ip || null,
      userAgent: req.headers['user-agent'] || null
    });

    res.json({
      sessionId: result.sessionId,
      status: result.status,
      provider: result.provider,
      message: 'Session started successfully',
      isReturning: result.isReturning,
      patient: result.patient
    });
  } catch (error: any) {
    if (error instanceof IntakeSessionError) {
      return res.status(error.httpStatus).json(error.payload);
    }
    console.error('Session start error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start Retell AI web call for a session
app.post('/api/sessions/:sessionId/start-web-call', authenticateJWT, async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;

    // Validate session exists
    const session = await db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ error: 'Session is not active' });
    }

    console.log(`🔄 Starting Retell AI web call for session ${sessionId}`);

    // Get settings for API key and agent ID
    const settings = await db.getAllSettings();
    const setting = settings && settings.length > 0 ? settings[0] : null;

    // Check for Retell AI configuration in database, fall back to environment variables
    const retellApiKey = (setting as any)?.retellai_api_key || process.env.RETELLAI_API_KEY;
    const retellAgentId = (setting as any)?.retellai_agent_id || process.env.RETELLAI_AGENT_ID;

    if (!retellApiKey || !retellAgentId) {
      return res.status(400).json({
        error: 'Retell AI configuration missing',
        message: 'Retell AI API key and Agent ID must be configured in settings or environment variables'
      });
    }

    // Create Retell AI provider instance
    const retellProvider = new RetellAIProvider();

    // Override environment variables temporarily for this call
    const originalApiKey = process.env.RETELLAI_API_KEY;
    const originalAgentId = process.env.RETELLAI_AGENT_ID;

    process.env.RETELLAI_API_KEY = retellApiKey;
    process.env.RETELLAI_AGENT_ID = retellAgentId;

    try {
      // Create web call
      const webCallResponse = await retellProvider.createWebCall({
        sessionId: sessionId,
        agentId: retellAgentId,
        instructions: (setting as any)?.medical_instructions || MEDICAL_INTAKE_INSTRUCTIONS_NEW
      });

      // Log audit event
      await db.insertAuditLog({
        action: 'retell_web_call_started',
        details: JSON.stringify({
          call_id: webCallResponse.call_id,
          agent_id: webCallResponse.agent_id
        }),
        session_id: sessionId,
        ip_address: req.ip || null
      });

      // Store call metadata in database
      await db.saveConversationLog({
        session_id: sessionId,
        speaker: 'system',
        message: `Retell AI web call started`,
        audio_data: JSON.stringify({
          type: 'retell_call_metadata',
          call_id: webCallResponse.call_id,
          access_token: webCallResponse.access_token,
          agent_id: webCallResponse.agent_id,
          start_time: new Date().toISOString()
        })
      });

      console.log(`✅ Retell AI web call started for session ${sessionId}`);

      res.json({
        sessionId,
        call_id: webCallResponse.call_id,
        access_token: webCallResponse.access_token,
        agent_id: webCallResponse.agent_id,
        message: 'Web call started successfully'
      });

    } finally {
      // Restore original environment variables
      process.env.RETELLAI_API_KEY = originalApiKey;
      process.env.RETELLAI_AGENT_ID = originalAgentId;
    }

  } catch (error: any) {
    console.error('Failed to start Retell AI web call:', error);

    // Update session status on failure
    try {
      await db.updateSessionStatus(req.params.sessionId, 'error');
      await db.insertAuditLog({
        action: 'retell_web_call_start_failed',
        details: JSON.stringify({ error: error.message }),
        session_id: req.params.sessionId,
        ip_address: req.ip || null
      });
    } catch (dbError: any) {
      console.error('Failed to update database on web call failure:', dbError.message);
    }

    res.status(500).json({
      error: 'Failed to start web call',
      message: error.message,
      details: 'Check your Retell AI API key and Agent ID configuration'
    });
  }
});

// Get Retell AI call transcript using get-call API
app.get('/api/sessions/:sessionId/retell-transcript', authenticateJWT, async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;

    // Get session to find associated call_id
    const session = await db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const retellApiKey = process.env.RETELLAI_API_KEY;
    if (!retellApiKey) {
      return res.status(500).json({ error: 'Retell AI API key not configured' });
    }

    // Find the call_id from stored conversation logs where we saved the web call metadata
    const conversationLogs = await db.getSessionConversationLogs(sessionId);
    console.log(`🔍 DEBUG: Found ${conversationLogs?.length || 0} conversation logs for session ${sessionId}`);

    // Debug: Log all system logs to see what's stored
    const systemLogs = conversationLogs?.filter((log: any) => log.speaker === 'system');
    console.log(`🔍 DEBUG: Found ${systemLogs?.length || 0} system logs`);
    systemLogs?.forEach((log: any, index: number) => {
      console.log(`🔍 DEBUG: System log ${index + 1}: ${log.message}, audio_data: ${log.audio_data?.substring(0, 200)}...`);
    });

    const callMetadataLog = conversationLogs?.find((log: any) =>
      log.speaker === 'system' &&
      log.audio_data &&
      typeof log.audio_data === 'string' &&
      log.audio_data.includes('retell_call_metadata')
    );

    if (!callMetadataLog) {
      return res.status(404).json({
        error: 'Call metadata not found',
        message: 'No Retell AI web call metadata found for this session'
      });
    }

    let callMetadata;
    try {
      if (!callMetadataLog.audio_data) {
        return res.status(500).json({
          error: 'Invalid call metadata',
          message: 'Call metadata is empty'
        });
      }
      callMetadata = JSON.parse(callMetadataLog.audio_data);
    } catch (parseError) {
      console.error('Failed to parse call metadata:', parseError);
      return res.status(500).json({
        error: 'Invalid call metadata',
        message: 'Call metadata is corrupted'
      });
    }

    const { call_id } = callMetadata;
    if (!call_id) {
      return res.status(404).json({
        error: 'Call ID not found',
        message: 'Call ID not stored in metadata'
      });
    }

    console.log(`📞 Retrieving transcript for Retell AI call ${call_id}`);

    // Use the REST API endpoint directly as specified in documentation
    const getCallUrl = `https://api.retellai.com/v2/get-call/${call_id}`;

    const response = await fetch(getCallUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${retellApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({
          error: 'Call not found',
          message: 'Retell AI call not found or expired'
        });
      }
      throw new Error(`Retell API responded with status ${response.status}: ${response.statusText}`);
    }

    const call: any = await response.json();

    if (!call) {
      return res.status(404).json({
        error: 'Call not found',
        message: 'Retell AI call not found or expired'
      });
    }

    // Check if the call has ended and update session status accordingly
    const callEndedStatuses = ['ended', 'completed', 'error', 'failed'];
    if (call.call_status && callEndedStatuses.includes(call.call_status.toLowerCase())) {
      console.log(`📞 RetellAI call ${call_id} has ended with status: ${call.call_status}. Updating session status to completed.`);
      try {
        await db.updateSessionStatus(sessionId, 'completed');
        console.log(`✅ Session ${sessionId} status updated to completed`);
      } catch (statusError: any) {
        console.error(`❌ Failed to update session status for ${sessionId}:`, statusError.message);
      }
    }

    // Extract transcript data from transcript_object (detailed array)
    const transcript = Array.isArray(call.transcript_object) ? call.transcript_object : [];

    console.log(`📝 Retrieved ${transcript.length} transcript items from transcript_object for call ${call_id}`);

    // Save each transcript item to our database for persistence
    for (const item of transcript) {
      try {
        await db.saveConversationLog({
          session_id: sessionId,
          speaker: item.role || item.speaker || 'unknown', // 'agent' or 'user'
          message: item.content || item.text || '',
          audio_data: JSON.stringify({
            type: 'retell_transcript',
            transcript_id: item.id,
            timestamp: item.created_at || item.timestamp,
            source: 'retell_get_call_api'
          })
        });
      } catch (saveError: any) {
        console.error(`Failed to save transcript item ${item.id || 'unknown'}:`, saveError.message);
        // Continue with other items even if one fails
      }
    }

    // Log audit event
    await db.insertAuditLog({
      action: 'retell_transcript_retrieved',
      details: JSON.stringify({
        call_id: call_id,
        transcript_items: transcript.length,
        call_status: call.call_status
      }),
      session_id: sessionId,
      ip_address: req.ip || null
    });

    // Return the transcript data with call information
    res.json({
      sessionId,
      call_id: call.call_id,
      status: call.call_status,
      start_time: call.start_timestamp,
      end_time: call.end_timestamp,
      duration: call.duration || 0,
      transcript: transcript.map((item: any) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        created_at: item.created_at
      })),
      summary: {
        total_items: transcript.length,
        agent_lines: transcript.filter((t: any) => t.role === 'agent').length,
        user_lines: transcript.filter((t: any) => t.role === 'user').length
      }
    });

  } catch (error: any) {
    console.error('Failed to get Retell transcript:', error);

    // Handle specific Retell API errors
    if (error.status === 404) {
      return res.status(404).json({
        error: 'Call not found',
        message: 'The Retell AI call was not found or has expired'
      });
    }

    if (error.status === 401) {
      return res.status(500).json({
        error: 'Authentication failed',
        message: 'Invalid Retell AI API key'
      });
    }

    res.status(500).json({
      error: 'Failed to retrieve call transcript',
      message: error.message
    });
  }
});

// Save transcript for a Retell AI session
app.post('/api/sessions/:sessionId/transcript', authenticateJWT, async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const { speaker, message, timestamp, type } = req.body;

    // Validate session exists
    const session = await db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status !== 'active') {
      return res.status(400).json({ error: 'Session is not active' });
    }

    console.log(`📝 Saving ${speaker} transcript for Retell AI session ${sessionId}: "${message}"`);

    // Save transcript to database
    await db.saveConversationLog({
      session_id: sessionId,
      speaker: speaker,
      message: message,
      audio_data: JSON.stringify({
        type: type || 'realtime_transcript',
        timestamp: timestamp || new Date().toISOString(),
        source: 'retell_ai_web_call'
      })
    });

    res.json({ success: true, message: 'Transcript saved successfully' });

  } catch (error: any) {
    console.error('Failed to save transcript:', error);
    res.status(500).json({
      error: 'Failed to save transcript',
      message: error.message
    });
  }
});

// Get recent red flag events (for clinician dashboard) - Optimized: loads only recent events directly
app.get('/api/sessions/red-flags', async (req: any, res: any) => {
  console.log('📡 REQUEST DETAILS:', {
    method: req.method,
    url: req.url,
    path: req.path,
    headers: req.headers
  });
  try {
    // Only load recent red flags (last 24 hours) for dashboard efficiency
    const hoursBack = parseInt(req.query.hours) || 24;
    console.log(`🔍 DEBUG: Fetching red flags for last ${hoursBack} hours`);

    // Direct query to red_flag_events table (much more efficient!)
    const recentRedFlags = await db.getRecentRedFlagEvents(hoursBack);

    console.log(`🔍 DEBUG: Found ${recentRedFlags.length} recent red flags`);
    res.json({ redFlags: recentRedFlags });
  } catch (error: any) {
    console.error('Failed to get red flag events:', error);
    res.status(500).json({ error: 'Failed to retrieve red flag events', details: error.message });
  }
});


// Admin only: delete ALL session data (keeps patients/users/settings). Declared before the
// :sessionId route so the literal path matches first.
app.delete('/api/sessions', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const removed = await db.deleteAllSessions();
    await db.insertAuditLog({
      action: 'all_sessions_deleted',
      details: JSON.stringify({ removed, by: req.user?.username }),
      session_id: null, ip_address: req.ip || null
    }).catch(() => {});
    console.log(`🗑️  All sessions deleted (${removed}) by ${req.user?.username}`);
    res.json({ message: 'All sessions deleted', removed });
  } catch (error: any) {
    console.error('Delete all sessions failed:', error);
    res.status(500).json({ error: 'Failed to delete sessions', details: error.message });
  }
});

// Admin only: delete a single session and all of its data.
app.delete('/api/sessions/:sessionId', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    await db.deleteSession(sessionId);
    await db.insertAuditLog({
      action: 'session_deleted',
      details: JSON.stringify({ session_id: sessionId, by: req.user?.username }),
      session_id: sessionId, ip_address: req.ip || null
    }).catch(() => {});
    res.json({ message: 'Session deleted', sessionId });
  } catch (error: any) {
    console.error('Delete session failed:', error);
    res.status(500).json({ error: 'Failed to delete session', details: error.message });
  }
});


// Patient directory — paginated, most recently seen first.
app.get('/api/patients', authenticateJWT, async (req: any, res: any) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const result = await db.getPatientsPaginated(page, limit);
    res.json(result);
  } catch (error: any) {
    console.error('Failed to list patients:', error);
    res.status(500).json({ error: 'Failed to list patients', details: error.message });
  }
});

// Admin only: delete ALL patients and their sessions/visits/data. Declared before the
// :id route so the literal path matches first.
app.delete('/api/patients', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const removed = await db.deleteAllPatients();
    await db.insertAuditLog({
      action: 'all_patients_deleted',
      details: JSON.stringify({ removed, by: req.user?.username }),
      session_id: null, ip_address: req.ip || null
    }).catch(() => {});
    console.log(`🗑️  All patients deleted (${removed}) by ${req.user?.username}`);
    res.json({ message: 'All patients deleted', removed });
  } catch (error: any) {
    console.error('Delete all patients failed:', error);
    res.status(500).json({ error: 'Failed to delete patients', details: error.message });
  }
});

// One patient's full record + their visit history.
app.get('/api/patients/:id', authenticateJWT, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid patient id' });
    const patient = await db.getPatientById(id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    const sessions = await db.getSessionsByPatientId(id);
    res.json({ patient, sessions });
  } catch (error: any) {
    console.error('Failed to get patient:', error);
    res.status(500).json({ error: 'Failed to get patient', details: error.message });
  }
});

// Admin only: delete a patient and ALL of their sessions/visits and data.
app.delete('/api/patients/:id', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid patient id' });
    await db.deletePatient(id);
    await db.insertAuditLog({
      action: 'patient_deleted',
      details: JSON.stringify({ patient_id: id, by: req.user?.username }),
      session_id: null, ip_address: req.ip || null
    }).catch(() => {});
    console.log(`🗑️  Patient ${id} deleted by ${req.user?.username}`);
    res.json({ message: 'Patient deleted', id });
  } catch (error: any) {
    console.error('Delete patient failed:', error);
    res.status(500).json({ error: 'Failed to delete patient', details: error.message });
  }
});


// Get session status
app.get('/api/sessions/:sessionId', (req: any, res: any) => {
  const { sessionId } = req.params;

  // Check if session exists
  const session = realtimeManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({ sessionId, status: 'active' });
});

// End session
app.post('/api/sessions/:sessionId/end', async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;

    // Get the session to determine which provider was used
    const session = await db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Use the correct provider for ending the session
    if (session.provider === 'retellai') {
      // For RetellAI sessions, use the RetellAI provider
      const retellProvider = ProviderFactory.getProvider('retellai');
      await retellProvider.endSession(sessionId);
    } else {
      // For OpenAI (and other) sessions, use the realtime manager
      await realtimeManager.endSession(sessionId);
    }

    res.json({ message: 'Session ended successfully' });
  } catch (error: any) {
    console.error('Error ending session:', error);
    res.status(500).json({ error: 'Failed to end session', details: error.message });
  }
});

// Get session counts for dashboard
app.get('/api/sessions-counts', async (req: any, res: any) => {
  try {
    const counts = await db.getSessionCounts();
    res.json(counts);
  } catch (error: any) {
    console.error('Failed to get session counts:', error);
    res.status(500).json({ error: 'Failed to retrieve session counts' });
  }
});

// Get all active sessions (with pagination support)
app.get('/api/sessions', async (req: any, res: any) => {
  console.log('🔍 DEBUG: Getting sessions with pagination');
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const status = req.query.status;

    // Validate pagination parameters
    if (page < 1 || limit < 1 || limit > 200) {
      return res.status(400).json({
        error: 'Invalid pagination parameters',
        message: 'Page must be >= 1, limit must be 1-200'
      });
    }

    const result = await db.getSessionsPaginated(page, limit, status);
    console.log(`🔍 DEBUG: Found ${result.total} total sessions, returning page ${page} with ${result.sessions.length} sessions`);

    // Enrich sessions with token usage data for completed sessions
    const enrichedSessions = await Promise.all(
      result.sessions.map(async (session: any) => {
        let estimatedCost = null;

        // Only try to get cost for completed sessions
        if (session.status === 'completed') {
          try {
            // Try to get token usage from database
            const tokenUsageList = await db.getSessionTokenUsage(session.id);

            // Get the latest token usage entry (in case multiple)
            if (tokenUsageList && tokenUsageList.length > 0) {
              const latestUsage = tokenUsageList[0];
              if (latestUsage.estimated_cost > 0) {
                estimatedCost = latestUsage.estimated_cost;
              }
            }
          } catch (usageError: any) {
            // If no token usage found, leave as null
            console.log(`No token usage found for session ${session.id}:`, usageError.message);
          }
        }

        return {
          ...session,
          estimated_cost: estimatedCost
        };
      })
    );

    console.log(`🔍 DEBUG: Returning page ${result.currentPage}/${result.totalPages} with ${enrichedSessions.length} enriched sessions`);
    res.json({
      sessions: enrichedSessions,
      pagination: {
        currentPage: result.currentPage,
        totalPages: result.totalPages,
        totalCount: result.total,
        hasNextPage: result.currentPage < result.totalPages,
        hasPreviousPage: result.currentPage > 1,
        pageSize: limit
      }
    });
  } catch (error: any) {
    console.error('Failed to get sessions:', error);
    res.status(500).json({ error: 'Failed to retrieve sessions' });
  }
});

// Get intake report for a session
app.get('/api/sessions/:sessionId/report', async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const report = db.generateIntakeReport(sessionId);

    if (!report) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Log audit event for report access    
    await db.insertAuditLog({
      action: 'report_accessed',
      details: null,
      session_id: sessionId,
      ip_address: req.ip || null
    });

    res.json({ report });
  } catch (error: any) {
    console.error('Failed to generate report:', error);
    res.status(500).json({ error: 'Failed to generate intake report' });
  }
});

// Get complete conversation transcript for a session (chronological)
app.get('/api/sessions/:sessionId/transcript', async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;

    // Get all conversation logs
    const conversationLogs = await db.getSessionConversationLogs(sessionId);
    console.log(`📋 DEBUG: Fetching transcript for session ${sessionId} - found ${conversationLogs?.length || 0} logs`);
    conversationLogs?.forEach((log: any, index: number) => {
      console.log(`📋 DEBUG: Log ${index + 1}: ${log.speaker} - "${log.message?.substring(0, 100)}${log.message?.length > 100 ? '...' : ''}"`);
    });

    if (!conversationLogs) {
      return res.status(404).json({ error: 'Session not found or no conversation data' });
    }

    // Get red flag and red flag events for context
    const redFlagEvents = await db.getRedFlagEvents(sessionId);
    const sessionInfo = await db.getSession(sessionId);

    // Format conversation as chronological transcript
    const transcript = conversationLogs.map((log: any) => ({
      timestamp: log.timestamp,
      timestamp_formatted: new Date(log.timestamp).toLocaleString(),
      speaker: log.speaker,
      message: log.message,
      type: log.audio_data ? 'audio_with_text' : 'text_only'
    }));

    // Log audit event    
    await db.insertAuditLog({
      action: 'report_accessed',
      details: JSON.stringify({ lines: transcript.length }),
      session_id: sessionId,
      ip_address: req.ip || null
    });

    res.json({
      sessionId,
      timestamp: new Date().toISOString(),
      duration: sessionInfo?.end_time ? new Date(sessionInfo.end_time).getTime() - new Date(sessionInfo.start_time).getTime() : 0,
      transcript,
      redFlagEvents: redFlagEvents || [],
      summary: {
        totalLines: transcript.length,
        agentLines: transcript.filter((t: any) => t.speaker === 'agent').length,
        patientLines: transcript.filter((t: any) => t.speaker === 'patient').length,
        systemMessages: transcript.filter((t: any) => t.speaker === 'system').length,
        redFlagsDetected: redFlagEvents?.length || 0
      }
    });
  } catch (error: any) {
    console.error('Failed to generate transcript:', error);
    res.status(500).json({ error: 'Failed to generate conversation transcript' });
  }
});

// Generate report using OpenAI with database caching
app.post('/api/sessions/:sessionId/generate-report', expensiveLimiter, async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;

    // Step 1: Check if report already cached in database
    const cachedReport = await db.getReport(sessionId);

    if (cachedReport) {
      console.log(`📋 Returning cached report for session ${sessionId} (generated ${cachedReport.generated_at})`);

      return res.json({
        report: cachedReport.report_content,
        cached: true,
        generatedAt: cachedReport.generated_at,
        status: (cachedReport as any).status || 'pending',
        reviewedBy: (cachedReport as any).reviewed_by || null
      });
    }

    // Step 2: Generate new report using Sarvam (the conversation is in Telugu)
    console.log(`🤖 Generating new report for session ${sessionId}`);

    // Get settings for API key
    const settings = await db.getAllSettings();
    const setting = settings && settings.length > 0 ? settings[0] : null;
    const sarvamKey = process.env.SARVAM_API_KEY;

    if (!sarvamKey) {
      return res.status(400).json({ error: 'Sarvam API key not configured (SARVAM_API_KEY).' });
    }

    const sarvam = new SarvamAIClient({ apiSubscriptionKey: sarvamKey });

    // Get conversation logs
    const conversationLogs = await db.getSessionConversationLogs(sessionId);
    if (!conversationLogs || conversationLogs.length === 0) {
      return res.status(404).json({ error: 'No conversation data found for this session' });
    }

    // Get session info, red flags and structured intake responses
    const sessionInfo = await db.getSession(sessionId);
    const redFlagEvents = await db.getRedFlagEvents(sessionId);
    const intakeResponses = await db.getAllIntakeResponsesBySession(sessionId);

    // Format conversation for prompt
    const conversationText = conversationLogs.map((log: any) =>
      `${log.speaker.toUpperCase()}: ${log.message}`
    ).join('\n');

    const structured = (intakeResponses || [])
      .map((r: any) => `- [${r.category || 'general'}] Q: ${r.question} | A: ${r.answer}`)
      .join('\n') || 'None recorded.';

    const langLabel = sessionInfo?.language === 'hi-IN' ? 'Hindi'
                    : sessionInfo?.language === 'en-IN' ? 'English' : 'Telugu';
    const prompt = `You are a clinical documentation assistant. The intake conversation below is in ${langLabel} between an intake assistant and a patient. Produce a professional medical pre-consultation intake report in ENGLISH for the doctor (accurately translate any non-English details).

Session Information:
- Patient Name: ${sessionInfo?.patient_name || 'Not specified'}
- Session Date: ${(sessionInfo?.start_time ? new Date(sessionInfo.start_time).toLocaleDateString() : 'Not specified')}
- Duration: ${sessionInfo?.end_time ? Math.round((new Date(sessionInfo.end_time).getTime() - new Date(sessionInfo.start_time).getTime()) / 1000 / 60) + ' minutes' : 'Ongoing'}
- Red Flags Detected: ${redFlagEvents?.length || 0}

Structured intake responses (captured during the call):
${structured}

Full Conversation Transcript (${langLabel}):
${conversationText}

Structure the report with these sections (use the headings):
1. Patient Information
2. Chief Complaint / Presenting Symptoms
3. History of Present Illness (onset, duration, location, severity, aggravating/relieving factors, associated symptoms)
4. Past Medical History
5. Current Medications / Allergies
6. Family History & Social History (if mentioned)
7. Red Flags Identified (if any)
8. Summary for the Physician

Only use information actually present in the conversation; write "Not reported" where the patient did not provide it. Be concise, factual, and suitable for medical records. Do NOT invent findings or give a diagnosis.`;

    // Call Sarvam chat completions
    const completion: any = await sarvam.chat.completions({
      model: 'sarvam-30b',
      messages: [
        { role: 'system', content: 'You are a careful medical scribe that writes accurate English clinical intake reports from the patient-language conversation provided. Never fabricate information.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1500,
      temperature: 0.2,
      reasoning_effort: null   // disable "thinking" so the model returns the report text directly
    } as any);

    const reportContent = completion?.choices?.[0]?.message?.content?.trim();

    if (!reportContent) {
      return res.status(500).json({ error: 'Failed to generate report from Sarvam' });
    }

    // Step 3: Cache the report in database
    await db.saveReport({
      session_id: sessionId,
      report_content: reportContent,
      generated_at: new Date(),
      cost: 0.03, // Approximate GPT-4 cost
      version: 1
    });

    console.log(`💾 Cached report for session ${sessionId} in database`);

    // Log audit event
    await db.insertAuditLog({
      action: 'report_generated',
      details: JSON.stringify({
        lines: conversationLogs.length,
        cached: false
      }),
      session_id: sessionId,
      ip_address: req.ip || null
    });

    // Return newly generated report (always starts as pending review)
    res.json({
      report: reportContent,
      cached: false,
      generatedAt: new Date(),
      status: 'pending',
      reviewedBy: null
    });

  } catch (error: any) {
    console.error('Failed to generate report:', error);
    res.status(500).json({ error: 'Failed to generate report', details: error.message });
  }
});

// Doctor review: edit and/or approve a generated report (doctor or admin only).
app.post('/api/sessions/:sessionId/report/review', requireRole('doctor', 'admin'), async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const { content, status } = req.body || {};
    const newStatus = status === 'approved' ? 'approved' : 'pending';

    const existing = await db.getReport(sessionId);
    if (!existing) return res.status(404).json({ error: 'No report to review for this session. Generate it first.' });

    const reviewedBy = req.user?.username || 'unknown';
    await db.reviewReport(sessionId, {
      content: typeof content === 'string' ? content : undefined,
      status: newStatus,
      reviewedBy
    });

    await db.insertAuditLog({
      action: newStatus === 'approved' ? 'report_approved' : 'report_edited',
      details: JSON.stringify({ by: reviewedBy, edited: typeof content === 'string' }),
      session_id: sessionId,
      ip_address: req.ip || null
    });

    res.json({ message: newStatus === 'approved' ? 'Report approved' : 'Report saved', status: newStatus, reviewedBy });
  } catch (error: any) {
    console.error('Failed to review report:', error);
    res.status(500).json({ error: 'Failed to review report' });
  }
});

// FHIR R4 export of a completed intake (doctor/admin) — for EMR/HIS ingestion.
// Returns a FHIR Bundle (Patient, Encounter, QuestionnaireResponse, Flags, report).
app.get('/api/sessions/:sessionId/fhir', requireRole('doctor', 'admin'), async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const session = await db.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const [intake, redFlags, report] = await Promise.all([
      db.getAllIntakeResponsesBySession(sessionId) as any,
      db.getRedFlagEvents(sessionId) as any,
      db.getReport(sessionId),
    ]);

    const bundle = buildFhirBundle(session as any, intake || [], redFlags || [], report as any);

    await db.insertAuditLog({
      action: 'fhir_export',
      details: JSON.stringify({ by: req.user?.username, entries: bundle.entry.length }),
      session_id: sessionId,
      ip_address: req.ip || null,
    });

    res.type('application/fhir+json').json(bundle);
  } catch (error: any) {
    console.error('Failed to build FHIR export:', error);
    res.status(500).json({ error: 'Failed to build FHIR export' });
  }
});

// Get conversation logs for a session
app.get('/api/sessions/:sessionId/logs', async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const logs = await db.getSessionConversationLogs(sessionId);

    // Add timestamp formatting for better display
    const formattedLogs = logs?.map((log: any) => ({
      ...log,
      timestamp_formatted: new Date(log.timestamp).toLocaleString(),
      type: log.audio_data ? 'audio' : 'text'
    })) || [];

    res.json({
      logs: formattedLogs,
      summary: {
        totalMessages: formattedLogs.length,
        agentResponses: formattedLogs.filter((l: any) => l.speaker === 'agent').length,
        patientResponses: formattedLogs.filter((l: any) => l.speaker === 'patient').length,
        systemMessages: formattedLogs.filter((l: any) => l.speaker === 'system').length
      }
    });
  } catch (error: any) {
    console.error('Failed to get conversation logs:', error);
    res.status(500).json({ error: 'Failed to retrieve conversation logs' });
  }
});


// Clinician dashboard summary
app.get('/api/dashboard/summary', async (req: any, res: any) => {
  try {
    const sessions = await db.getActiveSessions() || [];
    const summary = {
      activeSessions: sessions.filter((s: any) => s.status === 'active').length,
      pausedSessions: sessions.filter((s: any) => s.status === 'paused').length,
      totalSessions: sessions.length,
      sessionsWithRedFlags: sessions.filter((s: any) => s.red_flags_detected > 0).length,
      timestamp: new Date().toISOString()
    };

    res.json({ summary });
  } catch (error: any) {
    console.error('Failed to get dashboard summary:', error);
    res.status(500).json({ error: 'Failed to retrieve dashboard summary' });
  }
});

// Token Usage API endpoints
app.get('/api/analytics/token-usage', async (req: any, res: any) => {
  try {
    const usage = await db.getTokenUsageSummary();
    res.json({ usage });
  } catch (error: any) {
    console.error('Failed to get token usage summary:', error);
    res.status(500).json({ error: 'Failed to retrieve token usage summary' });
  }
});

app.get('/api/analytics/token-usage/:period', async (req: any, res: any) => {
  try {
    const { period } = req.params;
    let startDate: Date;
    const endDate = new Date();

    // Parse period (days, weeks, months)
    const periodMatch = period.match(/^(\d+)(day|week|month)s?$/);
    if (!periodMatch) {
      return res.status(400).json({ error: 'Invalid period format. Use format: 7days, 1month, etc.' });
    }

    const value = parseInt(periodMatch[1]);
    const unit = periodMatch[2];

    switch (unit) {
      case 'day':
        startDate = new Date();
        startDate.setDate(endDate.getDate() - value);
        break;
      case 'week':
        startDate = new Date();
        startDate.setDate(endDate.getDate() - (value * 7));
        break;
      case 'month':
        startDate = new Date();
        startDate.setMonth(endDate.getMonth() - value);
        break;
      default:
        return res.status(400).json({ error: 'Invalid period unit. Use: days, weeks, months' });
    }

    const usage = await db.getTokenUsageForPeriod(startDate, endDate);
    res.json({ usage });
  } catch (error: any) {
    console.error('Failed to get token usage for period:', error);
    res.status(500).json({ error: 'Failed to retrieve token usage for period' });
  }
});

app.get('/api/sessions/:sessionId/token-usage', async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;
    const provider = realtimeManager.getProvider();

    if (!provider || typeof provider.getSessionTokenUsage !== 'function') {
      return res.status(400).json({ error: 'Token usage tracking not available for this provider' });
    }

    const usage = provider.getSessionTokenUsage(sessionId);
    if (!usage) {
      return res.status(404).json({ error: 'No token usage data found for this session' });
    }

    res.json({ usage });
  } catch (error: any) {
    console.error('Failed to get session token usage:', error);
    res.status(500).json({ error: 'Failed to retrieve session token usage' });
  }
});

// Per-language STT/LLM/TTS engine mapping. Only Telugu/Hindi are configurable from the UI;
// English keeps its built-in defaults. Unknown/invalid stored values fall back to these.
const ENGINE_MAP_DEFAULTS = {
  'te-IN': { stt: 'sarvam', llm: 'sarvam', tts: 'sarvam' },
  'hi-IN': { stt: 'sarvam', llm: 'sarvam', tts: 'openai' }
};
const VALID_ENGINES = {
  stt: ['sarvam'],                          // only Sarvam streaming STT is wired today
  llm: ['sarvam', 'openai'],
  tts: ['sarvam', 'openai', 'elevenlabs']
} as const;

// Parse the stored engine_map JSON into a sanitized, fully-populated map (always te-IN + hi-IN,
// each with a valid stt/llm/tts). Tolerates null, bad JSON, missing keys and invalid engines.
const parseEngineMap = (raw: string | null | undefined) => {
  let parsed: any = {};
  if (raw) { try { parsed = JSON.parse(raw) || {}; } catch { parsed = {}; } }
  const out: any = {};
  for (const lang of ['te-IN', 'hi-IN'] as const) {
    const def = ENGINE_MAP_DEFAULTS[lang];
    const cur = parsed[lang] || {};
    out[lang] = {
      stt: (VALID_ENGINES.stt as readonly string[]).includes(cur.stt) ? cur.stt : def.stt,
      llm: (VALID_ENGINES.llm as readonly string[]).includes(cur.llm) ? cur.llm : def.llm,
      tts: (VALID_ENGINES.tts as readonly string[]).includes(cur.tts) ? cur.tts : def.tts
    };
  }
  return out;
};

// Settings configuration endpoint
app.get('/api/settings/config', async (req: any, res: any) => {
  try {
    const settings = await db.getAllSettings();
    const setting = settings && settings.length > 0 ? settings[0] : null;
    if (setting) {
      res.json({
        id: setting.id,
        provider: (setting as any).provider || 'openai',
        model: setting.model,
        openaiApiKey: process.env.OPENAI_API_KEY || '', // Use .env value as default
        retellAIApiKey: (setting as any).retellai_api_key || '',
        retellAIAgentId: (setting as any).retellai_agent_id || '',
        medicalInstructions: setting.medical_instructions || MEDICAL_INTAKE_INSTRUCTIONS_NEW, // Use constants as default
        voice: setting.voice,
        temperature: setting.temperature,
        maxResponseLength: setting.max_response_length,
        engineMap: parseEngineMap((setting as any).engine_map)
      });
    } else {
      // No settings table exists yet, return defaults
      res.json({
        id: 1,
        model: 'gpt-4o-realtime-preview',
        openaiApiKey: process.env.OPENAI_API_KEY || '', // Use .env value as default
        medicalInstructions: MEDICAL_INTAKE_INSTRUCTIONS_NEW, // Use constants as default
        voice: 'alloy',
        temperature: 0.6,
        maxResponseLength: 200,
        engineMap: parseEngineMap(null)
      });
    }
  } catch (error: any) {
    console.error('Failed to get settings config:', error);
    res.status(500).json({ error: 'Failed to retrieve settings configuration' });
  }
});

// Validate medical instructions format and content
const validateMedicalInstructions = (instructions: string): { isValid: boolean; error?: string } => {
  if (!instructions || typeof instructions !== 'string') {
    return { isValid: false, error: 'Medical instructions must be a non-empty string' };
  }

  if (instructions.trim().length === 0) {
    return { isValid: false, error: 'Medical instructions cannot be empty' };
  }

  if (instructions.length > 10000) {
    return { isValid: false, error: 'Medical instructions are too long (max 10000 characters)' };
  }

  // Test JSON serialization to catch encoding issues
  try {
    JSON.stringify({ instructions });
    return { isValid: true };
  } catch (e) {
    return { isValid: false, error: 'Medical instructions contain invalid characters or formatting' };
  }
};

// Save settings configuration
app.post('/api/settings/config', async (req: any, res: any) => {
  try {
    const settingsData = req.body;

    // Validate required fields
    if (!settingsData.model || !settingsData.medicalInstructions) {
      return res.status(400).json({
        error: 'Model and medical instructions are required'
      });
    }

    // Validate medical instructions format
    const validation = validateMedicalInstructions(settingsData.medicalInstructions);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Invalid medical instructions',
        message: validation.error,
        details: 'Please check for special characters, encoding issues, or excessive length'
      });
    }

    console.log(`💾 Saving settings with medical instructions (${settingsData.medicalInstructions.length} chars)`);

    const mappedSettings = {
      id: Number(settingsData.id), // ensure number
      provider: settingsData.provider || 'openai',
      model: String(settingsData.model),
      openai_api_key: settingsData.openaiApiKey ?? null,
      retellai_api_key: settingsData.retellAIApiKey ?? null,
      retellai_agent_id: settingsData.retellAIAgentId ?? null,
      medical_instructions: String(settingsData.medicalInstructions),
      voice: String(settingsData.voice ?? 'alloy'),
      temperature: Number(settingsData.temperature ?? 0.6), // ensure number
      max_response_length: Number(settingsData.maxResponseLength ?? 200),
      // Sanitize before storing so the DB only ever holds a valid map.
      engine_map: JSON.stringify(parseEngineMap(
        settingsData.engineMap ? JSON.stringify(settingsData.engineMap) : null
      )),
    };

    // Save to DB
    console.log('Saving settings:', mappedSettings);
    await db.saveSettings(mappedSettings);      
    const settings = await db.getAllSettings();
    const savedSettings = settings && settings.length > 0 ? settings[0] : null;

    if (savedSettings) {
      // Return saved settings
      res.json({
        id: savedSettings.id,
        provider: savedSettings.provider || 'openai',
        model: savedSettings.model,
        openaiApiKey: savedSettings.openai_api_key || '',
        retellAIApiKey: (savedSettings as any).retellai_api_key || '',
        retellAIAgentId: (savedSettings as any).retellai_agent_id || '',
        medicalInstructions: savedSettings.medical_instructions || '',
        voice: savedSettings.voice,
        temperature: savedSettings.temperature,
        maxResponseLength: savedSettings.max_response_length,
        engineMap: parseEngineMap((savedSettings as any).engine_map),
        message: 'Settings saved successfully'
      });
    } else {
      res.status(500).json({ error: 'Failed to save settings' });
    }
  } catch (error: any) {
    console.error('Failed to save settings:', error);
    res.status(500).json({ error: 'Failed to save settings', details: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    // Basic input validation.
    if (typeof username !== 'string' || typeof password !== 'string' ||
        username.trim().length === 0 || username.length > 100 ||
        password.length === 0 || password.length > 200) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const ip = req.ip;
    const userAgent = (req.get('User-Agent') || '').slice(0, 250);

    const result = await db.loginUser(username.trim(), password, ip, userAgent);
    res.json(result);
  } catch (err: any) {
    // Generic message — don't reveal whether the username or password was wrong.
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

// --------------------- ADMIN: USER MANAGEMENT (admin role only) ---------------------
app.get('/api/admin/users', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    res.json({ users: await db.listUsers() });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list users' });
  }
});

app.post('/api/admin/users', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const { username, email, password, role } = req.body || {};
    const allowedRoles = ['admin', 'doctor', 'nurse', 'clinician'];
    if (typeof username !== 'string' || username.trim().length < 3 || username.length > 100) {
      return res.status(400).json({ error: 'Username must be 3-100 characters.' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const userRole = allowedRoles.includes(role) ? role : 'clinician';
    await db.registerUser(username.trim(), (email || '').toString().slice(0, 250), password, userRole);
    await db.insertAuditLog({
      action: 'user_created',
      details: JSON.stringify({ username: username.trim(), role: userRole, by: req.user?.username }),
      user_id: null, session_id: null, ip_address: req.ip || null
    });
    res.status(201).json({ message: 'User created', username: username.trim(), role: userRole });
  } catch (err: any) {
    // Unique-constraint violation -> username already exists
    const msg = /unique|duplicate/i.test(err?.message || '') ? 'Username already exists' : 'Failed to create user';
    res.status(400).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOTE PATIENT INTAKE LINKS
// Admin generates a per-patient link; the patient opens it on their own phone (no
// login, no app) and does the same voice intake. Admin routes are JWT+admin-gated;
// public routes authorize via the opaque link token (see the global gate exemption).
// ─────────────────────────────────────────────────────────────────────────────
const INTAKE_LINK_TTL_MS = 24 * 60 * 60 * 1000; // links expire 24h after creation

// Fold expiry + the linked session's live status into a single status for the admin UI.
function deriveLinkDisplayStatus(link: any, now: number): string {
  if (link.status === 'revoked') return 'revoked';
  if (link.status === 'completed' || link.session_status === 'completed') return 'completed';
  if (link.status === 'pending' && link.expires_at && new Date(link.expires_at).getTime() < now) return 'expired';
  if (link.status === 'in_progress') return link.session_status === 'error' ? 'error' : 'in_progress';
  return link.status; // pending
}

// Load a link and decide whether it can still be used. Returns { link } when usable, or an
// { httpStatus, body } describing why not. Never 401/403 (so the SPA fetch interceptor, if a
// staff token happens to be present, won't clear the admin's auth).
async function loadUsableIntakeLink(token: string): Promise<{ link?: any; httpStatus?: number; body?: any }> {
  const link = await db.getIntakeLinkByToken(String(token || ''));
  if (!link) return { httpStatus: 404, body: { error: 'invalid', message: 'This link is not valid.' } };
  if (link.status === 'revoked') return { httpStatus: 409, body: { error: 'revoked', message: 'This link has been cancelled. Please contact the clinic.' } };
  if (link.status === 'completed') return { httpStatus: 409, body: { error: 'completed', message: 'This intake has already been completed. Thank you!' } };
  if (link.status === 'pending' && link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    return { httpStatus: 410, body: { error: 'expired', message: 'This link has expired. Please ask the clinic for a new one.' } };
  }
  return { link };
}

// Admin: generate a new intake link for a patient.
app.post('/api/intake-links', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const { patientName, phone, language } = req.body || {};
    const lang = ['te-IN', 'hi-IN', 'en-IN'].includes(language) ? language : 'te-IN';
    const phoneTrimmed = (phone && String(phone).trim()) || '';
    const nameTrimmed = (patientName && String(patientName).trim()) || '';

    // Pre-tie to a patient record by phone (create if new) so the resulting session links to the
    // patient's history. We do NOT increment the visit count here — that happens when the patient
    // actually starts the intake (inside createIntakeSession, keyed off the same phone).
    let patientId: number | null = null;
    if (phoneTrimmed) {
      try {
        let patient = await db.findPatientByPhone(phoneTrimmed);
        if (!patient) patient = await db.createPatient(phoneTrimmed);
        patientId = patient.id;
        if (nameTrimmed) await db.updatePatientNameIfEmpty(patientId, nameTrimmed);
      } catch (e: any) {
        console.error('intake-link patient resolve failed:', e?.message || e);
      }
    }

    const token = crypto.randomBytes(32).toString('hex'); // 64-char opaque URL secret
    const expiresAt = new Date(Date.now() + INTAKE_LINK_TTL_MS);

    const link = await db.createIntakeLink({
      token,
      created_by: req.user?.username || null,
      patient_id: patientId,
      patient_name: nameTrimmed || null,
      phone: phoneTrimmed || null,
      language: lang,
      expires_at: expiresAt
    });

    await db.insertAuditLog({
      action: 'intake_link_created',
      details: JSON.stringify({ link_id: link.id, by: req.user?.username, language: lang, hasPhone: !!phoneTrimmed }),
      session_id: null, ip_address: req.ip || null
    }).catch(() => {});

    res.status(201).json({ id: link.id, token, path: `/intake/${token}`, status: link.status, language: lang, expiresAt });
  } catch (error: any) {
    console.error('Failed to create intake link:', error);
    res.status(500).json({ error: 'Failed to create intake link', details: error.message });
  }
});

// Admin: list intake links (paginated, newest first) with a derived display status.
app.get('/api/intake-links', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const result = await db.getIntakeLinksPaginated(page, limit);
    const now = Date.now();
    const links = result.links.map((l: any) => ({ ...l, displayStatus: deriveLinkDisplayStatus(l, now) }));
    res.json({
      links,
      pagination: { currentPage: result.currentPage, totalPages: result.totalPages, totalCount: result.total, pageSize: limit }
    });
  } catch (error: any) {
    console.error('Failed to list intake links:', error);
    res.status(500).json({ error: 'Failed to list intake links', details: error.message });
  }
});

// Admin: revoke a link (cannot revoke an already-completed one).
app.post('/api/intake-links/:id/revoke', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const link = await db.getIntakeLinkById(id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (link.status === 'completed') return res.status(409).json({ error: 'Link already completed' });
    await db.setIntakeLinkStatus(id, 'revoked');
    await db.insertAuditLog({ action: 'intake_link_revoked', details: JSON.stringify({ link_id: id, by: req.user?.username }), session_id: null, ip_address: req.ip || null }).catch(() => {});
    res.json({ message: 'Link revoked', id });
  } catch (error: any) {
    console.error('Failed to revoke intake link:', error);
    res.status(500).json({ error: 'Failed to revoke intake link', details: error.message });
  }
});

// Admin only: permanently delete an intake-link record (keeps any linked session/intake data).
app.delete('/api/intake-links/:id', authenticateJWT, requireRole('admin'), async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const link = await db.getIntakeLinkById(id);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    await db.deleteIntakeLink(id);
    await db.insertAuditLog({ action: 'intake_link_deleted', details: JSON.stringify({ link_id: id, by: req.user?.username }), session_id: null, ip_address: req.ip || null }).catch(() => {});
    console.log(`🗑️  Intake link ${id} deleted by ${req.user?.username}`);
    res.json({ message: 'Link deleted', id });
  } catch (error: any) {
    console.error('Failed to delete intake link:', error);
    res.status(500).json({ error: 'Failed to delete intake link', details: error.message });
  }
});

// Public: validate a link (no login). Returns minimal info only — never PHI.
app.get('/api/public/intake/:token', async (req: any, res: any) => {
  try {
    const r = await loadUsableIntakeLink(req.params.token);
    if (!r.link) return res.status(r.httpStatus!).json(r.body);
    // Expose the configured provider so the patient page can hide Telugu/Hindi on English-only
    // providers (OpenAI/Retell) — only the Sarvam pipeline supports te/hi.
    const settings = await db.getAllSettings();
    const provider = (settings && settings.length > 0 ? (settings[0] as any).provider : '') || 'openai';
    res.json({ valid: true, status: r.link.status, language: r.link.language, provider });
  } catch (error: any) {
    console.error('Failed to validate intake link:', error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Public: patient consents and starts the intake — creates the session + a scoped WS token.
app.post('/api/public/intake/:token/start', expensiveLimiter, async (req: any, res: any) => {
  try {
    const r = await loadUsableIntakeLink(req.params.token);
    if (!r.link) return res.status(r.httpStatus!).json(r.body);
    const link = r.link;

    const { consentGiven, language } = req.body || {};
    const lang = ['te-IN', 'hi-IN', 'en-IN'].includes(language) ? language : link.language;

    let result;
    try {
      result = await createIntakeSession({
        patientName: link.patient_name || undefined,
        consentGiven: consentGiven === true,
        language: lang,
        phone: link.phone || undefined,
        source: 'remote-link',
        ip: req.ip || null,
        userAgent: req.headers['user-agent'] || null
      });
    } catch (e: any) {
      if (e instanceof IntakeSessionError) return res.status(e.httpStatus).json(e.payload);
      throw e;
    }

    await db.setIntakeLinkSession(link.id, result.sessionId);
    await db.insertAuditLog({
      action: 'intake_link_started',
      details: JSON.stringify({ link_id: link.id, session_id: result.sessionId }),
      session_id: result.sessionId, ip_address: req.ip || null
    }).catch(() => {});

    // Short-lived WS token scoped to THIS session only (patients have no account). The WS
    // join_session handler binds it to result.sessionId, so it can't join anything else.
    const wsToken = jwt.sign(
      { scope: 'patient-intake', sessionId: result.sessionId, linkId: link.id },
      getJwtSecret(),
      { expiresIn: '2h' }
    );

    res.json({ sessionId: result.sessionId, wsToken, provider: result.provider, language: lang });
  } catch (error: any) {
    console.error('Failed to start public intake:', error);
    res.status(500).json({ error: 'Failed to start the session. Please try again.' });
  }
});

// Public: mark the intake complete (idempotent) — called when the patient ends the session.
app.post('/api/public/intake/:token/complete', async (req: any, res: any) => {
  try {
    const link = await db.getIntakeLinkByToken(String(req.params.token || ''));
    if (!link) return res.status(404).json({ error: 'invalid' });
    if (link.status !== 'completed') {
      await db.setIntakeLinkStatus(link.id, 'completed');
      await db.insertAuditLog({
        action: 'intake_link_completed',
        details: JSON.stringify({ link_id: link.id, session_id: link.session_id }),
        session_id: link.session_id || null, ip_address: req.ip || null
      }).catch(() => {});
    }
    res.json({ message: 'completed' });
  } catch (error: any) {
    console.error('Failed to complete public intake:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// WebSocket connection for real-time communication
wss.on('connection', (ws: any, req: any) => {
  console.log('WebSocket connection established');
  let currentSessionId: string | null = null;
  ws.sessionId = null; // Store sessionId on WebSocket object as well
  ws.authenticated = false; // set true once a valid JWT is presented on join_session

  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      //console.log('WS received message:', message.type);

      // Every message except join_session requires an authenticated socket.
      if (message.type !== 'join_session' && !ws.authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
        return;
      }

      switch (message.type) {
        case 'join_session': {
          // Authenticate the WebSocket with the same JWT used for the REST API.
          // Browsers cannot set WS headers, so the token is sent in this message.
          try {
            const decoded: any = jwt.verify(String(message.token || ''), getJwtSecret());
            // Patient-link tokens are scoped to ONE session: bind them so a leaked token can't be
            // used to join any other session. Staff tokens (no scope) keep full access as before.
            if (decoded.scope === 'patient-intake') {
              if (!decoded.sessionId || decoded.sessionId !== message.sessionId) {
                console.log('❌ WebSocket join rejected: patient token / session mismatch');
                ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
                ws.close();
                return;
              }
              ws.authenticated = true;
              ws.user = { role: 'patient', sessionId: decoded.sessionId };
            } else {
              ws.authenticated = true;
              ws.user = { id: decoded.id, username: decoded.username, role: decoded.role };
            }
          } catch {
            console.log('❌ WebSocket join rejected: invalid/missing token');
            ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
            ws.close();
            return;
          }

          currentSessionId = message.sessionId;
          ws.sessionId = currentSessionId; // Store on WebSocket object

          // Get the Realtime API connection for this session
          const realtimeConnection = realtimeManager.getSession(currentSessionId!);
          if (realtimeConnection) {
            // Link frontend WebSocket to realtime session. The provider then drives
            // all session events itself (session_ready, status, transcripts, audio…),
            // so the server no longer injects its own join/status messages.
            realtimeManager.linkFrontendSocket(currentSessionId!, ws);
            console.log(`✅ Frontend WebSocket linked to session ${currentSessionId}`);
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Session not found or inactive'
            }));
            console.log(`❌ Session ${currentSessionId} not found for WebSocket linking`);
          }
          break;
        }

        case 'audio_data': {
          // Forward microphone audio to the provider. The provider decides what to do
          // with it (and drives all status/transcript/audio events back to the client).
          const sessionIdForAudio = ws.sessionId || currentSessionId;
          if (sessionIdForAudio && realtimeManager.getSession(sessionIdForAudio)) {
            try {
              realtimeManager.sendAudioData(sessionIdForAudio, message.data);
            } catch (error: any) {
              console.error('Error forwarding audio data:', error.message);
            }
          }
          break;
        }

        case 'interrupt': {
          // User-initiated barge-in: abort the agent's current spoken turn.
          const sessionIdForInterrupt = ws.sessionId || currentSessionId;
          if (sessionIdForInterrupt && realtimeManager.getSession(sessionIdForInterrupt)) {
            try { realtimeManager.interrupt(sessionIdForInterrupt, message.source); }
            catch (error: any) { console.error('Error handling interrupt:', error.message); }
          }
          break;
        }

        case 'end_session':
          if (currentSessionId) {
            ws.send(JSON.stringify({
              type: 'session_ended'
            }));
            console.log(`Ending the session ${currentSessionId} as requested by client`);
            await realtimeManager.endSession(currentSessionId);
          }
          break;
      }

    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Message processing error'
      }));
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket connection closed for session ${currentSessionId}`);
    if (currentSessionId) {
      // Unlink frontend WebSocket from realtime session
      realtimeManager.unlinkFrontendSocket(currentSessionId);

      // The browser is the only client for a session and does not reconnect, so a
      // closed socket means the session is abandoned. End it to release the provider's
      // STT/TTS sockets (cost + leak), free the in-memory session, and mark the DB
      // row completed. endSession is idempotent, so this is safe even if the session
      // was already ended via the end_session tool or the REST endpoint.
      realtimeManager.endSession(currentSessionId)
        .catch((e: any) => console.error('endSession on ws close failed:', e?.message || e));
    }
  });

  ws.on('error', (error: Error) => {
    console.error('WebSocket error:', error);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// In-app HELP assistant (Telugu) — answers patient questions ABOUT THE APP.
// Grounded + refuses medical advice (see assistant-service.ts). Text + voice.
// Authenticated (global gate) and rate-limited (paid Sarvam calls).
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/assistant/chat', expensiveLimiter, async (req: any, res: any) => {
  try {
    const { message, history, language } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    const reply = await assistantAnswer(message, Array.isArray(history) ? history : [], language);
    res.json({ reply });
  } catch (e: any) {
    console.error('assistant/chat failed:', e?.message || e);
    res.status(500).json({ error: 'Assistant is unavailable right now.' });
  }
});

app.post('/api/assistant/tts', expensiveLimiter, async (req: any, res: any) => {
  try {
    const { text, language } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
    const audio = await assistantSpeak(text, language);
    res.json({ audio, format: 'wav' });
  } catch (e: any) {
    console.error('assistant/tts failed:', e?.message || e);
    res.status(500).json({ error: 'Speech generation failed.' });
  }
});

app.post('/api/assistant/transcribe', expensiveLimiter, async (req: any, res: any) => {
  try {
    const { audio, mime, language } = req.body || {};
    if (!audio || typeof audio !== 'string') return res.status(400).json({ error: 'audio (base64) is required' });
    const buffer = Buffer.from(audio, 'base64');
    if (buffer.length === 0) return res.status(400).json({ error: 'empty audio' });
    const text = await assistantTranscribe(buffer, typeof mime === 'string' ? mime : 'audio/webm', language);
    res.json({ text });
  } catch (e: any) {
    console.error('assistant/transcribe failed:', e?.message || e);
    res.status(500).json({ error: 'Could not understand the audio. Please try again.' });
  }
});

// Express error handler — return a clean 500 instead of leaking stack traces / crashing.
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled route error:', err?.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Process-level safety nets so a stray async error never takes the server down
// mid-consultation. (In production a supervisor like systemd/pm2 should also be used.)
process.on('unhandledRejection', (reason: any) => {
  console.error('⚠️ Unhandled promise rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err: any) => {
  console.error('⚠️ Uncaught exception:', err?.message || err);
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Medical Intake Voice Agent Backend running on port ${PORT}`);
  console.log(`🔗 WebSocket available at ws://localhost:${PORT}`);
});
