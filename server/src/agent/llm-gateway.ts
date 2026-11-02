import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import { logger } from '../utils/logger.js';
import type { AgentConfig, ChatMessage, GatewayHealthStatus } from './types.js';

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

function modelExists(requestedModel: string, availableModels: string[]): boolean {
  const requested = normalizeModelName(requestedModel);
  const requestedBase = requested.split(':')[0];

  return availableModels.some((modelName) => {
    const normalized = normalizeModelName(modelName);
    const normalizedBase = normalized.split(':')[0];
    return normalized === requested || normalizedBase === requestedBase;
  });
}

export class LLMGateway {
  private readonly client: Ollama;

  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new Ollama({ host: config.ollamaBaseUrl });
  }

  async chat(messages: ChatMessage[], onToken?: (token: string) => void): Promise<string> {
    const timeoutMs = 120_000;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      // Only the generator is swapped; retrieval + embeddings stay on Ollama.
      const generationPromise =
        this.config.chatProvider === 'openai'
          ? this.chatOpenAI(messages, onToken)
          : this.config.chatProvider === 'anthropic'
            ? this.chatAnthropic(messages, onToken)
            : this.chatOllama(messages, onToken);

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('LLM chat timed out after 120 seconds'));
        }, timeoutMs);
      });

      return await Promise.race([generationPromise, timeoutPromise]);
    } catch (error) {
      logger.error('LLMGateway chat request failed', {
        provider: this.config.chatProvider,
        model: this.config.chatModel,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /** Local Ollama chat generation (the default Boss Agent path). */
  private async chatOllama(
    messages: ChatMessage[],
    onToken?: (token: string) => void
  ): Promise<string> {
    const response = await this.client.chat({
      model: this.config.chatModel,
      messages,
      options: {
        num_predict: this.config.numPredict,
        num_ctx: this.config.numCtx,
        temperature: this.config.temperature,
      },
      stream: true,
    });

    let fullResponse = '';
    for await (const part of response) {
      const token = part.message?.content ?? '';
      if (!token) {
        continue;
      }
      fullResponse += token;
      onToken?.(token);
    }

    return fullResponse;
  }

  /**
   * OpenAI-compatible chat generation (OpenRouter or any /v1 endpoint), used to
   * compare the Boss Agent against hosted frontier models. Streams the response
   * so the SSE token flow to the client is identical to the Ollama path.
   *
   * Hosted free tiers are often overloaded (429/5xx) and the network can blip.
   * Failed requests are not billed/counted, so they are retried with
   * exponential backoff (2s, 4s, 8s, 16s) as long as no token was streamed.
   */
  private async chatOpenAI(
    messages: ChatMessage[],
    onToken?: (token: string) => void
  ): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      let retryReason: string;
      try {
        const response = await fetch(`${this.config.chatBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Local servers (e.g. vLLM) need no key; hosted ones do.
            ...(this.config.chatApiKey && { Authorization: `Bearer ${this.config.chatApiKey}` }),
            // Optional OpenRouter attribution headers (ignored by other providers).
            'HTTP-Referer': 'https://montimage.com',
            'X-Title': 'SecSim Boss Agent',
          },
          body: JSON.stringify({
            model: this.config.chatModel,
            messages: LLMGateway.leadingSystem(messages),
            temperature: this.config.temperature,
            max_tokens: this.config.numPredict,
            stream: true,
            ...this.thinkingOptions(),
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => '');
          const message =
            `OpenAI-compatible chat failed: ${response.status} ${response.statusText} ${detail}`.trim();
          if (!RETRYABLE_STATUS.has(response.status)) {
            throw new NonRetryableChatError(message);
          }
          retryReason = message;
        } else {
          return await readOpenAIStream(response.body, onToken);
        }
      } catch (error) {
        // Non-retryable HTTP status, or an error after tokens were streamed.
        if (error instanceof NonRetryableChatError || !isRetryable(error)) {
          throw error;
        }
        retryReason = error instanceof Error ? error.message : String(error);
      }

      if (attempt >= MAX_CHAT_ATTEMPTS) {
        throw new Error(`${retryReason} (gave up after ${attempt} attempts)`);
      }
      const delayMs = 2000 * 2 ** (attempt - 1);
      logger.warn('OpenAI-compatible chat failed, retrying', {
        model: this.config.chatModel,
        attempt,
        delayMs,
        reason: retryReason,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  /**
   * Some OpenAI-compatible routers (vLLM) require a single system message at
   * the start. Coalesce all system messages into one leading message and keep
   * the user/assistant turns in order. The Ollama path is unaffected.
   */
  private anthropic?: Anthropic;

  private anthropicClient(): Anthropic {
    // An empty key lets the SDK resolve credentials itself (env / `ant` profile).
    this.anthropic ??= new Anthropic(
      this.config.anthropicApiKey ? { apiKey: this.config.anthropicApiKey } : {}
    );
    return this.anthropic;
  }

  /**
   * Shared Claude request fields. System messages go to the top-level `system`
   * field. No temperature: current Claude models reject sampling parameters;
   * thinking is adaptive and its depth is set by `effort`. max_tokens leaves
   * room for thinking, which counts towards it.
   */
  private anthropicRequest(messages: ChatMessage[], model = this.config.chatModel) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    return {
      model,
      max_tokens: Math.max(this.config.numPredict, ANTHROPIC_MAX_TOKENS),
      ...(system && { system }),
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ...(this.config.anthropicFallback && {
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default' as const,
      }),
    };
  }

  /** Claude chat generation (official SDK), streamed token by token. */
  private async chatAnthropic(
    messages: ChatMessage[],
    onToken?: (token: string) => void
  ): Promise<string> {
    const stream = this.anthropicClient().beta.messages.stream({
      ...this.anthropicRequest(messages),
      output_config: { effort: this.config.chatEffort },
    });
    let fullResponse = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        onToken?.(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    recordUsage(final.model, final.usage);
    if (final.stop_reason === 'refusal') {
      logger.warn('Claude declined the request', { model: final.model });
    }
    // An empty answer reaches agent-service, which replaces it with a fallback message.
    return fullResponse;
  }

  private static leadingSystem(messages: ChatMessage[]): ChatMessage[] {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    return system ? [{ role: 'system', content: system }, ...rest] : rest;
  }

  /** vLLM/Qwen3 switch that turns reasoning off (ignored by other servers). */
  private thinkingOptions(force = this.config.chatDisableThinking) {
    return force ? { chat_template_kwargs: { enable_thinking: false } } : {};
  }

  /**
   * One non-streaming, deterministic call whose answer must be JSON matching
   * `schema` (structured outputs). Thinking is disabled: the Monitor needs a
   * fast, bounded answer, and the schema already constrains the format.
   */
  async chatJson<T>(
    messages: ChatMessage[],
    schema: object,
    model = this.config.chatModel
  ): Promise<T> {
    if (this.config.chatProvider === 'anthropic') {
      const response = await this.anthropicClient().beta.messages.create({
        ...this.anthropicRequest(messages, model),
        output_config: {
          effort: this.config.chatEffort,
          format: { type: 'json_schema', schema: schema as Record<string, unknown> },
        },
      });
      recordUsage(response.model, response.usage);
      if (response.stop_reason === 'refusal') {
        throw new Error('Claude declined the request (stop_reason: refusal)');
      }
      const text = response.content.find((block) => block.type === 'text');
      return JSON.parse(text && text.type === 'text' ? text.text : '') as T;
    }

    if (this.config.chatProvider === 'openai') {
      const response = await fetch(`${this.config.chatBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.chatApiKey && { Authorization: `Bearer ${this.config.chatApiKey}` }),
        },
        body: JSON.stringify({
          model,
          messages: LLMGateway.leadingSystem(messages),
          temperature: 0,
          max_tokens: this.config.numPredict,
          response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } },
          ...this.thinkingOptions(true),
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`OpenAI-compatible JSON chat failed: ${response.status} ${detail}`.trim());
      }
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      return JSON.parse(body.choices?.[0]?.message?.content ?? '') as T;
    }

    const response = await this.client.chat({
      model,
      messages,
      format: schema,
      think: false,
      stream: false,
      options: { num_predict: this.config.numPredict, num_ctx: this.config.numCtx, temperature: 0 },
    });
    return JSON.parse(response.message.content) as T;
  }

  /**
   * Generate an embedding vector for the given text.
   *
   * For asymmetric embedding models such as nomic-embed-text v1.5, callers
   * should pass an appropriate `task` so the model produces task-aligned
   * embeddings. Recognised values include `search_document` (for indexed
   * passages), `search_query` (for retrieval queries), `classification`,
   * and `clustering`. Models that ignore the prefix are unaffected.
   */
  async embed(text: string, task?: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Cannot embed empty text');
    }

    const input = task ? `${task}: ${trimmed}` : trimmed;

    try {
      const response = await this.client.embed({
        model: this.config.embedModel,
        input,
      });

      const vector = response.embeddings[0];
      if (!vector) {
        throw new Error('Embedding response did not contain vectors');
      }

      return vector;
    } catch (error) {
      logger.error('LLMGateway embedding request failed', {
        model: this.config.embedModel,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async healthCheck(): Promise<GatewayHealthStatus> {
    try {
      const modelList = await this.client.list();
      const availableModels = modelList.models.map((model) => model.name);

      // For the openai provider the chat model is remote (not in the local
      // Ollama list), so gate it on having credentials + a model id instead.
      const chatModelAvailable =
        this.config.chatProvider === 'openai'
          ? Boolean(this.config.chatModel)
          : this.config.chatProvider === 'anthropic'
            ? Boolean(
                this.config.chatModel &&
                (this.config.anthropicApiKey || process.env.ANTHROPIC_API_KEY)
              )
            : modelExists(this.config.chatModel, availableModels);
      const embedModelAvailable = modelExists(this.config.embedModel, availableModels);

      const status: GatewayHealthStatus['status'] =
        chatModelAvailable && embedModelAvailable
          ? 'healthy'
          : chatModelAvailable || embedModelAvailable
            ? 'degraded'
            : 'offline';

      return {
        status,
        ollamaReachable: true,
        chatModelAvailable,
        embedModelAvailable,
        availableModels,
        error:
          status === 'healthy'
            ? undefined
            : `Model availability issue. chat=${chatModelAvailable}, embed=${embedModelAvailable}`,
      };
    } catch (error) {
      logger.warn('LLMGateway health check failed', {
        host: this.config.ollamaBaseUrl,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        status: 'offline',
        ollamaReachable: false,
        chatModelAvailable: false,
        embedModelAvailable: false,
        availableModels: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_CHAT_ATTEMPTS = 5;

/** An upstream error reported before any token was streamed — safe to retry. */
class RetryableStreamError extends Error {}

/** A client-side HTTP error (e.g. 400/401/404) that retrying cannot fix. */
class NonRetryableChatError extends Error {}

/**
 * Retry stream errors raised before any token, and network-level fetch
 * failures (`TypeError: fetch failed`: DNS/TLS/connection reset).
 */
function isRetryable(error: unknown): boolean {
  return error instanceof RetryableStreamError || error instanceof TypeError;
}

/**
 * Parse an OpenAI-compatible SSE stream: `data:` lines carry JSON chunks,
 * terminated by `data: [DONE]`. Comment/keepalive lines are ignored. An error
 * chunk (e.g. provider overload after the HTTP 200) is surfaced as an error.
 */
async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  onToken?: (token: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data === '' || data === '[DONE]') {
        continue;
      }

      let parsed: {
        choices?: { delta?: { content?: string } }[];
        error?: { message?: string };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        // Ignore partial/keepalive frames; the next chunk completes them.
        continue;
      }

      if (parsed.error) {
        const message = `OpenAI-compatible stream error: ${parsed.error.message ?? 'unknown'}`;
        // Nothing streamed yet → the caller can safely retry.
        throw fullResponse === '' ? new RetryableStreamError(message) : new Error(message);
      }

      const token = parsed.choices?.[0]?.delta?.content ?? '';
      if (token) {
        fullResponse += token;
        onToken?.(token);
      }
    }
  }

  // An empty answer is returned as-is: agent-service replaces it with a
  // fallback message, the same way as for the Ollama path.
  return fullResponse;
}

const ANTHROPIC_MAX_TOKENS = 16000;

/** Token usage per model, accumulated over the process (evaluation budget guard). */
export interface ModelUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const usageTotals = new Map<string, ModelUsage>();

function recordUsage(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  }
): void {
  const total = usageTotals.get(model) ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  total.calls += 1;
  total.inputTokens += usage.input_tokens;
  total.outputTokens += usage.output_tokens;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  usageTotals.set(model, total);
}

/** Snapshot of the accumulated Claude usage, keyed by the model that answered. */
export function getModelUsage(): Record<string, ModelUsage> {
  return Object.fromEntries([...usageTotals].map(([model, usage]) => [model, { ...usage }]));
}
