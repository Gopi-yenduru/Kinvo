import WebSocket from 'ws';

interface RealtimeConfig {
  sessionId: string;
  instructions: string;
  voice: string;
  temperature: number;
  maxResponseLength: number;
  model?: string;
  apiKey?: string;
  /** Patient-chosen language for the Sarvam pipeline: 'te-IN' | 'hi-IN' | 'en-IN'. */
  language?: string;
  /** Persistent patient record id (0/undefined for anonymous), to update across the visit. */
  patientId?: number;
  /** Returning-patient context so the agent runs a follow-up instead of re-asking the intake. */
  isReturning?: boolean;
  patientName?: string;       // known name of a returning patient (greet them, don't re-ask)
  patientHistory?: string;    // their rolling medical_summary from previous visit(s)
}

interface BaseProvider {
  createRealtimeSession(config: RealtimeConfig): Promise<WebSocket | null>;
  sendAudioData(sessionId: string, audioData: any): void;
  linkFrontendSocket(sessionId: string, frontendWs: any): void;
  unlinkFrontendSocket(sessionId: string): void;
  endSession(sessionId: string): Promise<void>;
  handleMessage(sessionId: string, data: Buffer): void;
  getFunctionTools(): any[];
  getSession(sessionId: string): WebSocket | null;
  getSessionTokenUsage(sessionId: string): any;
  /** Optional: user-initiated barge-in — abort the agent's current spoken turn. */
  interrupt?(sessionId: string): void;
}

export type { BaseProvider, RealtimeConfig };
