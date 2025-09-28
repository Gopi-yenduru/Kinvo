import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { OpenAI } from 'openai';
import { authenticateJWT, AuthRequest } from "./auth.js";
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3002;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Import our modules
import realtimeManager from './realtime.js';
import { MEDICAL_INTAKE_INSTRUCTIONS, REALTIME_CONFIG } from './constants.js';
import db from './database-manager.js';
import ProviderFactory from './providers/ProviderFactory.js';
import RetellAIProvider from './providers/RetellAIProvider.js';

// Middleware
app.use(cors());
app.use(express.json());

// Debug middleware to log all request
app.use((req: any, res: any, next: any) => {
  console.log(`📡 ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

// Basic health check route
app.get('/health', (req: any, res: any) => {
  res.json({ status: 'OK', message: 'Medical Intake Voice Agent Backend is running' });
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

// Start a new intake session
app.post('/api/sessions/start', authenticateJWT, async (req: any, res: any) => {
  let sessionId = uuidv4();
  try {
    const { patientName } = req.body;

    // Validate patient name
    if (!patientName || patientName.trim().length === 0) {
      return res.status(400).json({
        error: 'Patient name required',
        message: 'Patient name is required to start a session.'
      });
    }

    // Get current settings from database
    const settings = await db.getAllSettings();
    const setting = settings && settings.length > 0 ? settings[0] : null;
    console.log(`Temparature from settings: ${setting?.temperature}, max response length from settings: ${setting?.max_response_length}`);

    // Set the provider based on database settings
    const providerType = setting?.provider || 'openai';
    realtimeManager.setProvider(ProviderFactory.getProvider(providerType as any));
    console.log(`Using provider: ${providerType}`);

    // Validate API keys based on selected provider
    let apiKeyConfigured = false;
    if (providerType === 'openai') {
      apiKeyConfigured = !!(setting?.openai_api_key || process.env.OPENAI_API_KEY);
      if (!apiKeyConfigured) {
        return res.status(400).json({
          error: 'OpenAI API key missing',
          message: 'OpenAI API key not configured. Please check your Settings page or .env file.'
        });
      }
    } else if (providerType === 'retellai') {
      const retellApiKey = (setting as any)?.retellai_api_key || process.env.RETELLAI_API_KEY;
      const retellAgentId = (setting as any)?.retellai_agent_id || process.env.RETELLAI_AGENT_ID;
      apiKeyConfigured = !!(retellApiKey && retellAgentId);
      if (!apiKeyConfigured) {
        return res.status(400).json({
          error: 'RetellAI configuration missing',
          message: 'RetellAI API key and Agent ID must be configured. Please check your Settings page or .env file.'
        });
      }
    } else if (providerType === 'vapi') {
      // VAPI not implemented yet
      return res.status(400).json({
        error: 'VAPI not supported yet',
        message: 'VAPI integration is planned but not yet implemented.'
      });
    }

    if (!setting) {
      console.log('⚠️ Using API keys from .env file as fallback (database settings not configured)');
    }

    // Create session in database first
    var insertedData = await db.createSession({
      patient_id: 0,
      patient_name: patientName.trim(),
      provider: providerType,
      status: 'active',
      start_time: new Date(),
      end_time: null,
      red_flags_detected: 0
    });

    console.log(' Inserted data:', insertedData);
    console.log(' setting data:', setting);
    sessionId = insertedData.id; // use the actual session ID from DB

    // Log audit event
    let audioResult = {
      clientIp: req.ip,
      userAgent: req.headers['user-agent'],
      model: setting?.model,
      voice: setting?.voice
    };

    await db.insertAuditLog({
      action: 'session_started',
      details: JSON.stringify(audioResult),
      session_id: sessionId,
      ip_address: req.ip || null
    });

    // Initialize based on provider type
    if (providerType === 'retellai') {
      // For Retell AI, just create the session in database - no realtime connection needed
      console.log(`📝 Session ${sessionId} started successfully for Retell AI`);

      res.json({
        sessionId,
        status: 'active',
        provider: providerType,
        message: 'Session started successfully'
      });
    } else if (providerType === 'openai') {
      // For OpenAI, create session configuration and initialize Realtime API session
      const instructions = setting?.medical_instructions || MEDICAL_INTAKE_INSTRUCTIONS;

      console.log(`🔧 Creating session config for ${sessionId}`);
      console.log(`📝 Instructions source: ${setting?.medical_instructions ? 'database' : 'defaults'}`);
      console.log(`📏 Instructions length: ${instructions.length} characters`);
      console.log(`📋 Instructions preview: ${instructions.substring(0, 150)}...`);

      const config = {
        sessionId,
        instructions: setting?.medical_instructions || MEDICAL_INTAKE_INSTRUCTIONS,
        voice: setting?.voice || 'alloy',
        temperature: setting?.temperature || 0.6,
        maxResponseLength: setting?.max_response_length || 200,
        model: setting?.model || 'gpt-4o-realtime-preview',
        apiKey: setting?.openai_api_key || process.env.OPENAI_API_KEY
      };

      // Debug: Test JSON serialization
      try {
        JSON.stringify({ test: config.instructions });
        console.log('✅ Instructions JSON serialization test passed');
      } catch (jsonError) {
        console.error('❌ Instructions JSON serialization test failed:', jsonError);
        console.error('❌ Instructions content:', config.instructions);
      }

      realtimeManager.createRealtimeSession(config)
        .then((realtimeConnection: any) => {
          if (realtimeConnection) {
            console.log(`📝 Session ${sessionId} started successfully with Realtime connection`);

            res.json({
              sessionId,
              status: 'active',
              provider: providerType,
              message: 'Session started successfully'
            });
          } else {
            throw new Error('Realtime connection failed to initialize');
          }
        })
        .catch(async (error: any) => {
          console.error('Failed to create Realtime session:', error);

          // Update database on failure
          await db.updateSessionStatus(sessionId, 'error');
          await db.insertAuditLog({
            action: 'session_start_failed',
            details: JSON.stringify({ error: error.message }),
            session_id: sessionId,
            ip_address: req.ip || null
          });
          res.status(500).json({
            error: 'Failed to create session',
            message: error.message,
            details: 'Check your OpenAI API key and Realtime API access'
          });
        });
    } else if (providerType === 'vapi') {
      // VAPI not implemented yet
      return res.status(400).json({
        error: 'VAPI not supported yet',
        message: 'VAPI integration is planned but not yet implemented.'
      });
    } else {
      return res.status(400).json({
        error: 'Unknown provider',
        message: `Provider '${providerType}' is not supported.`
      });
    }

  } catch (error: any) {
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
        agentId: retellAgentId
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

// Get red flag events for all sessions (for clinician dashboard) - MUST be defined BEFORE :sessionId routes
app.get('/api/sessions/red-flags', async (req: any, res: any) => {
  console.log('📡 REQUEST DETAILS:', {
    method: req.method,
    url: req.url,
    path: req.path,
    headers: req.headers
  });
  try {
    console.log('🔍 DEBUG: Fetching red flags for all sessions');
    const redFlags: any[] = [];

    // Get all sessions to include completed ones that may have red flags
    const sessions = await db.getAllSessions();

    console.log(`🔍 DEBUG: Found ${sessions?.length || 0} sessions`);

    if (sessions && sessions.length > 0) {
      await Promise.all(sessions.map(async (session: any) => {
        console.log(`🔍 DEBUG: Checking session ${session.id} for red flags`);
        try {
          const sessionRedFlags = await db.getRedFlagEvents(session.id);
          console.log(`🔍 DEBUG: Session ${session.id} has ${sessionRedFlags?.length || 0} red flags`);
          if (sessionRedFlags && sessionRedFlags.length > 0) {
            redFlags.push(...sessionRedFlags);
          }
        } catch (sessionError: any) {
          console.error(`🔍 DEBUG: Error getting red flags for session ${session.id}:`, sessionError.message);
        }
      }));
    }

    // Sort by timestamp (most recent first)
    redFlags.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    console.log(`🔍 DEBUG: Returning ${redFlags.length} total red flags`);

    res.json({ redFlags });
  } catch (error: any) {
    console.error('Failed to get red flag events:', error);
    res.status(500).json({ error: 'Failed to retrieve red flag events', details: error.message });
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

// Get all active sessions
app.get('/api/sessions', async (req: any, res: any) => {
  console.log('🔍 DEBUG: Getting all sessions');
  try {
    const sessions = await db.getAllSessions();
    res.json({ sessions: sessions || [] });
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

// Generate report using OpenAI
app.post('/api/sessions/:sessionId/generate-report', async (req: any, res: any) => {
  try {
    const { sessionId } = req.params;

    // Get settings for API key   
    const settings = await db.getAllSettings();
    const setting = settings && settings.length > 0 ? settings[0] : null;
    const apiKey = setting?.openai_api_key || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(400).json({ error: 'OpenAI API key not configured' });
    }

    // Initialize OpenAI client
    const openai = new OpenAI({ apiKey });

    // Get conversation logs
    const conversationLogs = await db.getSessionConversationLogs(sessionId);
    if (!conversationLogs || conversationLogs.length === 0) {
      return res.status(404).json({ error: 'No conversation data found for this session' });
    }
    console.log(`📝 Generating report for session ${sessionId} with ${conversationLogs.length} conversation lines`);

    // Get session info and red flags
    const sessionInfo = await db.getSession(sessionId);
    console.log(' Session info:', sessionInfo);
    const redFlagEvents = await db.getRedFlagEvents(sessionId);
    console.log(` Session has ${redFlagEvents?.length || 0} red flag events`);

    // Format conversation for prompt
    const conversationText = conversationLogs.map((log: any) =>
      `${log.speaker.toUpperCase()}: ${log.message}`
    ).join('\n\n');

    const prompt = `Please generate a comprehensive medical intake report based on the following conversation transcript.

Session Information:
- Patient Name: ${sessionInfo?.patient_name || 'Not specified'}
- Session Date: ${(sessionInfo?.start_time ? new Date(sessionInfo.start_time).toLocaleDateString() : 'Not specified')}
- Duration: ${sessionInfo?.end_time ? Math.round((new Date(sessionInfo.end_time).getTime() - new Date(sessionInfo.start_time).getTime()) / 1000 / 60) + ' minutes' : 'Ongoing'}
- Red Flags Detected: ${redFlagEvents?.length || 0}

Conversation Transcript:
${conversationText}

Please structure the report with the following sections:
1. Patient Information
2. Chief Complaint / Presenting Symptoms
3. Medical History
4. Current Medications/Allergies (if mentioned)
5. Assessment/Recommendations
6. Red Flags Identified (if any)

Make the report professional, concise, and suitable for medical records.`;

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a medical assistant generating intake reports from conversation transcripts.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });

    const report = completion.choices[0]?.message?.content?.trim();

    if (!report) {
      return res.status(500).json({ error: 'Failed to generate report from OpenAI' });
    }

    // Log audit event   
    await db.insertAuditLog({
      action: 'report_generated',
      details: JSON.stringify({ lines: conversationLogs.length }),
      session_id: sessionId,
      ip_address: req.ip || null
    });

    res.json({ report });

  } catch (error: any) {
    console.error('Failed to generate report:', error);
    res.status(500).json({ error: 'Failed to generate report', details: error.message });
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
        medicalInstructions: setting.medical_instructions || MEDICAL_INTAKE_INSTRUCTIONS, // Use constants as default
        voice: setting.voice,
        temperature: setting.temperature,
        maxResponseLength: setting.max_response_length
      });
    } else {
      // No settings table exists yet, return defaults
      res.json({
        id: 1,
        model: 'gpt-4o-realtime-preview',
        openaiApiKey: process.env.OPENAI_API_KEY || '', // Use .env value as default
        medicalInstructions: MEDICAL_INTAKE_INSTRUCTIONS, // Use constants as default
        voice: 'alloy',
        temperature: 0.6,
        maxResponseLength: 200
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
    const { username, password } = req.body;
    const ip = req.ip;
    const userAgent = req.get('User-Agent') || '';

    const result = await db.loginUser(username, password, ip, userAgent);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

// WebSocket connection for real-time communication
wss.on('connection', (ws: any, req: any) => {
  console.log('WebSocket connection established');
  let currentSessionId: string | null = null;
  ws.sessionId = null; // Store sessionId on WebSocket object as well

  ws.on('message', async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('WS received message:', message.type);

      switch (message.type) {
        case 'join_session':
          currentSessionId = message.sessionId;
          ws.sessionId = currentSessionId; // Store on WebSocket object

          // Get the Realtime API connection for this session
          const realtimeConnection = realtimeManager.getSession(currentSessionId!);
          if (realtimeConnection) {
            // Link frontend WebSocket to realtime session
            realtimeManager.linkFrontendSocket(currentSessionId!, ws);

            ws.send(JSON.stringify({
              type: 'session_joined',
              sessionId: currentSessionId,
              message: 'Connected to voice agent'
            }));

            ws.send(JSON.stringify({
              type: 'listening',
              message: 'Agent is listening'
            }));

            console.log(`✅ Frontend WebSocket linked to session ${currentSessionId}`);
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Session not found or inactive'
            }));
            console.log(`❌ Session ${currentSessionId} not found for WebSocket linking`);
          }
          break;

        case 'audio_data':
          // Forward simplified audio data to Realtime API
          const sessionIdForAudio = ws.sessionId || currentSessionId;
          if (sessionIdForAudio && realtimeManager.getSession(sessionIdForAudio)) {
            try {
              // Pass the data object directly to realtime manager (simplified format)
              // 🟢 Agent is now processing/responding → tell frontend "speaking"
              ws.send(JSON.stringify({
                type: 'speaking',
                message: 'Agent is speaking'
              }));
              realtimeManager.sendAudioData(sessionIdForAudio, message.data);
              console.log(`📡 Audio data forwarded for session ${sessionIdForAudio}`);
            } catch (error: any) {
              console.error('Error forwarding audio data:', error.message);
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to process audio data: ' + error.message
              }));
            }
          } else {
            console.warn(`⚠️ Audio data received but no active session found (sessionId: ${sessionIdForAudio})`);
            ws.send(JSON.stringify({
              type: 'error',
              message: 'No active session - please join a session first'
            }));
            console.log('Available sessions:', Array.from(Object.keys(realtimeManager.connections || {})));
          }
          break;

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

      // Clean up session if requested
      if (ws.sessions?.shouldEnd === true) {
        realtimeManager.endSession(currentSessionId).catch(console.error);
      }
    }
  });

  ws.on('error', (error: Error) => {
    console.error('WebSocket error:', error);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Medical Intake Voice Agent Backend running on port ${PORT}`);
  console.log(`🔗 WebSocket available at ws://localhost:${PORT}`);
});