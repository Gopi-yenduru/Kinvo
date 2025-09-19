import WebSocket from 'ws';
import db from './database.js';
import { RED_FLAG_PATTERNS, RED_FLAG_SEVERITY_MAP, RED_FLAG_SEVERITY } from './constants.js';

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
  public connections: Map<string, any> = new Map();
  private frontendSockets: Map<string, any> = new Map(); // Track frontend WebSocket for each session
  private agentTextBuffers: Map<string, string> = new Map(); // Accumulate full agent responses
  private agentFrontendBuffers: Map<string, string> = new Map(); // Backup - accumulate agent text sent to frontend
  private lastAgentResponse: Map<string, string> = new Map(); // Track recent agent responses to prevent duplicates



  // Add inside class
private recentPatientActivity: Map<string, number> = new Map(); // ms epoch for last patient delta/speech stop
private pendingAgentSaves: Map<string, Array<{ transcript: string; ts: string; timer: any }>> = new Map();
private AGENT_DEFER_MS = 800; // how long to wait for patient transcript before saving agent (tune as needed)
private RECENT_PATIENT_WINDOW_MS = 1000; // how recent is considered 'patient activity'

private saveAgentTranscriptImmediate(sessionId: string, transcript: string, ts: string) {
  try {
    console.log(`🤖 Saving agent transcript for ${sessionId}: "${transcript}"`);
    db.saveConversationLog(sessionId, 'agent', transcript, { source: 'response.audio_transcript.done' }, ts);
    // update lastAgent saved to avoid duplicates
    this.lastAgentResponse.set(sessionId, transcript);
  } catch (err) {
    console.error(`Failed to save agent transcript for ${sessionId}:`, err);
  }
}


  async createRealtimeSession(config: RealtimeConfig): Promise<WebSocket | null> {
    return new Promise((resolve, reject) => {
      try {
        // Check if API key is available
        if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
          console.error('OpenAI API key not configured properly');
          reject(new Error('OpenAI API key is required but not configured'));
          return;
        }

        console.log(`Creating Realtime session for ${config.sessionId}...`);

        // Dynamic model selection and API key
        const modelName = config.model || 'gpt-4o-mini-realtime-preview';
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

          // Send session configuration
          const sessionConfig = {
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: config.instructions,
              voice: config.voice || 'alloy',
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              input_audio_transcription: { model: 'whisper-1' },
              turn_detection: {
                type: "server_vad",
                prefix_padding_ms: 300,
                silence_duration_ms: 200,
                create_response: false
              },
              tools: this.getFunctionTools(),
              temperature: config.temperature || 0.1,
              max_response_output_tokens: config.maxResponseLength
            }
          };

          try {
            ws.send(JSON.stringify(sessionConfig));
            this.connections.set(config.sessionId, ws);
            resolve(ws);
          } catch (sendError) {
            console.error('Error sending session config:', sendError);
            reject(sendError);
          }
        });

        ws.on('message', (data: Buffer) => {
          try {
            this.handleRealtimeResponse(config.sessionId, data);
          } catch (messageError) {
            console.error('Error handling message:', messageError);
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

  // Handle responses from OpenAI Realtime API
    private handleRealtimeResponse(sessionId: string, data: Buffer) {
      try {
        const event = JSON.parse(data.toString());
        console.log(`Realtime event for ${sessionId}:`, event.type);
    
        const frontendWs = this.frontendSockets.get(sessionId);
        if (!frontendWs) {
          console.warn(`No frontend WebSocket found for session ${sessionId}`);
          return;
        }
    
        const nowMs = Date.now();
    
        function queueAgentSave(self: any, sid: string, transcript: string) {
          const ts = new Date().toISOString();
          const arr = self.pendingAgentSaves.get(sid) || [];
          // create timer to flush after AGENT_DEFER_MS
          const timer = setTimeout(() => {
            // flush this queued item (if still present)
            const pending = self.pendingAgentSaves.get(sid) || [];
            // find and remove this specific item by timestamp+transcript
            const idx = pending.findIndex((p: { transcript: string; ts: string; timer?: any }) =>
              p.transcript === transcript && p.ts === ts
            );
            
            if (idx !== -1) {
              const item = pending.splice(idx, 1)[0];
              if (pending.length > 0) self.pendingAgentSaves.set(sid, pending);
              else self.pendingAgentSaves.delete(sid);
              try {
                console.log(`🕒 Agent defer timeout reached — saving agent for ${sid}`);
                self.saveAgentTranscriptImmediate(sid, item.transcript, item.ts);
              } catch (err) {
                console.error('Error flushing deferred agent save:', err);
              }
            }
          }, self.AGENT_DEFER_MS);
    
          arr.push({ transcript, ts, timer });
          self.pendingAgentSaves.set(sid, arr);
        }
    
        // helper to flush all pending agent saves immediately
        const flushPendingAgents = (sid: string) => {
          const pending = this.pendingAgentSaves.get(sid);
          if (!pending || pending.length === 0) return;
          // clear timers, save each immediately
          for (const item of pending) {
            try {
              clearTimeout(item.timer);
              this.saveAgentTranscriptImmediate(sid, item.transcript, item.ts);
            } catch (err) {
              console.error('Error saving deferred agent transcript during flush:', err);
            }
          }
          this.pendingAgentSaves.delete(sid);
        };
    
        // Event switch ----------------------------------------------------------------
        switch (event.type) {
          case 'session.updated':
            frontendWs.send(JSON.stringify({ type: 'session_ready', sessionId }));

            break;
    
          case 'input_audio_buffer.speech_started':
            console.log(`🎤 Patient started speaking (${sessionId})`);
            // mark recent activity
            this.recentPatientActivity.set(sessionId, nowMs);
            break;
    
          case 'input_audio_buffer.speech_stopped':
            console.log(`🛑 Patient stopped speaking (${sessionId})`);
            // mark recent activity — a transcription likely follows
            this.recentPatientActivity.set(sessionId, nowMs);
            break;
    
          case 'conversation.item.input_audio_transcription.delta':
          case 'input_audio_transcription.delta':
            // patient speech partial text — mark recent activity (transcription in progress)
            this.recentPatientActivity.set(sessionId, nowMs);
            // do not forward partials (keeping behavior consistent)
            break;
    
          case 'conversation.item.input_audio_transcription.completed':
          case 'input_audio_transcription.completed':
            // Final patient transcript — save immediately and flush any queued agent
            if (event.transcript || event.text) {
              const transcript = event.transcript || event.text;
              const ts = new Date().toISOString();
              console.log(`👤 Patient said (final): "${transcript}"`);

              // 🔍 BACKUP RED FLAG DETECTION - Check for red flags in patient transcript
              //this.detectRedFlagsFromTranscript(sessionId, transcript, frontendWs);

              // send to frontend
              /* frontendWs.send(JSON.stringify({
                type: 'patient_transcript',
                transcript: transcript,
                timestamp: ts
              })); */

              // 🔑 Now request the model's response manually
              const realtimeWs = this.connections.get(sessionId);
              if (realtimeWs) {
                console.log('▶️ Triggering model response after patient transcript');
                realtimeWs.send(JSON.stringify({
                  type: "response.create",
                  response: {
                    modalities: ["audio","text"] // return speech + text
                  }
                }));
              }

              // Save to DB
              try {
                db.saveConversationLog(sessionId, 'patient', transcript, { type: 'speech_transcript' }, ts);
                db.logAuditEvent && db.logAuditEvent('patient_speech', { transcript }, sessionId);
              } catch (dbErr) {
                console.error(`Failed to save patient transcript for ${sessionId}:`, dbErr);
              }

              // mark activity (so agent deferral can be cleared)
              this.recentPatientActivity.set(sessionId, nowMs);

              // flush any pending agent saves immediately (patient is now saved)
              flushPendingAgents(sessionId);
          }
          break;
    
          // Agent streaming (frontend playback and deltas) --------------------------------
          case 'response.text.delta':
            if (event.delta) {
              frontendWs.send(JSON.stringify({
                type: 'agent_text_stream',
                text: event.delta,
                timestamp: new Date().toISOString()
              }));
            }
            break;
    
          case 'response.audio.delta':
            if (event.delta) {
              frontendWs.send(JSON.stringify({
                type: 'agent_audio_chunk',
                audio: event.delta,
                timestamp: new Date().toISOString()
              }));
            }
            break;
    
          case 'response.audio.done':
            console.log(`🔊 Agent audio completed for ${sessionId}`);
            frontendWs.send(JSON.stringify({
              type: 'agent_response_complete',
              timestamp: new Date().toISOString()
            }));



            // backup fallback using buffered text if transcript didn't arrive; we will still check pending queue later
            try {
              const fullAgentResponse = this.agentTextBuffers.get(sessionId) || '';
              if (fullAgentResponse.trim() && !this.isDuplicateAgentResponse(sessionId, fullAgentResponse)) {
                console.log(`📝 Backup agent response (audio.done): "${fullAgentResponse}"`);
                db.saveConversationLog(sessionId, 'agent', fullAgentResponse, { source: 'response.audio.done (backup)' }, new Date().toISOString());
                frontendWs.send(JSON.stringify({
                  type: 'agent_transcript_complete',
                  transcript: fullAgentResponse,
                  timestamp: new Date().toISOString()
                }));
              }
            } catch (err) {
              console.error('Error in audio.done backup logic:', err);
            }
            break;
    
          case 'response.audio_transcript.delta':
            if (event.delta) {
              // frontendWs.send(JSON.stringify({
              //   type: 'agent_transcript_delta',
              //   text: event.delta,
              //   timestamp: new Date().toISOString()
              // }));
            }
            break;
    
          case 'response.audio_transcript.done':
            if (event.transcript && !this.isDuplicateAgentResponse(sessionId, event.transcript)) {
              const agentTranscript = event.transcript;
              const agentTs = new Date().toISOString();

              // determine if recent patient activity suggests patient transcript might be coming shortly
              const lastPatientActivity = this.recentPatientActivity.get(sessionId) || 0;
              const ageSincePatientMs = nowMs - lastPatientActivity;

              if (lastPatientActivity && ageSincePatientMs < this.RECENT_PATIENT_WINDOW_MS) {
                // Defer saving the agent for a short time to wait for patient transcription.
                console.log(`⚖️ Deferring agent save for ${sessionId} (recent patient activity ${ageSincePatientMs}ms ago)`);
                queueAgentSave(this, sessionId, agentTranscript);
                // Still forward final transcript to frontend so UI shows it live
                frontendWs.send(JSON.stringify({
                  type: 'agent_transcript_complete',
                  transcript: agentTranscript,
                  timestamp: agentTs
                }));
                // End session if agent response contains "Your provider will review"
                if (agentTranscript.includes("Your provider will review")) {
                  console.log(`🏁 Ending session ${sessionId} due to provider review response`);
                  frontendWs.send(JSON.stringify({
                    type: 'request_session_end',
                    timestamp: agentTs
                  }));
                  // Delay to allow audio playback to complete
                  setTimeout(() => {
                    this.endSession(sessionId);
                  }, 3000);
                }
              } else {
                // No recent patient activity — safe to save immediately
                this.saveAgentTranscriptImmediate(sessionId, agentTranscript, agentTs);
                frontendWs.send(JSON.stringify({
                  type: 'agent_transcript_complete',
                  transcript: agentTranscript,
                  timestamp: agentTs
                }));
                // End session if agent response contains "Your provider will review"
                if (agentTranscript.includes("Your provider will review") || agentTranscript.includes("critical alert")) {
                  console.log(`🏁 Ending session ${sessionId} due to provider review response`);
                  frontendWs.send(JSON.stringify({
                    type: 'request_session_end',
                    timestamp: agentTs
                  }));
                  // Delay to allow audio playback to complete
                  setTimeout(() => {
                    this.endSession(sessionId);
                  }, 10000);
                }
              }
            }
            break;

          case 'response.function_call_arguments.done':
            // Handle function calls from the AI
            console.log(`🔧 Function call received for ${sessionId}:`, event);
            if (event.arguments && event.name) {
              console.log('Calling handleRealtimeFunctionCall');
              this.handleRealtimeFunctionCall(sessionId, event.name, event.arguments);
            }

            const realtimeWs = this.connections.get(sessionId);
            if (realtimeWs) {
              console.log('▶️ Triggering model response after triggering red flag');
              realtimeWs.send(JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio","text"] // return speech + text
                }
              }));
            }
            break;

          case 'function_call':
            // Alternative function call event format
            console.log(`🔧 Alternative function call for ${sessionId}:`, event);
            if (event.arguments && event.name) {
              this.handleRealtimeFunctionCall(sessionId, event.name, event.arguments);
            }
            break;

          case 'conversation.item.function_call':
            // Function call within conversation items
            console.log(`🔧 Conversation function call for ${sessionId}:`, event);
            if (event.item && event.item.function_call) {
              const functionCall = event.item.function_call;
              if (functionCall.arguments && functionCall.name) {
                this.handleRealtimeFunctionCall(sessionId, functionCall.name, functionCall.arguments);
              }
            }
            break;

          case 'tool_call':
            // Tool call event (newer format)
            console.log(`🔧 Tool call for ${sessionId}:`, event);
            if (event.tool_call && event.tool_call.function) {
              const toolFunction = event.tool_call.function;
              if (toolFunction.arguments && toolFunction.name) {
                this.handleRealtimeFunctionCall(sessionId,  toolFunction.name, toolFunction.arguments);
              }
            }
            break;

          case 'function_call_response':
            // Fallback for different function call response formats
            console.log(`🔧 Function call response for ${sessionId}:`, event);
            if (event.name && event.arguments) {
              this.handleRealtimeFunctionCall(sessionId, event.name, event.arguments);
            }
            break;

          default:
            console.log(`Unhandled realtime event ${event.type} for ${sessionId}`, event);
            break;
        }
      } catch (err) {
        console.error('Error in handleRealtimeResponse:', err);
      }
    }    
    
    

    
    
  
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
    this.frontendSockets.set(sessionId, frontendWs);

    // Log system message for session join
    console.log(`📝 Saving system message: Session joined - ${sessionId}`);
    db.saveConversationLog(sessionId, 'system', 'Voice agent session initialized and ready to begin intake', { type: 'session_join' }, new Date().toISOString());
    db.logAuditEvent('session_joined', { socketLinked: true }, sessionId);

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
    this.frontendSockets.delete(sessionId);
    console.log(`Frontend WebSocket unlinked for session ${sessionId}`);
  }

  // Send audio data from frontend to OpenAI Realtime API
  sendAudioData(sessionId: string, audioDataObject: any) {
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
      db.saveRedFlagEvent(sessionId, args.symptoms || [], args.severity || 'medium');
      db.logAuditEvent('red_flag_detected', args, sessionId);

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
        db.saveRedFlagEvent(sessionId, detectedFlags, maxSeverity);
        db.logAuditEvent('red_flag_detected_backup', { symptoms: detectedFlags, severity: maxSeverity, transcript }, sessionId);

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
      db.saveIntakeResponse(sessionId, args.question || '', args.answer || '', category);

      // Log both question and answer as conversation
      if (args.question) {
        db.saveConversationLog(sessionId, 'agent', args.question, null, new Date().toISOString());
      }
      if (args.answer) {
        db.saveConversationLog(sessionId, 'patient', args.answer, null, new Date().toISOString());
      }
    } catch (error) {
      console.error('Failed to save intake response:', error);
    }
  }

  private handleLogConversation(args: any) {
    console.log(`📝 Logging conversation:`, args);

    try {
      const sessionId = args.sessionId;
      db.saveConversationLog(
        sessionId,
        args.speaker || 'unknown',
        args.message || args.details || '',
        null,
        new Date().toISOString()
      );
    } catch (error) {
      console.error('Failed to log conversation:', error);
    }
  }

  async endSession(sessionId: string) {
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
  }

  getSession(sessionId: string) {
    return this.connections.get(sessionId);
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