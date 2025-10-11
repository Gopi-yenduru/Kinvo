import WebSocket from 'ws';

interface RealtimeConfig {
  sessionId: string;
  instructions: string;
  voice: string;
  temperature: number;
  maxResponseLength: number;
  model?: string;
  apiKey?: string;
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
}

export type { BaseProvider, RealtimeConfig };
