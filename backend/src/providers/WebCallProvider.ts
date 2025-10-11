import { RealtimeConfig } from './BaseProvider.js';

interface WebCallConfig {
  sessionId: string;
  agentId: string;
  apiKey?: string;
}

interface WebCallResponse {
  call_id: string;
  access_token: string;
  agent_id: string;
}

interface WebCallProvider {
  createWebCall(config: WebCallConfig): Promise<WebCallResponse>;
  getFunctionTools(): any[];
  handleFunctionCall(sessionId: string, name: string, argumentsJson: string, frontendCallback?: (event: any) => void): void;
  endCall(sessionId: string): Promise<void>;
}

export type { WebCallProvider, WebCallConfig, WebCallResponse };