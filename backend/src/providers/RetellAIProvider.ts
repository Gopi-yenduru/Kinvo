import WebSocket from 'ws';
import { Retell } from 'retell-sdk';
import { BaseProvider, RealtimeConfig } from './BaseProvider.js';
import { WebCallProvider, WebCallConfig, WebCallResponse } from './WebCallProvider.js';
import db from '../database-manager.js';

class RetellAIProvider implements BaseProvider, WebCallProvider {
   private retellClient: Retell;
   private activeCalls: Map<string, { callId: string; sessionId: string }> = new Map();

   constructor() {
     if (!process.env.RETELLAI_API_KEY) {
       throw new Error('RETELLAI_API_KEY environment variable is required');
     }
     this.retellClient = new Retell({
       apiKey: process.env.RETELLAI_API_KEY,
     });
   }

   async createWebCall(config: WebCallConfig): Promise<WebCallResponse> {
     try {
       if (!process.env.RETELLAI_AGENT_ID) {
         throw new Error('RETELLAI_AGENT_ID environment variable is required');
       }

       console.log(`🔄 Creating RetellAI web call for session ${config.sessionId} with agent ${process.env.RETELLAI_AGENT_ID}`);

       const webCallResponse = await this.retellClient.call.createWebCall({
         agent_id: process.env.RETELLAI_AGENT_ID,
         // Requires the agent's prompt in the Retell dashboard to reference
         // {{medical_instructions}} — Retell has no per-call raw prompt override.
         retell_llm_dynamic_variables: config.instructions ? { medical_instructions: config.instructions } : undefined,
       });

       // Store the call mapping
       this.activeCalls.set(config.sessionId, {
         callId: webCallResponse.call_id,
         sessionId: config.sessionId
       });

       console.log(`✅ RetellAI web call created: ${webCallResponse.call_id}`);

       return {
         call_id: webCallResponse.call_id,
         access_token: webCallResponse.access_token,
         agent_id: webCallResponse.agent_id
       };

     } catch (error) {
       console.error('❌ Failed to create RetellAI web call:', error);
       throw error;
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

   handleFunctionCall(sessionId: string, name: string, argumentsJson: string, frontendCallback?: (event: any) => void): void {
     try {
       const args = JSON.parse(argumentsJson);
       console.log(`🔧 RetellAI function call: ${name} for session ${sessionId}`, args);

       switch (name) {
         case 'red_flag_detected':
           db.saveRedFlagEvent({
             session_id: sessionId,
             symptoms: JSON.stringify(args.symptoms || []),
             severity: args.severity || 'medium',
             resolved: false,
             clinician_notified: false
           });
           if (frontendCallback) {
             frontendCallback({
               type: 'red_flag_detected',
               symptoms: args.symptoms,
               severity: args.severity,
               timestamp: new Date().toISOString()
             });
           }
           break;

         case 'save_response':
           let category = 'general';
           if (args.question?.toLowerCase().includes('symptom')) category = 'symptoms';
           else if (args.question?.toLowerCase().includes('medication')) category = 'medications';
           else if (args.question?.toLowerCase().includes('condition') || args.question?.toLowerCase().includes('history')) category = 'history';

           db.createIntakeResponse({
             session_id: sessionId,
             question: args.question || '',
             answer: args.answer || '',
             category: category
           });

           // Log both question and answer
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
           break;

         case 'log_conversation':
           db.saveConversationLog({
             session_id: sessionId,
             speaker: args.speaker || 'unknown',
             message: args.message || ''
           });
           break;
       }
     } catch (error) {
       console.error('Error handling RetellAI function call:', error);
     }
   }

   async endCall(sessionId: string): Promise<void> {
      const callInfo = this.activeCalls.get(sessionId);
      if (callInfo) {
        try {
          // Optionally end the call via Retell API if needed
          console.log(`Ending RetellAI call ${callInfo.callId} for session ${sessionId}`);
          this.activeCalls.delete(sessionId);
        } catch (error: any) {
          console.error(`Error ending RetellAI call ${callInfo.callId}:`, error.message);
        }
      }
 
      try {
        db.updateSessionStatus(sessionId, 'completed');
        console.log(`✅ Database updated: Session ${sessionId} marked as completed`);
      } catch (error: any) {
        console.error(`❌ Failed to update database status for session ${sessionId}:`, error.message);
      }
    }
 
    // BaseProvider interface methods (not used for Retell AI - throws errors)
    async createRealtimeSession(config: RealtimeConfig): Promise<WebSocket | null> {
      throw new Error('RetellAIProvider does not support WebSocket-based realtime sessions. Use createWebCall instead.');
    }
 
    sendAudioData(sessionId: string, audioDataObject: any): void {
      throw new Error('RetellAIProvider does not support WebSocket audio streaming. Audio is handled by Retell Web SDK.');
    }
 
    linkFrontendSocket(sessionId: string, frontendWs: any): void {
      throw new Error('RetellAIProvider does not use WebSocket connections. Use RetellWebClient instead.');
    }
 
    unlinkFrontendSocket(sessionId: string): void {
      throw new Error('RetellAIProvider does not use WebSocket connections.');
    }
 
    handleMessage(sessionId: string, data: Buffer): void {
      throw new Error('RetellAIProvider does not handle WebSocket messages. Events are handled by RetellWebClient.');
    }
 
    getSession(sessionId: string): WebSocket | null {
      throw new Error('RetellAIProvider does not maintain WebSocket sessions.');
    }
 
    async endSession(sessionId: string): Promise<void> {
      // For Retell AI, endCall is the appropriate method
      return this.endCall(sessionId);
    }

    getSessionTokenUsage(sessionId: string): any {
      // RetellAI doesn't provide detailed token usage metrics
      return {
        message: 'Token usage tracking not available for RetellAI provider',
        estimatedCost: 0,
        lastUpdated: new Date().toISOString()
      };
    }
 }

export default RetellAIProvider;
