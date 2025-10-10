import WebSocket from 'ws';
import { BaseProvider, RealtimeConfig } from './BaseProvider.js';
import db from '../database-manager.js';
import { RED_FLAG_PATTERNS, RED_FLAG_SEVERITY_MAP, RED_FLAG_SEVERITY } from '../constants.js';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

class OpenAIProvider implements BaseProvider {
  private connections: Map<string, WebSocket> = new Map();
  private frontendSockets: Map<string, WebSocket> = new Map();
  private agentTextBuffers: Map<string, string> = new Map();
  private agentFrontendBuffers: Map<string, string> = new Map();
  private lastAgentResponse: Map<string, string> = new Map();
  private recentPatientActivity: Map<string, number> = new Map();
  private pendingAgentSaves: Map<string, Array<{ id: string; transcript: string; ts: string; timer: any }>> = new Map();
  private patientTurnTimestamp: Map<string, number> = new Map();
  private responseInProgress: Map<string, boolean> = new Map();
  private lastPatientTranscript: Map<string, string> = new Map();
  private patientSpeechStopTimestamp: Map<string, number> = new Map(); // Records when patient actually stopped speaking for proper sequencing
  private lastInterruptionTime: Map<string, number> = new Map(); // Tracks interruption timestamps to cancel old responses
  private AGENT_DEFER_MS = 1200;
  private RECENT_PATIENT_WINDOW_MS = 1000;

  // Token usage tracking properties
  private sessionUsageTracker: Map<string, {
    sessionId: string;
    startTime: number;
    model: string;
    inputAudioDuration: number; // seconds
    outputAudioDuration: number; // seconds
    textInputChars: number;
    textOutputChars: number;
  }> = new Map();

  // Track response start times for accurate duration calculation
  private responseStartTime: Map<string, number> = new Map();

  // Track when waiting for initial agent greeting completion to discard early user audio
  private waitingForAgentGreetingComplete: Map<string, boolean> = new Map();

  // Token rates for different models (costs per 1000 tokens direct)
  private TOKEN_RATES: { [key: string]: {
    audioInput: number;
    audioOutput: number;
    textInputRate: number;
    textOutputRate: number;
    audioInputRate: number;
    audioOutputRate: number;
  }} = {
    'gpt-realtime-mini': {
      audioInput: 85, // tokens per second
      audioOutput: 85,
      textInputRate: 0.00015,  // cost per 1000 tokens (already divided by 1000)
      textOutputRate: 0.0006,   // cost per 1000 tokens
      audioInputRate: 0.0006,   // cost per 1000 tokens
      audioOutputRate: 0.0024   // cost per 1000 tokens
    },
    'gpt-realtime-preview': {
      audioInput: 85,
      audioOutput: 85,
      textInputRate: 0.0015,    // cost per 1000 tokens
      textOutputRate: 0.006,    // cost per 1000 tokens
      audioInputRate: 0.06,     // cost per 1000 tokens
      audioOutputRate: 0.24     // cost per 1000 tokens
    }
  };

  // New maps for deterministic handling
  private sessionLocks: Map<string, Promise<void>> = new Map();
  private lastUserItemId: Map<string, string> = new Map();
  private lastAssistantItemId: Map<string, string> = new Map();
  private responseTextBuffers: Map<string, string> = new Map();
  private responseAudioTranscriptBuffers: Map<string, string> = new Map();
  private processingTimeouts: Map<string, NodeJS.Timeout> = new Map();

  // single-slot response queue (keep latest), and in-flight marker
  private responseQueue: Map<string, { instructions: string; previousItemId?: string; modalities?: string[]; max_output_tokens?: number }> = new Map();
  private inFlightResponseId: Map<string, string> = new Map();

  // Track server-side active response id (prevents creating when server already has one)
  private activeServerResponseId: Map<string, string> = new Map();

  // retry counters for queued creates
  private createRetryCounts: Map<string, number> = new Map();
  private MAX_CREATE_RETRIES = 3;
  private CREATE_RETRY_DELAY_MS = 400;

  // Configurable processing timeout (fallback quick ack)
  private PROCESSING_TIMEOUT_MS = 10000;

  // Turn count tracking for conversation pruning
  private turnCounts: Map<string, number> = new Map();


  // --- Auto-prune conversation history to keep latency stable ---
private async maybePruneConversation(sessionId: string, ws: WebSocket | null, turnCount: number) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const PRUNE_INTERVAL = 10;   // every 10 patient turns

    // run only every PRUNE_INTERVAL turns
    if (turnCount % PRUNE_INTERVAL !== 0) return;

    console.log(`🧹 Summarizing and pruning conversation history for ${sessionId} (turn ${turnCount})`);

    // Create a summary of the conversation so far
    const summaryMessage = await this.generateConversationSummary(sessionId, turnCount);

    // Step 1: Inject summary as a system message to preserve contexts
    const summaryPayload = {
      type: "conversation.item.create",
      item: {
        id: uuidv4().substring(0, 24), // OpenAI requires unique ID <= 32 chars
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text", // OpenAI API requires "input_text" for conversation item content
            text: summaryMessage
          }
        ]
      }
    };

    console.log(`📝 Injecting conversation summary for ${sessionId}`);
    ws.send(JSON.stringify(summaryPayload));

    // Short delay to ensure summary is processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Step 2: Simplified pruning - remove the truncate step entirely for now
    // OpenAI truncate API seems inconsistent, so skip this step
    // The summary injection preserves context without needing truncation
    console.log(`⏩ Skipping conversation.item.truncate due to API inconsistencies`);

    // Audit log
    try {
      db.insertAuditLog({
        action: 'conversation_summarized_only',
        details: JSON.stringify({
          turn_count: turnCount,
          summary_length: summaryMessage.length
        }),
        session_id: sessionId
      });
    } catch (err) {
      console.warn('Failed to record summarize audit:', err);
    }

    console.log(`✅ Conversation summarized and pruned for ${sessionId} (summary: ${summaryMessage.length} chars)`);

  } catch (err) {
    console.error('maybePruneConversation error:', err);
  }
}

private generateConversationSummary(sessionId: string, turnCount: number): string {
  try {
    // Collect context from our data structures
    const patientTranscripts = Array.from(this.lastPatientTranscript.entries())
      .filter(([sid]) => sid === sessionId)
      .map(([_, transcript]) => transcript);

    const agentResponses = Array.from(this.lastAgentResponse.entries())
      .filter(([sid]) => sid === sessionId)
      .map(([_, response]) => response);

    // Extract key medical information
    const keySymptoms = this.extractKeySymptoms(patientTranscripts);
    const keyHistory = this.extractMedicalHistory(patientTranscripts);
    const intakeProgress = this.estimateIntakeProgress(turnCount);

    // Build summary
    const summaryParts = [];

    if (keySymptoms.length > 0) {
      summaryParts.push(`Patient symptoms: ${keySymptoms.join(', ')}`);
    }

    if (keyHistory.length > 0) {
      summaryParts.push(`Medical history: ${keyHistory.join(', ')}`);
    }

    summaryParts.push(`Intake progress: ${intakeProgress}`);

    if (agentResponses.length > 0) {
      summaryParts.push(`Had ${agentResponses.length} conversations`);
    }

    const summary = summaryParts.join('. ') + '.';

    console.log(`📋 Generated summary for ${sessionId}: ${summary}`);
    return `CONVERSATION SUMMARY (turns 1-${turnCount}): ${summary} Continue with medically appropriate questions.`;

  } catch (err) {
    console.error('Error generating conversation summary:', err);
    // Fallback summary
    return `CONVERSATION SUMMARY: Patient has been describing their medical concerns through ${turnCount} interactions. Continue with appropriate medical intake questions.`;
  }
}

private extractKeySymptoms(transcripts: string[]): string[] {
  const symptoms: string[] = [];
  const symptomKeywords = [
    'pain', 'headache', 'nausea', 'dizziness', 'chest pain', 'back pain',
    'stomach pain', 'fever', 'cough', 'shortness of breath', 'fatigue',
    'anxiety', 'depression', 'insomnia', 'rash', 'swelling'
  ];

  transcripts.forEach(transcript => {
    symptomKeywords.forEach(keyword => {
      if (transcript.toLowerCase().includes(keyword) && !symptoms.includes(keyword)) {
        symptoms.push(keyword);
      }
    });
  });

  return symptoms;
}

private extractMedicalHistory(transcripts: string[]): string[] {
  const history: string[] = [];
  const historyKeywords = [
    'diabetes', 'hypertension', 'heart disease', 'asthma', 'cancer',
    'surgery', 'medication', 'allergy', 'pregnant', 'smoking', 'drinking'
  ];

  transcripts.forEach(transcript => {
    historyKeywords.forEach(keyword => {
      if (transcript.toLowerCase().includes(keyword) && !history.includes(keyword)) {
        history.push(keyword);
      }
    });
  });

  return history;
}

private estimateIntakeProgress(turnCount: number): string {
  if (turnCount < 5) return 'chief complaint gathered';
  if (turnCount < 10) return 'symptom details collected';
  if (turnCount < 15) return 'medical history in progress';
  if (turnCount < 20) return 'social history gathering';
  return 'comprehensive intake nearly complete';
}


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
        name: 'end_session',
        description: 'End the medical intake session when patient expressly consents or when intake is naturally complete',
        parameters: {
          type: 'object',
          properties: {
            consent_given: {
              type: 'boolean',
              description: 'Must be true - patient explicitly confirmed they want to end session'
            },
            reason: {
              type: 'string',
              enum: ['intake_complete', 'patient_request', 'patient_uncomfortable', 'timeout'],
              description: 'Reason for ending session'
            },
            summary_needed: {
              type: 'boolean',
              description: 'Whether to provide a summary before ending'
            }
          },
          required: ['consent_given', 'reason']
        }
      }/* ,
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
      } */
    ];
  }

  // --- Session lock helper (serialize per-session work) ---
  private async withSessionLock(sessionId: string, fn: () => Promise<void>) {
    const prev = this.sessionLocks.get(sessionId) || Promise.resolve();
    let release: () => void;
    const next = new Promise<void>(res => (release = res));
    this.sessionLocks.set(sessionId, prev.then(() => next));
    try {
      await prev; // wait for prior
      await fn();
    } finally {
      release!();
      // cleanup if no one waiting
      if (this.sessionLocks.get(sessionId) === next) this.sessionLocks.delete(sessionId);
    }
  }

  private queueAgentSave(sid: string, transcript: string) {
    // FIXED: Get speech timestamp ONCE when queued, not when timer fires
    const speechStopTime = this.patientSpeechStopTimestamp.get(sid) || 0;
    const ts = new Date(speechStopTime + 100).toISOString(); // Agent response comes after patient stops

    console.log(`⏰ Queuing agent save for ${sid} with speech stop time: ${speechStopTime}, timestamp: ${ts}`);

    const arr = this.pendingAgentSaves.get(sid) || [];
    const id = uuidv4();
    const timer = setTimeout(() => {
      const pending = this.pendingAgentSaves.get(sid) || [];
      const idx = pending.findIndex((p: { id: string; transcript: string; ts: string; timer?: any }) => p.id === id);

      if (idx !== -1) {
        const item = pending.splice(idx, 1)[0];
        if (pending.length > 0) this.pendingAgentSaves.set(sid, pending);
        else this.pendingAgentSaves.delete(sid);
        try {
          console.log(`🕒 Agent defer timeout reached — saving agent for ${sid} with timestamp: ${item.ts}`);
          this.saveAgentTranscriptImmediate(sid, item.transcript, item.ts);
        } catch (err) {
          console.error('Error flushing deferred agent save:', err);
        }
      }
    }, this.AGENT_DEFER_MS);

    arr.push({ id, transcript, ts, timer });
    this.pendingAgentSaves.set(sid, arr);
  }

  private flushPendingAgents = (sid: string) => {
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

  private normalizeEventType(type: string) {
    // strip "conversation.item." prefix to ease matching
    if (!type) return '';
    return type.replace(/^conversation\.item\./, '');
  }

  // flush queued single-slot response (latest wins)
  private flushQueuedResponse(sessionId: string) {
    const queued = this.responseQueue.get(sessionId);
    if (!queued) return;
    // pop it and send (only the latest)
    this.responseQueue.delete(sessionId);
    console.log(`Flushing queued response for ${sessionId}`);
    // reset retry count
    this.createRetryCounts.delete(sessionId);
    this.sendExplicitResponseCreate(sessionId, queued.previousItemId, queued.instructions || '', queued.modalities, queued.max_output_tokens);
  }

  private handleRealtimeResponse(sessionId: string, data: Buffer): void {
    try {
      const event = JSON.parse(data.toString());
      const eventType = this.normalizeEventType(event.type);
      //console.log(`Realtime event for ${sessionId}:`, eventType);

      const frontendWs = this.frontendSockets.get(sessionId);
      if (!frontendWs && eventType !== 'session.updated' && eventType !== 'session.update') {
        console.warn(`No frontend WebSocket found for session ${sessionId}`);
        // continue though: we still want to keep DB/audit etc.
      }

      const nowMs = Date.now();

      switch (eventType) {
        case 'session.updated':
        case 'session.update':
          console.log(`✅ Session updated successfully for ${sessionId} - AI is ready to respond`);
          if (frontendWs) frontendWs.send(JSON.stringify({ type: 'session_ready', sessionId }));
          break;

        case 'error':
          console.error(`❌ OpenAI error event for ${sessionId}:`, event.error);
          if (event.error?.message) {
            console.error(`Error message: ${event.error.message}`);
          }
          // If API says conversation already has an active response, schedule a retry flush
          if (event.error?.code === 'conversation_already_has_active_response') {
            console.warn(`API reports active response for ${sessionId}. Will retry queued response after delay.`);
            const retry = (this.createRetryCounts.get(sessionId) || 0) + 1;
            this.createRetryCounts.set(sessionId, retry);

            if (retry <= this.MAX_CREATE_RETRIES) {
              setTimeout(() => {
                // flush queued response when server is likely done (or will be after the current response finishes)
                this.flushQueuedResponse(sessionId);
              }, this.CREATE_RETRY_DELAY_MS);
            } else {
              console.warn(`Max create retries reached for ${sessionId}. Dropping queued response.`);
              this.responseQueue.delete(sessionId);
              this.createRetryCounts.delete(sessionId);
            }
          }

          if (frontendWs) {
            frontendWs.send(JSON.stringify({
              type: 'error',
              message: event.error?.message || 'OpenAI API error',
              timestamp: new Date().toISOString()
            }));
          }
          break;

        case 'input_audio_buffer.speech_started':
          console.log(`🎤 Patient started speaking (${sessionId})`);
          this.recentPatientActivity.set(sessionId, nowMs);
          if (!this.patientTurnTimestamp.has(sessionId)) {
            this.patientTurnTimestamp.set(sessionId, nowMs);
          }

          // DETECT INTERRUPTION: If agent was speaking and patient starts again quickly
          const lastAgentActivity = this.lastAgentResponse.get(sessionId);
          if (lastAgentActivity) {
            const timeSinceLastAgent = nowMs - (this.patientSpeechStopTimestamp.get(sessionId) || 0);
            if (timeSinceLastAgent < 2000) { // Within 2 seconds of agent finishing = potential interruption
              console.log(`⚡ INTERRUPTION DETECTED: Patient interrupting agent speech (${timeSinceLastAgent}ms ago)`);

              // send truncate for currently playing assistant audio (if available)
              const assistantItemId = this.lastAssistantItemId.get(sessionId);
              if (assistantItemId) {
                const truncateMsg = {
                  type: 'conversation.item.truncate',
                  item_id: assistantItemId,
                  content_index: 0,
                  audio_end_ms: 0
                };
                try {
                  const realtimeWs = this.connections.get(sessionId);
                  realtimeWs?.send(JSON.stringify(truncateMsg));
                  console.log(`Sent conversation.item.truncate for assistant item ${assistantItemId} due to interruption`);
                } catch (err) {
                  console.error('Error sending conversation.item.truncate:', err);
                }
              }

              // Cancel any queued agent saves and queued responses, clear in-flight flags & timers
              this.cancelQueuedResponses(sessionId);
              this.lastInterruptionTime.set(sessionId, nowMs);

              if (this.responseInProgress.get(sessionId)) {
                this.responseInProgress.set(sessionId, false);
              }
              if (this.inFlightResponseId.has(sessionId)) {
                this.inFlightResponseId.delete(sessionId);
              }
              if (this.processingTimeouts.has(sessionId)) {
                clearTimeout(this.processingTimeouts.get(sessionId)!);
                this.processingTimeouts.delete(sessionId);
              }
            }
          }
          break;

        case 'input_audio_buffer.speech_stopped':
          this.recentPatientActivity.set(sessionId, nowMs);
          this.patientSpeechStopTimestamp.set(sessionId, nowMs);
          console.log(`🛑 Patient stopped speaking (${sessionId}) - OpenAI will create response automatically with create_response: true`);

          // Track input audio duration for token usage
          const inputStart = this.recentPatientActivity.get(sessionId) || nowMs;
          const inputDuration = (nowMs - inputStart) / 1000;
          const inputTracker = this.sessionUsageTracker.get(sessionId);
          if (inputTracker) {
            inputTracker.inputAudioDuration += inputDuration;
            this.sessionUsageTracker.set(sessionId, inputTracker);
          }
          break;

        case 'input_audio_transcription.delta':
        case 'conversation.item.input_audio_transcription.delta':
          this.recentPatientActivity.set(sessionId, nowMs);
          // you were sending realtime deltas to frontend - keep that
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

        case 'input_audio_transcription.completed':
        case 'conversation.item.input_audio_transcription.completed':
          // Process transcription for logging only - response is already triggered by speech_stopped
          console.log(`📝 Processing transcription for ${sessionId}: ${eventType}`);
          if (event.transcript || event.text) {
            const transcript = (event.transcript || event.text).toString();

            // run everything under session lock to avoid races
            this.withSessionLock(sessionId, async () => {
              if (!transcript.trim() || transcript.trim().length < 3) {
                console.log(`⚠️ Skipping empty/short transcript for ${sessionId}`);
                return;
              }

              const lastTranscript = this.lastPatientTranscript.get(sessionId);
              if (lastTranscript === transcript.trim()) {
                console.log(`🔄 Duplicate transcript detected for ${sessionId}, skipping transcription processing`);
                return;
              }

              // Increment turn count and trigger conversation pruning if needed (moved from speech_stopped because response already triggered)
              const currentTurn = (this.turnCounts.get(sessionId) || 0) + 1;
              this.turnCounts.set(sessionId, currentTurn);
              this.maybePruneConversation(sessionId, this.connections.get(sessionId) || null, currentTurn);

              // Save transcript - use speech STOP time for correct sequencing (response already triggered)
              this.lastPatientTranscript.set(sessionId, transcript.trim());

              const speechStopTime = this.patientSpeechStopTimestamp.get(sessionId) || nowMs;
              const ts = new Date(speechStopTime).toISOString();
              console.log(`👤 Patient transcript saved (response already triggered): "${transcript}" - timestamp: ${ts}`);

              try {
                // save patient message in DB for logging/analytics
                await db.saveConversationLog({
                  session_id: sessionId,
                  speaker: 'patient',
                  message: transcript,
                  audio_data: JSON.stringify({ type: 'speech_transcript' }),
                  timestamp: new Date(speechStopTime)
                });

                // Capture user item id for future responses
                if (event.item && event.item.id) {
                  this.lastUserItemId.set(sessionId, event.item.id);
                }

              } catch (dbErr) {
                console.error(`Failed to save patient transcript for ${sessionId}:`, dbErr);
              }
            }).catch(err => {
              console.error(`Error saving transcription for ${sessionId}:`, err);
            });
          }
          break;

        case 'response.created':
          // Server acknowledges a response create — capture id and mark in-progress
          try {
            const respId = event.response?.id || event.id || (event.response && (event.response.response_id || event.response.responseId));
            if (respId) {
              this.activeServerResponseId.set(sessionId, respId);
              this.responseInProgress.set(sessionId, true);
              // Track when the response started for accurate duration calculation
              this.responseStartTime.set(sessionId, Date.now());

              // Set flag for initial greeting if no agent has responded yet
              if (!this.lastAgentResponse.has(sessionId)) {
                console.log(`🎭 Initial agent greeting started - discarding audio until complete`);
                this.waitingForAgentGreetingComplete.set(sessionId, true);
              }

              console.log(`✅ Server started response ${respId} for ${sessionId}`);
            } else {
              console.log(`✅ response.created received for ${sessionId} but no id found in payload`);
            }
          } catch (err) {
            console.warn('Error parsing response.created event:', err);
          }
          break;

        case 'response.output_item.added':
          // often used for partial output; we don't need to do anything special yet
          break;

        case 'response.output_item.done':
        case 'response.content_part.done':
        case 'response.content_part.added':
        case 'response.content_part.added': // keep idempotent
          // these are intermediate; do nothing special unless you want more instrumentation
          break;

        case 'response.audio.delta':
          if (event.delta) {
            const wsToFront = this.frontendSockets.get(sessionId);
            if (wsToFront) {
              wsToFront.send(JSON.stringify({
                type: 'agent_audio_chunk',
                audio: event.delta,
                timestamp: new Date().toISOString(),
                // Include response start time to track which response this belongs to
                responseStartTime: this.responseStartTime.get(sessionId)
              }));
            }
          }
          break;

        case 'response.audio.done':
          console.log(`🔊 Agent audio completed for ${sessionId}`);

          // Track output audio duration for token usage
          const outputEnd = Date.now();
          const responseStart = this.responseStartTime.get(sessionId) || (outputEnd - 1000); // Use tracked start time or fallback to 1 second
          const outputDuration = (outputEnd - responseStart) / 1000;
          console.log(`🔊 Response duration tracked: ${outputDuration.toFixed(2)} seconds (start: ${new Date(responseStart).toISOString()}, end: ${new Date(outputEnd).toISOString()})`);

          const tracker = this.sessionUsageTracker.get(sessionId);
          if (tracker) {
            tracker.outputAudioDuration += outputDuration;
            this.sessionUsageTracker.set(sessionId, tracker);
          }

          // Clear the waiting flag if agent greeting is complete
          if (this.waitingForAgentGreetingComplete.get(sessionId)) {
            console.log(`🎭 Agent greeting completed for ${sessionId} - now accepting user audio`);
            this.waitingForAgentGreetingComplete.delete(sessionId);
            this.lastAgentResponse.set(sessionId, 'greeting received'); // Track that agent has responded
          }

          // Clear the response start time
          this.responseStartTime.delete(sessionId);

          if (this.frontendSockets.get(sessionId)) {
            this.frontendSockets.get(sessionId)!.send(JSON.stringify({
              type: 'agent_response_complete',
              timestamp: new Date().toISOString()
            }));
          }
          // clear processing timeout if set
          if (this.processingTimeouts.has(sessionId)) {
            clearTimeout(this.processingTimeouts.get(sessionId)!);
            this.processingTimeouts.delete(sessionId);
          }

          // If server had an active response id, clear it now
          if (this.activeServerResponseId.has(sessionId)) {
            console.log(`Clearing server active response for ${sessionId} after audio.done`);
            this.activeServerResponseId.delete(sessionId);
          }
          this.responseInProgress.set(sessionId, false);

          // clear in-flight marker and flush queued response (if any)
          if (this.inFlightResponseId.has(sessionId)) this.inFlightResponseId.delete(sessionId);
          this.flushQueuedResponse(sessionId);
          break;

        case 'response.audio_transcript.delta':
          {
            // If we get transcript delta messages, send them to frontend if there's a new response starting
            if (event.delta) {
              const wsToFront = this.frontendSockets.get(sessionId);
              if (wsToFront) {
                wsToFront.send(JSON.stringify({
                  type: 'agent_transcript_delta',
                  text: event.delta,
                  timestamp: new Date().toISOString(),
                  // Include response start time to track which response this belongs to
                  responseStartTime: this.responseStartTime.get(sessionId)
                }));
              }
            }

            const existing = this.responseAudioTranscriptBuffers.get(sessionId) || '';
            this.responseAudioTranscriptBuffers.set(sessionId, existing + (event.delta || ''));
          }
          break;

        case 'response.audio_transcript.done':
          if (event.transcript) {
            const assembled = (this.responseAudioTranscriptBuffers.get(sessionId) || event.transcript).trim();
            this.responseAudioTranscriptBuffers.delete(sessionId);

            if (!this.isDuplicateAgentResponse(sessionId, assembled)) {
              const agentTranscript = assembled;
              const speechStopTime = this.patientSpeechStopTimestamp.get(sessionId) || Date.now();
              const agentTs = new Date(speechStopTime + 100).toISOString();
              console.log(`🤖 Agent responding for ${sessionId}: "${agentTranscript}" - timestamp: ${agentTs} (speechStop: ${speechStopTime})`);

              const lastPatientActivity = this.recentPatientActivity.get(sessionId) || 0;
              const ageSincePatientMs = nowMs - lastPatientActivity;

              if (lastPatientActivity && ageSincePatientMs < this.RECENT_PATIENT_WINDOW_MS) {
                console.log(`⚖️ Deferring agent save for ${sessionId} (recent patient activity ${ageSincePatientMs}ms ago)`);
                this.queueAgentSave(sessionId, agentTranscript);
                if (this.frontendSockets.get(sessionId)) {
                  this.frontendSockets.get(sessionId)!.send(JSON.stringify({
                    type: 'agent_transcript_complete',
                    transcript: agentTranscript,
                    timestamp: agentTs
                  }));
                }
              } else {
                this.saveAgentTranscriptImmediate(sessionId, agentTranscript, agentTs);
                if (this.frontendSockets.get(sessionId)) {
                  this.frontendSockets.get(sessionId)!.send(JSON.stringify({
                    type: 'agent_transcript_complete',
                    transcript: agentTranscript,
                    timestamp: agentTs
                  }));
                }
              }

              // cleanup processing timeout if set
              if (this.processingTimeouts.has(sessionId)) {
                clearTimeout(this.processingTimeouts.get(sessionId)!);
                this.processingTimeouts.delete(sessionId);
              }

              // clear in-flight marker and flush queued response (if any)
              if (this.inFlightResponseId.has(sessionId)) this.inFlightResponseId.delete(sessionId);
              this.flushQueuedResponse(sessionId);

              this.responseInProgress.set(sessionId, false);
            }
          }
          break;

        case 'response.function_call_arguments.done':
        case 'function_call':
        case 'conversation.item.function_call':
        case 'tool_call':
        case 'function_call_response':
          console.log(`🔧 Function call related event for ${sessionId}:`, eventType);
          // reuse existing handler to parse and handle function calls
          if (event.arguments && event.name) {
            this.handleRealtimeFunctionCall(sessionId, event.name, event.arguments);
          } else if (event.item && event.item.function_call) {
            const functionCall = event.item.function_call;
            if (functionCall.arguments && functionCall.name) {
              this.handleRealtimeFunctionCall(sessionId, functionCall.name, functionCall.arguments);
            }
            // capture function-call item id if present
            if (event.item && event.item.id) {
              // optionally store for linking outputs
            }
          } else if (event.tool_call && event.tool_call.function) {
            const toolFunction = event.tool_call.function;
            if (toolFunction.arguments && toolFunction.name) {
              this.handleRealtimeFunctionCall(sessionId, toolFunction.name, toolFunction.arguments);
            }
          }
          break;

        case 'conversation.item.created':
          // authoritative server item created; capture item ids for ordering
          if (event.item && event.item.id) {
            const created = event.item;
            if (created.role === 'user') {
              this.lastUserItemId.set(sessionId, created.id);
            } else if (created.role === 'assistant') {
              this.lastAssistantItemId.set(sessionId, created.id);
            }
            // persist if needed (some created items arrive after you saved them locally)
            // You can also reconcile DB rows here using created.id
          }
          break;

        case 'response.output_item.done':
        case 'response.done':
          // server finished response — clear server active marker and flush queued
          if (this.activeServerResponseId.has(sessionId)) {
            console.log(`Clearing server active response for ${sessionId} after response.done`);
            this.activeServerResponseId.delete(sessionId);
          }
          this.responseInProgress.set(sessionId, false);
          // clear any processing timeouts
          if (this.processingTimeouts.has(sessionId)) {
            clearTimeout(this.processingTimeouts.get(sessionId)!);
            this.processingTimeouts.delete(sessionId);
          }
          // flush queued response
          this.flushQueuedResponse(sessionId);
          break;

        default:
          console.log(`Unhandled realtime event ${event.type} (normalized ${eventType}) for ${sessionId}`);
          break;
      }
    } catch (err) {
      console.error('Error in handleRealtimeResponse:', err);
    }
  }

  private async handleRealtimeFunctionCall(sessionId: string, name: string, argumentsJson: string): Promise<void> {
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

        case 'end_session':
          this.handleEndSession(args, sessionId);
          if (frontendWs) {
            frontendWs.send(JSON.stringify({
              type: 'end_session',
              consent_given: args.consent_given,
              reason: args.reason,
              summary_needed: args.summary_needed,
              timestamp: new Date().toISOString()
            }));
          }
          break;

        // case 'save_response':
        //   this.handleSaveResponse({ ...args, sessionId });
        //   break;

        // case 'log_conversation':
        //   this.handleLogConversation({ ...args, sessionId });
        //   break;

        default:
          console.warn(`Unknown function call: ${functionName}`);
      }
    } catch (error) {
      console.error(`Error handling function call: ${error}`);
    }
    
  }

  private handleEndSession(args: any, sessionId: string): void {
    console.log(`🏁 End Session requested for ${sessionId}:`, args);

    if (!args.consent_given) {
      console.log(`❌ End session request denied - no consent given for ${sessionId}`);
      return;
    }

    try {
      // Log the end session event
      db.insertAuditLog({
        action: 'session_ended_by_agent',
        details: JSON.stringify({
          reason: args.reason || 'unknown',
          summary_needed: args.summary_needed || false,
          consent_given: args.consent_given
        }),
        session_id: sessionId
      });

      // End the session after a short delay for natural flow
      setTimeout(async () => {
        console.log(`🏁 Automatically ending session ${sessionId} by agent request`);
        await this.endSession(sessionId);
      }, 2000); // 2 second delay

      console.log(`✅ Session ${sessionId} will end automatically in 2 seconds`);
    } catch (error) {
      console.error(`Failed to handle end session request for ${sessionId}:`, error);
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
      // db.saveConversationLog({
      //   session_id: sessionId,
      //   speaker: args.speaker || 'unknown',
      //   message: args.message || args.details || '',
      //   timestamp: new Date()
      // });
    } catch (error) {
      console.error('Failed to log conversation:', error);
    }
  }

  private cancelQueuedResponses(sessionId: string): void {
    // Cancel all pending agent saves for this session (deferred saves)
    const pending = this.pendingAgentSaves.get(sessionId);
    if (pending && pending.length > 0) {
      console.log(`🛑 Canceling ${pending.length} queued agent responses for session ${sessionId} due to interruption`);
      for (const item of pending) {
        clearTimeout(item.timer);
      }
      this.pendingAgentSaves.delete(sessionId);
    }

    // Clear the single-slot response queue if present
    if (this.responseQueue.has(sessionId)) {
      console.log(`🧹 Dropping queued response for session ${sessionId} due to interruption`);
      this.responseQueue.delete(sessionId);
    }

    // Reset retry counter
    if (this.createRetryCounts.has(sessionId)) this.createRetryCounts.delete(sessionId);
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
    if (!message) return true;
    const normalize = (s: string) => s.replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').toLowerCase().trim();
    const msgHash = crypto.createHash('sha256').update(normalize(message)).digest('hex').slice(0, 12);
    const lastHash = lastResponse ? crypto.createHash('sha256').update(normalize(lastResponse)).digest('hex').slice(0, 12) : null;
    if (lastHash === msgHash) {
      console.log(`⚠️ Skipping duplicate agent response (hash match) for session ${sessionId}`);
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

        //const modelName = config.model || 'gpt-realtime';
        const modelName = 'gpt-realtime-mini';

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

          // Initialize token usage tracking
          this.sessionUsageTracker.set(config.sessionId, {
            sessionId: config.sessionId,
            startTime: Date.now(),
            model: config.model || 'gpt-realtime-mini',
            inputAudioDuration: 0,
            outputAudioDuration: 0,
            textInputChars: 0,
            textOutputChars: 0
          });

          const sessionSystemPrefix = `
SYSTEM RULES (READ CAREFULLY):
1) For every discrete intake question the assistant asks, when the patient answers you MUST call the function save_response exactly once with a JSON object:
   save_response({"question":"<the assistant's last question>","answer":"<the patient's exact answer>","category":"<optional: symptoms|medications|history|general>"})
   Do NOT output the patient's answer as plain text. Use the function call instead.

2) For non-structured notes, debug messages, or internal assistant notes call:
   log_conversation({"speaker":"assistant","message":"<freeform note>"})

3) If you detect an urgent symptom, call the red_flag_detected(...) function immediately.

4) ENDING THE SESSION: Always get explicit patient consent before ending. When you have completed collecting all required information, summarize briefly and ask for confirmation. If patient says YES/CONFIRMS/OKAYS the summary, call end_session({"consent_given": true, "reason": "intake_complete"}). If patient says NO or asks to end early for any reason, call end_session({"consent_given": true, "reason": "patient_request"}). If they decline to end, continue asking questions.

5) Always respond in English, keep replies concise, and ask one question at a time.

EXAMPLES (few-shot):
Example 1 - Simple intake:
  Assistant asks: "Do you have chest pain?"
  Patient: "Yes — for two days, worse on exertion."
  Assistant must call:
    save_response({"question":"Do you have chest pain?","answer":"Yes — for two days, worse on exertion.","category":"symptoms"})

Example 2 - Non-structured note:
  Assistant internal note: "Patient seemed hesitant describing family history."
  Assistant should call:
    log_conversation({"speaker":"assistant","message":"Patient hesitated when describing family history"})

Example 3 - Red flag:
  If patient says "I can't breathe" call:
    red_flag_detected({"symptoms":["shortness of breath"], "severity":"critical"})
`.trim();

          // keep the user's provided instructions but make English mandatory
          const validatedInstructions = this.validateInstructions(config.instructions || '');
          const enforcedInstructions = `${sessionSystemPrefix}\n\n${validatedInstructions}`;

          console.log(`📝 Using validated instructions (${validatedInstructions.length} chars)`);
          console.log('temparature:', config.temperature);
          console.log('voice:', config.voice);

          const systemPrompt = `You are Healthyoda, a professional medical intake voice agent. Your role is to collect structured clinical information including History of Present Illness (HPI), Review of Systems (ROS), and Past Medical, Family, and Social History (PMFSH) to produce a complete, high-fidelity clinical note that supports Level 5 billing. You must NOT give medical advice, diagnosis, reassurance, or interpretation. Only collect and confirm information for the licensed provider.

---

PERSONALITY & TONE:
- Professional, neutral, and empathetic.
- Speak clearly, like a physician.
- Ask only ONE short question at a time (≤ 20 words).
- Maintain natural pace and vary phrasing (no repetition within 5 turns).
- Use calm empathy if patient is distressed, but stay objective.

---

LANGUAGE & AUDIO RULES:
- Language: English only. If patient speaks another language, say: "I'm sorry—we support English only. Your provider will discuss details."
- If audio unclear: "I apologize, could you please repeat that?"
- When repeating numbers: speak each digit individually (e.g., "four-one-five").

---

SAFETY & ESCALATION:
- Never provide advice, diagnosis, or reassurance.
- If asked a medical question, reply with: "Your provider will discuss this with you." or "I'm here only to collect information for your provider."
- If patient mentions red-flag symptoms (chest pain, trouble breathing, severe bleeding, loss of consciousness, slurred speech, weakness, facial droop, suicidal thoughts):
  1) Trigger red_flag_detected(patient_exact_words)
  2) Say: "This seems a critical symptom. I am raising a critical alert to your provider immediately. Please stay where you are, and help will be with you shortly."
  3) Stop intake until escalation logic resumes.

---

CONVERSATION PHASES (follow strictly in order):
1) Chief Concern: Start with: "Hello, I am HealthYoda. I’ll be assisting you with a brief intake process for your provider. What brings you in today?"
2) Extended HPI: Collect onset, duration, location, quality, severity (0–10), course, assoc. sx, aggravating/relieving, prior episodes, impact, patient perspective."
3) System-specific follow-ups
4) ROS: cover ≥10 systems
5) PMFSH: chronic conditions, surgeries, meds, allergies, social, family history
6) Summarize & Close: Confirm and close with: "Thank you. I’ve recorded this complete clinical information. Your provider will review it with you shortly."
`;

          console.log('Final session instructions:', enforcedInstructions);

          // NOTE: Switched to automatic responses with Server VAD for cleaner interaction
          const sessionConfig = {
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: validatedInstructions,
              voice: config.voice || 'alloy',
              input_audio_format: 'pcm16',
              output_audio_format: 'pcm16',
              input_audio_transcription: { model: 'gpt-4o-transcribe',language: 'en' },
              turn_detection: {
                type: "server_vad",
                prefix_padding_ms: 400,
                silence_duration_ms: 500,
                create_response: true // Let OpenAI handle automatic responses
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

  // helper to send an explicit response.create anchored to previous_item_id
  // NOTE: now accepts optional temperature and will automatically use lastUserItemId if previousItemId is not provided
  private sendExplicitResponseCreate(sessionId: string, previousItemId: string | undefined, instructions: string, modalities = ['audio', 'text'], max_output_tokens = 800, temperature?: number) {
    const realtimeWs = this.connections.get(sessionId);
    if (!realtimeWs || realtimeWs.readyState !== WebSocket.OPEN) {
      console.warn(`Cannot create explicit response: no Realtime WS for ${sessionId}`);
      return;
    }

    // Prepend English enforcement
    const engPrefix = `You MUST respond only in English. Keep replies concise and clear. Ask only one question at a time. `;
    instructions = engPrefix + (instructions || '');

    // If server already has an active response for this session, enqueue the create instead of trying to send
    if (this.activeServerResponseId.has(sessionId)) {
      console.log(`Server already has active response for ${sessionId} (${this.activeServerResponseId.get(sessionId)}). Enqueueing response and will flush when server clears.`);
      this.responseQueue.set(sessionId, { instructions, previousItemId, modalities, max_output_tokens });
      return;
    }

    // If a local response is already in progress according to our marker, keep only the latest queued response (single-slot)
    if (this.responseInProgress.get(sessionId)) {
      console.log(`Response in progress for ${sessionId} — enqueueing latest response and dropping previous queued response`);
      this.responseQueue.set(sessionId, { instructions, previousItemId, modalities, max_output_tokens });
      return;
    }

    // No response in progress: create and mark in-flight
    const reqId = uuidv4();
    this.inFlightResponseId.set(sessionId, reqId);
    // Note: don't set activeServerResponseId yet — wait for server's response.created event.
    this.responseInProgress.set(sessionId, true);

    const payload: any = {
      type: 'response.create',
      response: {
        modalities
      }
    };

    // Use the provided previousItemId, or fall back to the lastUserItemId captured from conversation.item.created
    const prevId = previousItemId || this.lastUserItemId.get(sessionId);
    if (prevId) payload.response.previous_item_id = prevId;

    // Add temperature only if provided (so we don't override session default unless caller wants to)
    if (typeof temperature === 'number') {
      payload.response.temperature = temperature;
    }

    try {
      realtimeWs.send(JSON.stringify(payload));
      console.log(`📤 response.create sent for ${sessionId} (reqId=${reqId})`);
      // set a processing timeout fallback
      if (this.processingTimeouts.has(sessionId)) clearTimeout(this.processingTimeouts.get(sessionId)!);
      const to = setTimeout(() => {
        if (this.responseInProgress.get(sessionId)) {
          console.warn(`Processing timeout for response ${reqId} on ${sessionId}. Clearing in-flight and flushing queue.`);
          this.responseInProgress.set(sessionId, false);
          this.inFlightResponseId.delete(sessionId);
          this.flushQueuedResponse(sessionId);
        }
      }, this.PROCESSING_TIMEOUT_MS);
      this.processingTimeouts.set(sessionId, to);
    } catch (err) {
      console.error('Failed to send explicit response.create:', err);
      this.responseInProgress.set(sessionId, false);
      this.inFlightResponseId.delete(sessionId);
    }
  }

  // quick low-risk acknowledgement helper (explicit manual ack)
  private callQuickAck(sessionId: string, previousItemId?: string) {
    // Explicit small ack
    this.sendExplicitResponseCreate(sessionId, previousItemId, 'Provide a short acknowledgement such as "Okay" or "Got it" (<= 1s). Do not ask questions.', ['audio','text'], 30);
  }

  // Handler to decide if/when to call response.create
  private async handleFinalPatientTranscript(sessionId: string, transcript: string, userItemId?: string) : Promise<void> {
    try {
      // quick rules (example) - customize for your intake flow
/*       const shortAck = transcript.split(/\s+/).length <= 2 && transcript.length < 20;
      if (shortAck) {
        // short interjection - send small ack
        this.callQuickAck(sessionId, userItemId);
        return;
      } */

      // quick red flag scan (example using constants you had)
      for (const pattern of RED_FLAG_PATTERNS) {
        const re = new RegExp(pattern, 'i');
        if (re.test(transcript)) {
          // escalate: explicitly create a response that triggers the red_flag_detected function
          // instruct the model to call the function (or rely on model function call)
          this.sendExplicitResponseCreate(sessionId, userItemId, 'You are a physician. If the user mentions critical symptoms, call the red_flag_detected function with symptoms and severity. Otherwise continue intake.', ['audio','text'], 400);
          return;
        }
      }

      // default: normal intake flow - ask next question via explicit response
      // you may craft context-specific instructions here
      this.sendExplicitResponseCreate(sessionId, userItemId, '', ['audio','text'], 600);
      /* this.sendExplicitResponseCreate(sessionId, userItemId,
        `When the user answered the previous question, DO NOT print the answer as text.
         Instead CALL the function save_response exactly once with JSON:
         save_response({"question":"<the assistant's last question>", "answer":"<the patient's answer>", "category":"<symptoms|medications|history|general>"})
         If unsure, ask a brief clarifying question. Do not add extra commentary.`,
        ['audio','text'],
        600,
        0.6 // temperature set to zero
      ); */
    } catch (err) {
      console.error('Error in handleFinalPatientTranscript:', err);
      // fallback quick ack
      this.callQuickAck(sessionId, userItemId);
    }
  }

  sendAudioData(sessionId: string, audioDataObject: any): void {
    // SMART AUDIO GATING: Discard audio during initial agent greeting to ensure clean model start
    if (this.waitingForAgentGreetingComplete.get(sessionId)) {
      console.log(`🔇 Discarding audio for ${sessionId} - still waiting for agent greeting to complete`);
      return; // Don't send any audio data to AI during the initial greeting
    }

    const realtimeWs = this.connections.get(sessionId);
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      try {
        if (!audioDataObject.pcm16 || !Array.isArray(audioDataObject.pcm16)) {
          console.error('❌ Invalid audio data format. Expected {pcm16: [...], timestamp: number}');
          return;
        }

        const pcmSamples = audioDataObject.pcm16;

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
      // Remove 500ms delay - trigger agent response immediately to prevent audio timing issues
      console.log('▶️ Triggering initial agent response after frontend link');
      this.sendExplicitResponseCreate(sessionId, undefined, 'You are a medical intake assistant. Greet the patient briefly and begin with Chief Concern like "What brings you in today?" ', ['audio','text'], 200);
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

    // DEBUG: Log all tracked usage data
    const usageTracker = this.sessionUsageTracker.get(sessionId);
    if (usageTracker) {
      console.log(`🔍 TOKEN USAGE DEBUG for ${sessionId}:`, {
        inputAudioDuration: usageTracker.inputAudioDuration,
        outputAudioDuration: usageTracker.outputAudioDuration,
        textInputChars: usageTracker.textInputChars,
        textOutputChars: usageTracker.textOutputChars,
        model: usageTracker.model
      });
    } else {
      console.log(`⚠️ No token usage tracker found for session ${sessionId}`);
    }

    // Save token usage data when session ends
    const usageData = this.getSessionTokenUsage(sessionId);
    console.log(`🔍 getSessionTokenUsage result for ${sessionId}:`, usageData);

    // Force save even if cost is 0 - we want to track usage regardless
    if (usageData) {
      try {
        console.log(`💰 Saving token usage for session ${sessionId}: cost=$${usageData.estimatedCost}, tokens=${usageData.inputAudioTokens + usageData.outputAudioTokens + usageData.textInputTokens + usageData.textOutputTokens}`);
        await db.saveSessionTokenUsage({
          session_id: usageData.sessionId,
          model: usageData.model,
          input_audio_tokens: usageData.inputAudioTokens,
          output_audio_tokens: usageData.outputAudioTokens,
          text_input_tokens: usageData.textInputTokens,
          text_output_tokens: usageData.textOutputTokens,
          input_audio_duration: usageData.inputAudioDuration,
          output_audio_duration: usageData.outputAudioDuration,
          estimated_cost: usageData.estimatedCost
        });
        console.log(`💰 ✅ Saved token usage for session ${sessionId}: $${usageData.estimatedCost}`);
      } catch (usageError: any) {
        console.error(`❌ Failed to save token usage for session ${sessionId}:`, usageError.message);
      }
    } else {
      console.log(`⚠️ No token usage data to save for session ${sessionId} (usageData exists: ${!!usageData})`);
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
    this.responseTextBuffers.delete(sessionId);
    this.responseAudioTranscriptBuffers.delete(sessionId);
    this.lastUserItemId.delete(sessionId);
    this.lastAssistantItemId.delete(sessionId);
    if (this.processingTimeouts.has(sessionId)) {
      clearTimeout(this.processingTimeouts.get(sessionId)!);
      this.processingTimeouts.delete(sessionId);
    }
    if (this.responseQueue.has(sessionId)) {
      this.responseQueue.delete(sessionId);
    }
    if (this.inFlightResponseId.has(sessionId)) {
      this.inFlightResponseId.delete(sessionId);
    }
    if (this.activeServerResponseId.has(sessionId)) {
      this.activeServerResponseId.delete(sessionId);
    }
    if (this.createRetryCounts.has(sessionId)) {
      this.createRetryCounts.delete(sessionId);
    }
    if (this.turnCounts.has(sessionId)) {
      this.turnCounts.delete(sessionId);
    }
  }

  // Get current session token usage estimation
  public getSessionTokenUsage(sessionId: string): any {
    const usageTracker = this.sessionUsageTracker.get(sessionId);
    if (!usageTracker) return null;

    const rates = this.TOKEN_RATES[usageTracker.model] || this.TOKEN_RATES['gpt-realtime-mini'];

    // Calculate token estimates
    const inputAudioTokens = Math.ceil(usageTracker.inputAudioDuration * rates.audioInput);
    const outputAudioTokens = Math.ceil(usageTracker.outputAudioDuration * rates.audioOutput);
    const textInputTokens = Math.ceil(usageTracker.textInputChars / 4); // ~4 chars per token
    const textOutputTokens = Math.ceil(usageTracker.textOutputChars / 4);

    // Calculate costs
    const inputAudioCost = (inputAudioTokens / 1000) * rates.audioInputRate;
    const outputAudioCost = (outputAudioTokens / 1000) * rates.audioOutputRate;
    const textInputCost = (textInputTokens / 1000) * rates.textInputRate;
    const textOutputCost = (textOutputTokens / 1000) * rates.textOutputRate;
    const estimatedCost = inputAudioCost + outputAudioCost + textInputCost + textOutputCost;

    return {
      sessionId: usageTracker.sessionId,
      model: usageTracker.model,
      inputAudioTokens,
      outputAudioTokens,
      textInputTokens,
      textOutputTokens,
      inputAudioDuration: usageTracker.inputAudioDuration,
      outputAudioDuration: usageTracker.outputAudioDuration,
      estimatedCost: Math.round(estimatedCost * 10000) / 10000, // to 4 decimal places
      lastUpdated: new Date().toISOString()
    };
  }

  handleMessage(sessionId: string, data: Buffer): void {
    this.handleRealtimeResponse(sessionId, data);
  }

  getSession(sessionId: string): WebSocket | null {
    return this.connections.get(sessionId) || null;
  }
}

export default OpenAIProvider;
