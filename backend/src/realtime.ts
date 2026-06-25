import WebSocket from 'ws';
import db from './database-manager.js';
import { RED_FLAG_PATTERNS, RED_FLAG_SEVERITY_MAP, RED_FLAG_SEVERITY, MEDICAL_INTAKE_INSTRUCTIONS, MEDICAL_INTAKE_INSTRUCTIONS_NEW } from './constants.js';
import { BaseProvider } from './providers/BaseProvider.js';
import ProviderFactory from './providers/ProviderFactory.js';

interface RealtimeConfig {
  sessionId: string;
  instructions: string;
  voice: string;
  temperature: number;
  maxResponseLength: number;
  model?: string; // New: dynamic model selection
  apiKey?: string; // New: dynamic API key selection
}

class RealtimeSessionManager {
  private provider: BaseProvider = ProviderFactory.getProvider('openai'); // Default to OpenAI
  public connections: Map<string, any> = new Map();
  private frontendSockets: Map<string, any> = new Map(); // Track frontend WebSocket for each session
  private agentTextBuffers: Map<string, string> = new Map(); // Accumulate full agent responses
  private agentFrontendBuffers: Map<string, string> = new Map(); // Backup - accumulate agent text sent to frontend
  private lastAgentResponse: Map<string, string> = new Map(); // Track recent agent responses to prevent duplicates



  // Add inside class
 private recentPatientActivity: Map<string, number> = new Map(); // ms epoch for last patient delta/speech stop
 private pendingAgentSaves: Map<string, Array<{ transcript: string; ts: string; timer: any }>> = new Map();
 private patientTurnTimestamp: Map<string, number> = new Map(); // Stores patient speech start timestamp per session
 private responseInProgress: Map<string, boolean> = new Map(); // Tracks if AI response is currently being generated
 private lastPatientTranscript: Map<string, string> = new Map(); // Tracks last processed patient transcript to prevent duplicates
 private AGENT_DEFER_MS = 800; // how long to wait for patient transcript before saving agent (tune as needed)
 private RECENT_PATIENT_WINDOW_MS = 1000; // how recent is considered 'patient activity'

 setProvider(provider: BaseProvider) {
   this.provider = provider;
 }

 getProvider(): BaseProvider {
   return this.provider;
 }

private saveAgentTranscriptImmediate(sessionId: string, transcript: string, ts: string) {
  try {
    console.log(`🤖 Saving agent transcript for ${sessionId}: "${transcript}"`);
    db.saveConversationLog({
      session_id: sessionId,
      speaker: 'agent',
      message: transcript,
      audio_data: JSON.stringify({ source: 'response.audio_transcript.done' })
    });
    // update lastAgent saved to avoid duplicates
    this.lastAgentResponse.set(sessionId, transcript);
  } catch (err) {
    console.error(`Failed to save agent transcript for ${sessionId}:`, err);
  }
}


  private validateInstructions(instructions: string): string {
    if (!instructions || instructions.trim().length === 0) {
      console.warn('Empty instructions, using defaults');
      return MEDICAL_INTAKE_INSTRUCTIONS;
    }

    // Truncate if too long (OpenAI has limits)
    if (instructions.length > 8000) {
      console.warn(`Instructions too long (${instructions.length} chars), truncating to 8000 characters`);
      return instructions.substring(0, 8000);
    }

    // Final JSON validation and character cleanup
    try {
      JSON.stringify({ test: instructions });
      return instructions;
    } catch (e) {
      console.error('Instructions contain invalid JSON characters, cleaning up...');
      // Remove control characters that can break JSON
      const cleaned = instructions.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
      try {
        JSON.stringify({ test: cleaned });
        console.log('Successfully cleaned up instructions');
        return cleaned;
      } catch (e2) {
        console.error('Still invalid after cleanup, using fallback');
        return MEDICAL_INTAKE_INSTRUCTIONS;
      }
    }
  }

  async createRealtimeSession(config: RealtimeConfig): Promise<WebSocket | null> {
    return this.provider.createRealtimeSession(config);
  }

  // Keep the old implementation as fallback or remove it
  async _createRealtimeSessionOld(config: RealtimeConfig): Promise<WebSocket | null> {
    return new Promise((resolve, reject) => {
      try {
        // Check if API key is available
        console.log(`🤖 OpenAI API key: ${process.env.OPENAI_API_KEY}`);
        if (!config.apiKey && (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here')) {
          console.error('OpenAI API key not configured properly');
          reject(new Error('OpenAI API key is required but not configured'));
          return;
        }

        console.log(`Creating Realtime session for ${config.sessionId}...`);

        // Dynamic model selection and API key
        const modelName = config.model || 'gpt-realtime';
        const apiKey = config.apiKey || process.env.OPENAI_API_KEY;

        if (!apiKey || apiKey === 'your_openai_api_key_here') {
          console.error('OpenAI API key is required but not configured');
          reject(new Error('OpenAI API key is required but not configured'));
          return;
        }

        console.log(`🔗 Connecting to OpenAI Realtime API with model: ${modelName}`);

        // Direct WebSocket connection to OpenAI Realtime API with dynamic model
        const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${modelName}`, [], {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        // Set up timeout
        const connectionTimeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.on('open', () => {
          clearTimeout(connectionTimeout);
          console.log(`✅ OpenAI Realtime WebSocket connected for session ${config.sessionId}`);

          // Validate and clean instructions before using
          const validatedInstructions = this.validateInstructions(config.instructions);
          console.log(`📝 Using validated instructions (${validatedInstructions.length} chars)`);
          console.log('Instructions preview:', validatedInstructions.substring(0, 200) + '...');

          // Send session configuration
          const sessionConfig = {
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: validatedInstructions,
              voice: config.voice || 'alloy',
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              input_audio_transcription: { model: 'whisper-1' },
              turn_detection: {
                type: "server_vad",
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: false
              },
              tools: this.getFunctionTools(),
              temperature: config.temperature || 0.1,
              max_response_output_tokens: 'inf'
            }
          };

          try {
            const configString = JSON.stringify(sessionConfig);
            console.log(`📤 Sending session config (${configString.length} bytes)`);
            console.log('Session config content:', JSON.stringify(sessionConfig, null, 2));
            ws.send(configString);
            this.connections.set(config.sessionId, ws);
            resolve(ws);
          } catch (sendError) {
            console.error('Error sending session config:', sendError);
            console.error('Config that failed:', sessionConfig);
            reject(sendError);
          }
        });

        ws.on('message', (data: Buffer) => {
          try {
            const event = JSON.parse(data.toString());

            // Add specific error handling for session.update failures
            if (event.type === 'error' && event.error?.message) {
              console.error(`❌ Session update error for ${config.sessionId}:`, event.error);
              if (event.error.message.includes('instructions') || event.error.message.includes('session')) {
                console.error('❌ Instructions-related error detected');
                console.error('❌ Original instructions:', config.instructions);
              }
            }

            console.warn(`⚠️ Legacy WebSocket message received but no handler implemented in realtime.ts`);
            console.warn(`This should be handled by the OpenAIProvider via delegation`);
          } catch (messageError) {
            console.error('Error handling message:', messageError);
            if (messageError instanceof Error && messageError.message.includes('JSON')) {
              console.error('Possible JSON parsing issue with OpenAI response');
            }
          }
        });

        ws.on('error', (error: any) => {
          clearTimeout(connectionTimeout);
          console.error(`❌ Realtime WebSocket error for session ${config.sessionId}:`, error.message);
          console.error(`❌ Error details:`, error);

          // Check for common OpenAI API key errors
          if (error.message.includes('401') || error.message.includes('authentication') || error.message.includes('unauthorized')) {
            reject(new Error('Invalid OpenAI API key. Please check your settings and ensure you have Realtime API access enabled.'));
          } else if (error.message.includes('403')) {
            reject(new Error('OpenAI API key does not have Realtime API access. Please enable Realtime API in your OpenAI account.'));
          } else {
            reject(new Error(`Realtime connection failed: ${error.message}`));
          }
        });

        ws.on('close', () => {
          clearTimeout(connectionTimeout);
          console.log(`📪 Realtime WebSocket closed for session ${config.sessionId}`);
          this.connections.delete(config.sessionId);
        });

      } catch (error) {
        console.error('Failed to create Realtime connection:', error);
        reject(error);
      }
    });
  }

  private getFunctionTools(): any[] {
    return [
      {
        type: 'function',
        name: 'red_flag_detected',
        description: 'ALERT IMMEDIATE CLINICAL ATTENTION REQUIRED: Patient reported critical symptoms that need immediate medical review',
        parameters: {
          type: 'object',
          properties: {
            symptoms: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of critical symptoms mentioned by patient'
            },
            severity: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low'],
              description: 'Severity level based on medical urgency'
            }
          },
          required: ['symptoms', 'severity']
        }
      },
      {
        type: 'function',
        name: 'save_response',
        description: 'Save patient response to database',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            answer: { type: 'string' },
            category: { type: 'string' }
          },
          required: ['question', 'answer']
        }
      },
      {
        type: 'function',
        name: 'log_conversation',
        description: 'Log all conversations for audit trail',
        parameters: {
          type: 'object',
          properties: {
            speaker: { type: 'string' },
            message: { type: 'string' }
          },
          required: ['speaker', 'message']
        }
      }
    ];
  }

  // DEPRECATED: All realtime response handling has been moved to individual providers
  // (e.g. OpenAIProvider, RetellAIProvider). The manager now delegates to providers.
    
    

    
    
  
  // Handle function calls from OpenAI Realtime API
  private handleRealtimeFunctionCall(sessionId: string, name: string, argumentsJson: string) {
    try {
      console.log(`🔧 RAW FUNCTION CALL DATA:`, {
        sessionId,
        name,
        argumentsJson
      });

      const args = JSON.parse(argumentsJson);
      const functionName = name;

      console.log(`✅ Function call received: ${functionName} for session ${sessionId}`, args);

      const frontendWs = this.frontendSockets.get(sessionId);

      switch (functionName) {
        case 'red_flag_detected':
          this.handleRedFlagDetection(args, sessionId);
          if (frontendWs) {
            frontendWs.send(JSON.stringify({
              type: 'red_flag_detected',
              symptoms: args.symptoms,
              severity: args.severity,
              timestamp: new Date().toISOString()
            }));
          }
          break;

        case 'save_response':
          this.handleSaveResponse({ ...args, sessionId });
          break;

        case 'log_conversation':
          this.handleLogConversation({ ...args, sessionId });
          break;

        default:
          console.warn(`Unknown function call: ${functionName}`);
      }
    } catch (error) {
      console.error(`Error handling function call: ${error}`);
    }
  }

  // Link a frontend WebSocket to a session for bidirectional communication
  linkFrontendSocket(sessionId: string, frontendWs: any) {
    return this.provider.linkFrontendSocket(sessionId, frontendWs);
  }

  _linkFrontendSocketOld(sessionId: string, frontendWs: any) {
    this.frontendSockets.set(sessionId, frontendWs);

    // Log system message for session join
    console.log(`📝 Saving system message: Session joined - ${sessionId}`);
    db.saveConversationLog({
      session_id: sessionId,
      speaker: 'system',
      message: 'Voice agent session initialized and ready to begin intake',
      audio_data: JSON.stringify({ type: 'session_join' })
    });
    db.insertAuditLog({
      action: 'session_joined',
      details: JSON.stringify({ socketLinked: true }),
      session_id: sessionId
    });

    console.log(`✅ Frontend WebSocket linked for session ${sessionId}`);


    // NEW: Trigger agent response now that frontend is connected
    const realtimeWs = this.connections.get(sessionId);
    if (realtimeWs) {
      setTimeout(() => {
        console.log('▶️ Triggering initial agent response after frontend link');
          realtimeWs.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio","text"]
          }
        }));
      }, 500); // Keep the delay for session stability
    }
    
  }

  // Unlink frontend WebSocket when disconnected
  unlinkFrontendSocket(sessionId: string) {
    return this.provider.unlinkFrontendSocket(sessionId);
  }

  _unlinkFrontendSocketOld(sessionId: string) {
    this.frontendSockets.delete(sessionId);
    console.log(`Frontend WebSocket unlinked for session ${sessionId}`);
  }

  // Send audio data from frontend to provider
  sendAudioData(sessionId: string, audioDataObject: any) {
    return this.provider.sendAudioData(sessionId, audioDataObject);
  }

  // User-initiated barge-in: abort the agent's current spoken turn (if supported).
  interrupt(sessionId: string) {
    return this.provider.interrupt?.(sessionId);
  }

  // Old implementation
  _sendAudioDataOld(sessionId: string, audioDataObject: any) {
    const realtimeWs = this.connections.get(sessionId);
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      try {
        // Simplified handling of simplified frontend format: { pcm16: [...], timestamp: number }
        if (!audioDataObject.pcm16 || !Array.isArray(audioDataObject.pcm16)) {
          console.error('❌ Invalid audio data format. Expected {pcm16: [...], timestamp: number}');
          return;
        }

        const pcmSamples = audioDataObject.pcm16;
        console.log(`🎵 Received ${pcmSamples.length} 16-bit PCM16 samples from frontend`);

        // Convert 16-bit PCM16 samples to little-endian bytes
        const bytesNeeded = pcmSamples.length * 2;
        const pcmBytes = new Uint8Array(bytesNeeded);

        for (let i = 0; i < pcmSamples.length; i++) {
          const sample = Math.max(-32768, Math.min(32767, pcmSamples[i])); // Clamp to valid range
          const byteIndex = i * 2;

          // Little-endian: LSB (Least Significant Byte) first, MSB (Most Significant Byte) second
          pcmBytes[byteIndex] = sample & 0xff;
          pcmBytes[byteIndex + 1] = (sample >> 8) & 0xff;
        }

        // Validate we have complete samples (even number of bytes)
        if (pcmBytes.length % 2 !== 0) {
          console.error(`❌ Incomplete PCM16 samples: ${pcmBytes.length} bytes (should be even)`);
          return;
        }

        // Convert to Buffer for base64 encoding
        const pcmBuffer = Buffer.from(pcmBytes);
        const base64Audio = pcmBuffer.toString('base64');

        const audioMessage = {
          type: 'input_audio_buffer.append',
          audio: base64Audio
        };

        realtimeWs.send(JSON.stringify(audioMessage));

        const sampleCount = pcmSamples.length;
        const estimatedDuration = (sampleCount / 24000).toFixed(2);
        console.log(`✅ Sent ${sampleCount} PCM16 samples (${bytesNeeded} bytes) to OpenAI (${estimatedDuration}s at 24kHz)`);

      } catch (error: any) {
        console.error(`❌ Error sending audio data for session ${sessionId}:`, error.message);
      }
    } else {
      console.warn(`❌ Cannot send audio - no active Realtime connection for session ${sessionId}`);
    }
  }

  // Handle function call responses (updated for Realtime API)
  private handleRedFlagDetection(args: any, sessionId: string) {
    console.log(`🔴 RED FLAG DETECTED for session ${sessionId}:`, args);

    try {
      db.saveRedFlagEvent({
        session_id: sessionId,
        symptoms: JSON.stringify(args.symptoms || []),
        severity: args.severity || 'medium',
        resolved: false,
        clinician_notified: false
      });
      db.insertAuditLog({
        action: 'red_flag_detected',
        details: JSON.stringify(args),
        session_id: sessionId
      });

      // For POC - log escalation requirement
      console.log(`🚨 CLINICIAN ESCALATION REQUIRED: Session ${sessionId} has red flag: ${args.severity}`);
    } catch (error) {
      console.error('Failed to save red flag event:', error);
    }
  }

  // Backup red flag detection from patient transcripts (in case AI doesn't trigger function call)
  private detectRedFlagsFromTranscript(sessionId: string, transcript: string, frontendWs: any) {
    try {
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

      // If red flags detected, save them and notify frontend
      if (detectedFlags.length > 0) {
        console.log(`🚨 BACKUP RED FLAG DETECTION: Found ${detectedFlags.length} red flags in session ${sessionId}:`, detectedFlags);

        // Save to database
        db.saveRedFlagEvent({
          session_id: sessionId,
          symptoms: JSON.stringify(detectedFlags),
          severity: maxSeverity,
          resolved: false,
          clinician_notified: false
        });
        db.insertAuditLog({
          action: 'red_flag_detected_backup',
          details: JSON.stringify({ symptoms: detectedFlags, severity: maxSeverity, transcript }),
          session_id: sessionId
        });

        // Notify frontend
        if (frontendWs) {
          frontendWs.send(JSON.stringify({
            type: 'red_flag_detected',
            symptoms: detectedFlags,
            severity: maxSeverity,
            timestamp: new Date().toISOString(),
            source: 'backup_detection'
          }));
        }

        console.log(`🚨 BACKUP: CLINICIAN ESCALATION REQUIRED: Session ${sessionId} has red flags: ${detectedFlags.join(', ')} (severity: ${maxSeverity})`);
      }
    } catch (error) {
      console.error('Error in backup red flag detection:', error);
    }
  }

  private handleSaveResponse(args: any) {
    console.log(`💾 Saving response for session ${args.sessionId || 'unknown'}:`, args);

    try {
      let category = 'general';
      if (args.question?.toLowerCase().includes('symptom')) category = 'symptoms';
      else if (args.question?.toLowerCase().includes('medication')) category = 'medications';
      else if (args.question?.toLowerCase().includes('condition') || args.question?.toLowerCase().includes('history')) category = 'history';

      const sessionId = args.sessionId;
      db.createIntakeResponse({
        session_id: sessionId,
        question: args.question || '',
        answer: args.answer || '',
        category: category
      });

      // Log both question and answer as conversation
      if (args.question) {
        db.saveConversationLog({
          session_id: sessionId,
          speaker: 'agent',
          message: args.question
        });
      }
      if (args.answer) {
        db.saveConversationLog({
          session_id: sessionId,
          speaker: 'patient',
          message: args.answer
        });
      }
    } catch (error) {
      console.error('Failed to save intake response:', error);
    }
  }

  private handleLogConversation(args: any) {
    console.log(`📝 Logging conversation:`, args);

    try {
      const sessionId = args.sessionId;
      db.saveConversationLog({
        session_id: sessionId,
        speaker: args.speaker || 'unknown',
        message: args.message || args.details || ''
      });
    } catch (error) {
      console.error('Failed to log conversation:', error);
    }
  }

  async endSession(sessionId: string) {
    return this.provider.endSession(sessionId);
  }

  async _endSessionOld(sessionId: string) {
    // Update database status to 'completed' when session ends
    try {
      db.updateSessionStatus(sessionId, 'completed');
      console.log(`✅ Database updated: Session ${sessionId} marked as completed`);
    } catch (error: any) {
      console.error(`❌ Failed to update database status for session ${sessionId}:`, error.message);
    }

    const connection = this.connections.get(sessionId);
    if (connection) {
      try {
        // WebSocket has close() method, not disconnect()
        if (connection.readyState === WebSocket.OPEN) {
          connection.close(1000, 'Session ended by user');
        }
        this.connections.delete(sessionId);
        console.log(`Session ${sessionId} ended successfully`);
      } catch (error: any) {
        console.error(`Error ending session ${sessionId}:`, error.message);
      }
    }

    // Clean up conversation buffers
    this.connections.delete(sessionId);
    this.frontendSockets.delete(sessionId);
    this.agentTextBuffers.delete(sessionId);
    this.agentFrontendBuffers.delete(sessionId);
    this.lastAgentResponse.delete(sessionId);
    this.patientTurnTimestamp.delete(sessionId);
    this.responseInProgress.delete(sessionId);
    this.lastPatientTranscript.delete(sessionId);
  }

  getSession(sessionId: string) {
    return this.provider.getSession ? this.provider.getSession(sessionId) : null;
  }

  // Deduplication helper method
  private isDuplicateAgentResponse(sessionId: string, message: string): boolean {
    const lastResponse = this.lastAgentResponse.get(sessionId);
    if (lastResponse === message.trim()) {
      console.log(`⚠️ Skipping duplicate agent response: "${message.trim().substring(0, 50)}..."`);
      return true;
    }
    this.lastAgentResponse.set(sessionId, message.trim());
    return false;
  }
}

export default new RealtimeSessionManager();
