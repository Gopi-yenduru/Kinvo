import WebSocket from 'ws';
import { BaseProvider, RealtimeConfig } from './BaseProvider.js';
import db from '../database-manager.js';
import { RED_FLAG_PATTERNS, RED_FLAG_SEVERITY_MAP, RED_FLAG_SEVERITY } from '../constants.js';

class OpenAIProvider implements BaseProvider {
  private connections: Map<string, WebSocket> = new Map();
  private frontendSockets: Map<string, WebSocket> = new Map();
  private agentTextBuffers: Map<string, string> = new Map();
  private agentFrontendBuffers: Map<string, string> = new Map();
  private lastAgentResponse: Map<string, string> = new Map();
  private recentPatientActivity: Map<string, number> = new Map();
  private pendingAgentSaves: Map<string, Array<{ transcript: string; ts: string; timer: any }>> = new Map();
  private patientTurnTimestamp: Map<string, number> = new Map();
  private responseInProgress: Map<string, boolean> = new Map();
  private lastPatientTranscript: Map<string, string> = new Map();
  private patientSpeechStopTimestamp: Map<string, number> = new Map(); // Records when patient actually stopped speaking for proper sequencing
  private lastInterruptionTime: Map<string, number> = new Map(); // Tracks interruption timestamps to cancel old responses
  private AGENT_DEFER_MS = 800;
  private RECENT_PATIENT_WINDOW_MS = 1000;

  private validateInstructions(instructions: string): string {
    if (!instructions || instructions.trim().length === 0) {
      console.warn('Empty instructions, using defaults');
      return 'Default medical intake instructions'; // Would import from constants
    }

    if (instructions.length > 8000) {
      console.warn(`Instructions too long (${instructions.length} chars), truncating to 8000 characters`);
      return instructions.substring(0, 8000);
    }

    try {
      JSON.stringify({ test: instructions });
      return instructions;
    } catch (e) {
      console.error('Instructions contain invalid JSON characters, cleaning up...');
      const cleaned = instructions.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
      try {
        JSON.stringify({ test: cleaned });
        console.log('Successfully cleaned up instructions');
        return cleaned;
      } catch (e2) {
        console.error('Still invalid after cleanup, using fallback');
        return 'Default medical intake instructions';
      }
    }
  }

  getFunctionTools(): any[] {
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

  private handleRealtimeResponse(sessionId: string, data: Buffer): void {
    try {
      const event = JSON.parse(data.toString());
      //console.log(`Realtime event for ${sessionId}:`, event.type);

      const frontendWs = this.frontendSockets.get(sessionId);
      if (!frontendWs) {
        console.warn(`No frontend WebSocket found for session ${sessionId}`);
        return;
      }

      const nowMs = Date.now();

      function queueAgentSave(self: OpenAIProvider, sid: string, transcript: string) {
        // FIXED: Get speech timestamp ONCE when queued, not when timer fires
        // Prevents timestamp drift that causes chronological ordering bugs
        const speechStopTime = self.patientSpeechStopTimestamp.get(sid) || 0;
        const ts = new Date(speechStopTime + 100).toISOString(); // Agent response comes after patient stops

        console.log(`⏰ Queuing agent save for ${sid} with speech stop time: ${speechStopTime}, timestamp: ${ts}`);

        const arr = self.pendingAgentSaves.get(sid) || [];
        const timer = setTimeout(() => {
          const pending = self.pendingAgentSaves.get(sid) || [];
          const idx = pending.findIndex((p: { transcript: string; ts: string; timer?: any }) =>
            p.transcript === transcript && p.ts === ts
          );

          if (idx !== -1) {
            const item = pending.splice(idx, 1)[0];
            if (pending.length > 0) self.pendingAgentSaves.set(sid, pending);
            else self.pendingAgentSaves.delete(sid);
            try {
              console.log(`🕒 Agent defer timeout reached — saving agent for ${sid} with timestamp: ${item.ts}`);
              self.saveAgentTranscriptImmediate(sid, item.transcript, item.ts);
            } catch (err) {
              console.error('Error flushing deferred agent save:', err);
            }
          }
        }, self.AGENT_DEFER_MS);

        arr.push({ transcript, ts, timer });
        self.pendingAgentSaves.set(sid, arr);
      }

      const flushPendingAgents = (sid: string) => {
        const pending = this.pendingAgentSaves.get(sid);
        if (!pending || pending.length === 0) return;
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

      switch (event.type) {
        case 'session.updated':
          console.log(`✅ Session updated successfully for ${sessionId} - AI is ready to respond`);
          frontendWs.send(JSON.stringify({ type: 'session_ready', sessionId }));
          break;

        case 'session.update':
          console.log(`📝 Session update event received for ${sessionId} - AI is ready to respond`);
          frontendWs.send(JSON.stringify({ type: 'session_ready', sessionId }));
          break;

        case 'error':
          console.error(`❌ OpenAI error event for ${sessionId}:`, event.error);
          if (event.error?.message) {
            console.error(`Error message: ${event.error.message}`);
          }
          frontendWs.send(JSON.stringify({
            type: 'error',
            message: event.error?.message || 'OpenAI API error',
            timestamp: new Date().toISOString()
          }));
          break;

        case 'input_audio_buffer.speech_started':
          console.log(`🎤 Patient started speaking (${sessionId})`);
          this.recentPatientActivity.set(sessionId, nowMs);
          if (!this.patientTurnTimestamp.has(sessionId)) {
            this.patientTurnTimestamp.set(sessionId, nowMs);
          }

          // 🔄 DETECT INTERRUPTION: If agent was speaking and patient starts again quickly
          const lastAgentActivity = this.lastAgentResponse.get(sessionId);
          if (lastAgentActivity) {
            const timeSinceLastAgent = nowMs - (this.patientSpeechStopTimestamp.get(sessionId) || 0);
            if (timeSinceLastAgent < 2000) { // Within 2 seconds of agent finishing = potential interruption
              console.log(`⚡ INTERRUPTION DETECTED: Patient interrupting agent speech (${timeSinceLastAgent}ms ago)`);
              this.cancelQueuedResponses(sessionId);
              this.lastInterruptionTime.set(sessionId, nowMs);
            }
          }
          break;

        case 'input_audio_buffer.speech_stopped':
          this.recentPatientActivity.set(sessionId, nowMs);
          // 🕒 RECORD the exact time patient stopped speaking for transcript sequencing
          this.patientSpeechStopTimestamp.set(sessionId, nowMs);
          console.log(`🛑 Patient stopped speaking (${sessionId}) - Recording stop time for proper sequencing. Timestamp: ${this.patientSpeechStopTimestamp.get(sessionId)}`);
          break;

        case 'conversation.item.input_audio_transcription.delta':
        case 'input_audio_transcription.delta':
          this.recentPatientActivity.set(sessionId, nowMs);
          // Send real-time transcription to frontend with our calculated patient timestamp
          if ((event.delta || event.text) && frontendWs) {
            const deltaText = event.delta || event.text;
            const speechStopTime = this.patientSpeechStopTimestamp.get(sessionId) || nowMs;
            const patientTs = new Date(speechStopTime).toISOString();
            // frontendWs.send(JSON.stringify({
            //   type: 'conversation.item.input_audio_transcription.delta',
            //   delta: deltaText,
            //   timestamp: patientTs // Include calculated timestamp for sequencing
            // }));
          }
          break;

        case 'conversation.item.input_audio_transcription.completed':
        case 'input_audio_transcription.completed':
          // Process transcription for logging only - OpenAI handles response triggering via create_response: true
          if (event.transcript || event.text) {
            const transcript = event.transcript || event.text;

            if (!transcript.trim() || transcript.trim().length < 3) {
              console.log(`⚠️ Skipping empty/short transcript for ${sessionId}`);
            } else {
              const lastTranscript = this.lastPatientTranscript.get(sessionId);
              if (lastTranscript === transcript.trim()) {
                console.log(`🔄 Duplicate transcript detected for ${sessionId}, skipping transcription processing`);
              } else {
                // Save transcript - use speech STOP time for correct sequencing (not speech start time)
                this.lastPatientTranscript.set(sessionId, transcript.trim());

                const speechStopTime = this.patientSpeechStopTimestamp.get(sessionId) || nowMs;
                const ts = new Date(speechStopTime).toISOString(); // Patient timestamp = when they stopped speaking
                console.log(`👤 Patient said (final): "${transcript}" - timestamp: ${ts} (speechStop: ${speechStopTime})`);

                try {
                  db.saveConversationLog({
                    session_id: sessionId,
                    speaker: 'patient',
                    message: transcript,
                    audio_data: JSON.stringify({ type: 'speech_transcript' }),
                    timestamp: new Date(speechStopTime) // Patient timestamp = when they stopped speaking
                  });
                  db.insertAuditLog({
                    action: 'patient_speech',
                    details: JSON.stringify({ transcript }),
                    session_id: sessionId
                  });
                } catch (dbErr) {
                  console.error(`Failed to save patient transcript for ${sessionId}:`, dbErr);
                }

                this.recentPatientActivity.set(sessionId, nowMs);
                flushPendingAgents(sessionId);
              }
            }

            // Clean up timing data
            this.patientTurnTimestamp.delete(sessionId);
          }
          break;

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

/*           try {
            const fullAgentResponse = this.agentTextBuffers.get(sessionId) || '';
            if (fullAgentResponse.trim() && !this.isDuplicateAgentResponse(sessionId, fullAgentResponse)) {
              console.log(`📝 Backup agent response (audio.done): "${fullAgentResponse}"`);
              db.saveConversationLog({
                session_id: sessionId,
                speaker: 'agent',
                message: fullAgentResponse,
                audio_data: JSON.stringify({ source: 'response.audio.done (backup)' })
              });
              frontendWs.send(JSON.stringify({
                type: 'agent_transcript_complete',
                transcript: fullAgentResponse,
                timestamp: new Date().toISOString()
              }));
            }
          } catch (err) {
            console.error('Error in audio.done backup logic:', err);
          } */

          this.responseInProgress.set(sessionId, false);
          break;

        case 'response.audio_transcript.delta':
          break;

        case 'response.audio_transcript.done':
          if (event.transcript && !this.isDuplicateAgentResponse(sessionId, event.transcript)) {
            const agentTranscript = event.transcript;
            // Use speech stop time + 100ms buffer for proper sequencing
            const speechStopTime = this.patientSpeechStopTimestamp.get(sessionId) || 0;
            const agentTs = new Date(speechStopTime + 100).toISOString(); // Agent response comes after patient stops
            console.log(`🤖 Agent responding for ${sessionId}: "${agentTranscript}" - timestamp: ${agentTs} (speechStop: ${speechStopTime})`);

            const lastPatientActivity = this.recentPatientActivity.get(sessionId) || 0;
            const ageSincePatientMs = nowMs - lastPatientActivity;

            if (lastPatientActivity && ageSincePatientMs < this.RECENT_PATIENT_WINDOW_MS) {
              console.log(`⚖️ Deferring agent save for ${sessionId} (recent patient activity ${ageSincePatientMs}ms ago)`);
              queueAgentSave(this, sessionId, agentTranscript);
              frontendWs.send(JSON.stringify({
                type: 'agent_transcript_complete',
                transcript: agentTranscript,
                timestamp: agentTs // Explicitly send our calculated timestamp
              }));
              if (agentTranscript.includes("Your provider will review")) {
                console.log(`🏁 Ending session ${sessionId} due to provider review response`);
                frontendWs.send(JSON.stringify({
                  type: 'request_session_end',
                  timestamp: agentTs
                }));
                setTimeout(() => {
                  this.endSession(sessionId);
                }, 3000);
              }
            } else {
              this.saveAgentTranscriptImmediate(sessionId, agentTranscript, agentTs);
              frontendWs.send(JSON.stringify({
                type: 'agent_transcript_complete',
                transcript: agentTranscript,
                timestamp: agentTs // Explicitly send our calculated timestamp
              }));
              if (agentTranscript.includes("Your provider will review") || agentTranscript.includes("critical alert")) {
                console.log(`🏁 Ending session ${sessionId} due to provider review response`);
                frontendWs.send(JSON.stringify({
                  type: 'request_session_end',
                  timestamp: agentTs
                }));
                setTimeout(() => {
                  this.endSession(sessionId);
                }, 10000);
              }
            }
          }
          break;

        case 'response.function_call_arguments.done':
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
                modalities: ["audio","text"]
              }
            }));
          }
          break;

        case 'function_call':
          console.log(`🔧 Alternative function call for ${sessionId}:`, event);
          if (event.arguments && event.name) {
            this.handleRealtimeFunctionCall(sessionId, event.name, event.arguments);
          }
          break;

        case 'conversation.item.function_call':
          console.log(`🔧 Conversation function call for ${sessionId}:`, event);
          if (event.item && event.item.function_call) {
            const functionCall = event.item.function_call;
            if (functionCall.arguments && functionCall.name) {
              this.handleRealtimeFunctionCall(sessionId, functionCall.name, functionCall.arguments);
            }
          }
          break;

        case 'tool_call':
          console.log(`🔧 Tool call for ${sessionId}:`, event);
          if (event.tool_call && event.tool_call.function) {
            const toolFunction = event.tool_call.function;
            if (toolFunction.arguments && toolFunction.name) {
              this.handleRealtimeFunctionCall(sessionId,  toolFunction.name, toolFunction.arguments);
            }
          }
          break;

        case 'function_call_response':
          console.log(`🔧 Function call response for ${sessionId}:`, event);
          if (event.name && event.arguments) {
            this.handleRealtimeFunctionCall(sessionId, event.name, event.arguments);
          }
          break;

        default:
          //console.log(`Unhandled realtime event ${event.type} for ${sessionId}`, event);
          break;
      }
    } catch (err) {
      console.error('Error in handleRealtimeResponse:', err);
    }
  }

  private handleRealtimeFunctionCall(sessionId: string, name: string, argumentsJson: string): void {
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

  private handleRedFlagDetection(args: any, sessionId: string): void {
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

      console.log(`🚨 CLINICIAN ESCALATION REQUIRED: Session ${sessionId} has red flag: ${args.severity}`);
    } catch (error) {
      console.error('Failed to save red flag event:', error);
    }
  }

  private handleSaveResponse(args: any): void {
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

      if (args.question) {
        db.saveConversationLog({
          session_id: sessionId,
          speaker: 'agent',
          message: args.question,
          timestamp: new Date()
        });
      }
      if (args.answer) {
        db.saveConversationLog({
          session_id: sessionId,
          speaker: 'patient',
          message: args.answer,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Failed to save intake response:', error);
    }
  }

  private handleLogConversation(args: any): void {
    console.log(`📝 Logging conversation:`, args);

    try {
      const sessionId = args.sessionId;
      db.saveConversationLog({
        session_id: sessionId,
        speaker: args.speaker || 'unknown',
        message: args.message || args.details || '',
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Failed to log conversation:', error);
    }
  }

  private cancelQueuedResponses(sessionId: string): void {
    // Cancel all pending agent saves for this session
    const pending = this.pendingAgentSaves.get(sessionId);
    if (pending && pending.length > 0) {
      console.log(`🛑 Canceling ${pending.length} queued agent responses for session ${sessionId} due to interruption`);
      for (const item of pending) {
        clearTimeout(item.timer);
      }
      this.pendingAgentSaves.delete(sessionId);
    }
  }

  private saveAgentTranscriptImmediate(sessionId: string, transcript: string, ts: string): void {
    try {
      console.log(`🤖 Saving agent transcript for ${sessionId}: "${transcript}"`);
      db.saveConversationLog({
        session_id: sessionId,
        speaker: 'agent',
        message: transcript,
        audio_data: JSON.stringify({ source: 'response.audio_transcript.done' }),
        timestamp: new Date(ts) // Use the provided timestamp for chronological ordering
      });
      this.lastAgentResponse.set(sessionId, transcript);
    } catch (err) {
      console.error(`Failed to save agent transcript for ${sessionId}:`, err);
    }
  }

  private isDuplicateAgentResponse(sessionId: string, message: string): boolean {
    const lastResponse = this.lastAgentResponse.get(sessionId);
    if (lastResponse === message.trim()) {
      console.log(`⚠️ Skipping duplicate agent response: "${message.trim().substring(0, 50)}..."`);
      return true;
    }
    this.lastAgentResponse.set(sessionId, message.trim());
    return false;
  }

  async createRealtimeSession(config: RealtimeConfig): Promise<WebSocket | null> {
    return new Promise((resolve, reject) => {
      try {
        console.log(`🤖 OpenAI API key: ${process.env.OPENAI_API_KEY}`);
        if (!config.apiKey && (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here')) {
          console.error('OpenAI API key not configured properly');
          reject(new Error('OpenAI API key is required but not configured'));
          return;
        }

        console.log(`Creating Realtime session for ${config.sessionId}...`);

        const modelName = config.model || 'gpt-realtime';
        const apiKey = config.apiKey || process.env.OPENAI_API_KEY;

        if (!apiKey || apiKey === 'your_openai_api_key_here') {
          console.error('OpenAI API key is required but not configured');
          reject(new Error('OpenAI API key is required but not configured'));
          return;
        }

        console.log(`🔗 Connecting to OpenAI Realtime API with model: ${modelName}`);

        const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${modelName}`, [], {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        const connectionTimeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 10000);

        ws.on('open', () => {
          clearTimeout(connectionTimeout);
          console.log(`✅ OpenAI Realtime WebSocket connected for session ${config.sessionId}`);

          const validatedInstructions = this.validateInstructions(config.instructions);
          console.log(`📝 Using validated instructions (${validatedInstructions.length} chars)`);
          console.log('temparature:', config.temperature);
          console.log('voice:', config.voice);

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
                create_response: true
              },
              tools: this.getFunctionTools(),
              temperature: config.temperature,
              max_response_output_tokens: 1000
            }
          };

          try {
            const configString = JSON.stringify(sessionConfig);
            console.log(`📤 Sending session config (${configString.length} bytes)`);
            ws.send(configString);
            this.connections.set(config.sessionId, ws);
            resolve(ws);
          } catch (sendError) {
            console.error('Error sending session config:', sendError);
            reject(sendError);
          }
        });

        ws.on('message', (data: Buffer) => {
          try {
            const event = JSON.parse(data.toString());

            if (event.type === 'error' && event.error?.message) {
              console.error(`❌ Session update error for ${config.sessionId}:`, event.error);
              if (event.error.message.includes('instructions') || event.error.message.includes('session')) {
                console.error('❌ Instructions-related error detected');
                console.error('❌ Original instructions:', config.instructions);
              }
            }

            this.handleRealtimeResponse(config.sessionId, data);
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

  sendAudioData(sessionId: string, audioDataObject: any): void {
    const realtimeWs = this.connections.get(sessionId);
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      try {
        if (!audioDataObject.pcm16 || !Array.isArray(audioDataObject.pcm16)) {
          console.error('❌ Invalid audio data format. Expected {pcm16: [...], timestamp: number}');
          return;
        }

        const pcmSamples = audioDataObject.pcm16;
        //console.log(`🎵 Received ${pcmSamples.length} 16-bit PCM16 samples from frontend`);

        const bytesNeeded = pcmSamples.length * 2;
        const pcmBytes = new Uint8Array(bytesNeeded);

        for (let i = 0; i < pcmSamples.length; i++) {
          const sample = Math.max(-32768, Math.min(32767, pcmSamples[i]));
          const byteIndex = i * 2;

          pcmBytes[byteIndex] = sample & 0xff;
          pcmBytes[byteIndex + 1] = (sample >> 8) & 0xff;
        }

        if (pcmBytes.length % 2 !== 0) {
          console.error(`❌ Incomplete PCM16 samples: ${pcmBytes.length} bytes (should be even)`);
          return;
        }

        const pcmBuffer = Buffer.from(pcmBytes);
        const base64Audio = pcmBuffer.toString('base64');

        const audioMessage = {
          type: 'input_audio_buffer.append',
          audio: base64Audio
        };

        realtimeWs.send(JSON.stringify(audioMessage));

        const sampleCount = pcmSamples.length;
        const estimatedDuration = (sampleCount / 24000).toFixed(2);
        //console.log(`✅ Sent ${sampleCount} PCM16 samples (${bytesNeeded} bytes) to OpenAI (${estimatedDuration}s at 24kHz)`);

      } catch (error: any) {
        console.error(`❌ Error sending audio data for session ${sessionId}:`, error.message);
      }
    } else {
      console.warn(`❌ Cannot send audio - no active Realtime connection for session ${sessionId}`);
    }
  }

  linkFrontendSocket(sessionId: string, frontendWs: any): void {
    this.frontendSockets.set(sessionId, frontendWs);

    console.log(`📝 Saving system message: Session joined - ${sessionId}`);
    db.saveConversationLog({
      session_id: sessionId,
      speaker: 'system',
      message: 'Voice agent session initialized and ready to begin intake',
      audio_data: JSON.stringify({ type: 'session_join' }),
      timestamp: new Date()
    });
    db.insertAuditLog({
      action: 'session_joined',
      details: JSON.stringify({ socketLinked: true }),
      session_id: sessionId
    });

    console.log(`✅ Frontend WebSocket linked for session ${sessionId}`);

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
      }, 500);
    }
  }

  unlinkFrontendSocket(sessionId: string): void {
    this.frontendSockets.delete(sessionId);
    console.log(`Frontend WebSocket unlinked for session ${sessionId}`);
  }

  async endSession(sessionId: string): Promise<void> {
    const connection = this.connections.get(sessionId);
    if (connection) {
      try {
        if (connection.readyState === WebSocket.OPEN) {
          connection.close(1000, 'Session ended by user');
        }
        this.connections.delete(sessionId);
        console.log(`Session ${sessionId} ended successfully`);
      } catch (error: any) {
        console.error(`Error ending session ${sessionId}:`, error.message);
      }
    }

    try {
      db.updateSessionStatus(sessionId, 'completed');
      console.log(`✅ Database updated: Session ${sessionId} marked as completed`);
    } catch (error: any) {
      console.error(`❌ Failed to update database status for session ${sessionId}:`, error.message);
    }

    // Clean up
    this.connections.delete(sessionId);
    this.frontendSockets.delete(sessionId);
    this.agentTextBuffers.delete(sessionId);
    this.agentFrontendBuffers.delete(sessionId);
    this.lastAgentResponse.delete(sessionId);
    this.patientTurnTimestamp.delete(sessionId);
    this.responseInProgress.delete(sessionId);
    this.lastPatientTranscript.delete(sessionId);
    this.patientSpeechStopTimestamp.delete(sessionId);
    this.lastInterruptionTime.delete(sessionId);
  }

  handleMessage(sessionId: string, data: Buffer): void {
    this.handleRealtimeResponse(sessionId, data);
  }

  getSession(sessionId: string): WebSocket | null {
    return this.connections.get(sessionId) || null;
  }
}

export default OpenAIProvider;
