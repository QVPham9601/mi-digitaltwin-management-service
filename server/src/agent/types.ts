export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AgentConfig {
  // 'ollama' uses the local Ollama chat model; 'openai' uses an
  // OpenAI-compatible endpoint (e.g. OpenRouter) for chat generation only.
  chatProvider: 'ollama' | 'openai' | 'anthropic';
  ollamaBaseUrl: string;
  // Base URL for the OpenAI-compatible chat endpoint (chatProvider === 'openai').
  chatBaseUrl: string;
  chatApiKey: string;
  // Send enable_thinking=false to OpenAI-compatible Qwen3 servers.
  chatDisableThinking: boolean;
  // Claude API (chatProvider === 'anthropic'): key, thinking effort, and
  // whether a declined request may be re-run on another Claude model.
  anthropicApiKey: string;
  chatEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  anthropicFallback: boolean;
  chatModel: string;
  embedModel: string;
  numPredict: number;
  numCtx: number;
  temperature: number;
  vectorDbType: 'mongodb' | 'qdrant';
}

export type SSEEventType = 'metadata' | 'token' | 'sources' | 'done' | 'error';

export interface SSEEvent<T = unknown> {
  type: SSEEventType;
  data: T;
}

export interface GatewayHealthStatus {
  status: 'healthy' | 'degraded' | 'offline';
  ollamaReachable: boolean;
  chatModelAvailable: boolean;
  embedModelAvailable: boolean;
  availableModels: string[];
  error?: string;
}
