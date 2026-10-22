import type { IConversationSource } from '../models/Conversation.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { ConversationManager } from './conversation-manager.js';
import { getRAGRetriever, getLLMGateway, getIntentClassifier } from './index.js';
import {
  BOSS_AGENT_SYSTEM_PROMPT,
  EMPTY_ANSWER_FALLBACK,
  buildRagContextPrompt,
} from './prompts.js';
import { env } from '../config/env.js';
import { routeQuery } from './query-router.js';
import {
  executeQuery,
  formatStructuredResult,
  loadCatalogSafely,
  type CatalogService,
} from './structured-retriever.js';
import type { ChatMessage } from './types.js';

export interface ChatResult {
  conversationId: string;
  sources: IConversationSource[];
  /** Which retrieval branch produced the context (evaluation diagnostics). */
  retrieval?: RetrievalDiagnostics;
}

/** The retrieval strategies: today's vector search, the structured branch, or both. */
export type RetrievalMode = 'vector' | 'structured' | 'auto';

export interface RetrievalDiagnostics {
  mode: RetrievalMode;
  /** Which branch produced the context. */
  route: 'none' | 'vector' | 'structured' | 'fallback';
  /** The router's decision, when the router ran. */
  routerKind?: 'lookup' | 'structured' | 'invalid';
  /** Why the structured branch was not used. */
  fallbackReason?: string;
  /** The structured query that was executed. */
  query?: unknown;
  /** True when the structured query matched no service. */
  emptyResult?: boolean;
}

export interface ChatOptions {
  // When false, skip intent classification + retrieval entirely. Used by the
  // evaluation harness to produce a Cold-LLM baseline (same model, same prompt
  // scaffold, no retrieved context).
  useRag?: boolean;
  // Where to place the freshly retrieved RAG context in the prompt:
  //   'pre-user' (default) — inject as a system message immediately before
  //                          the most recent user turn so the LLM cannot
  //                          anchor on earlier turns' (possibly stale) context.
  //   'static'             — inject only as a top-level system message after
  //                          the boss-agent prompt; reproduces the pre-fix
  //                          behaviour used as the ablation baseline.
  injectionScheme?: 'pre-user' | 'static';
  // Retrieval strategy for this request. Defaults to RAG_RETRIEVAL_MODE
  // ('vector' — today's behaviour). Evaluation servers may override it per
  // request (gated by AGENT_EVAL_OPTIONS in the route).
  retrievalMode?: RetrievalMode;
}

/** Sources for a structured hit: the query matched it exactly. */
function structuredSources(services: CatalogService[]): IConversationSource[] {
  return services.map((service) => ({
    serviceId: service.id,
    shortName: service.shortName,
    title: service.title,
    score: 1,
  }));
}

export class AgentService {
  constructor(private readonly conversationManager: ConversationManager) {}

  async chat(
    userId: string,
    message: string,
    conversationId?: string,
    onToken?: (token: string) => void,
    options: ChatOptions = {}
  ): Promise<ChatResult> {
    const useRag = options.useRag !== false;
    const injectionScheme = options.injectionScheme ?? 'pre-user';
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new AppError('Message cannot be empty', 400);
    }

    let activeConversationId = conversationId;
    if (!activeConversationId) {
      activeConversationId = await this.conversationManager.create(userId);
    }

    const conversation = await this.conversationManager.getHistory(activeConversationId, userId);
    if (!conversation) {
      throw new AppError('Conversation not found', 404);
    }

    await this.conversationManager.addMessage(activeConversationId, {
      role: 'user',
      content: trimmedMessage,
    });
    await this.conversationManager.ensureTitleFromFirstUserMessage(activeConversationId);

    const retriever = getRAGRetriever();
    let retrieved: Awaited<ReturnType<typeof retriever.retrieveSimilar>> = [];
    let sources: IConversationSource[] = [];
    let ragContext = '';
    const diagnostics: RetrievalDiagnostics = {
      mode: options.retrievalMode ?? env.RAG_RETRIEVAL_MODE,
      route: 'none',
    };
    if (useRag) {
      try {
        const isServiceQuery = await getIntentClassifier().isServiceQuery(trimmedMessage);
        if (isServiceQuery) {
          if (diagnostics.mode === 'vector') {
            retrieved = await retriever.retrieveSimilar(trimmedMessage, 4);
            diagnostics.route = 'vector';
          } else {
            const structured = await this.retrieveStructured(trimmedMessage, diagnostics);
            if (structured) {
              ragContext = structured.context;
              sources = structured.sources;
              diagnostics.route = 'structured';
            } else {
              // Fallback: invalid query, execution error or an empty result —
              // the vector branch answers instead (logged for the evaluation).
              retrieved = await retriever.retrieveSimilar(trimmedMessage, 4);
              diagnostics.route = 'fallback';
            }
          }
        }
      } catch (error) {
        logger.warn('RAG retrieval failed; continuing with chat-only mode', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!ragContext) {
      ragContext = retriever.formatContextForPrompt(retrieved);
    }
    if (sources.length === 0) {
      sources = retrieved.map((item) => ({
        serviceId: item.serviceId,
        shortName: item.shortName,
        title: item.title,
        score: item.score,
      }));
    }

    const historyAfterUserMessage = await this.conversationManager.getHistory(
      activeConversationId,
      userId
    );
    if (!historyAfterUserMessage) {
      throw new AppError('Conversation not found', 404);
    }

    const historyMessages = historyAfterUserMessage.messages
      .filter((item) => item.role === 'user' || item.role === 'assistant')
      .map((item) => ({
        role: item.role,
        content: item.content,
      }));

    // Find the last user message index so we can inject fresh RAG context
    // right before it — this prevents the LLM from trusting stale context
    // from earlier turns.
    let lastUserIndex = -1;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      if (historyMessages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }

    let llmMessages: ChatMessage[];
    if (injectionScheme === 'static' || lastUserIndex <= 0) {
      // Static placement: the freshly retrieved context is appended as a
      // top-level system message after the boss-agent system prompt. This is
      // also the only sensible placement when the conversation contains a
      // single user turn (lastUserIndex <= 0).
      llmMessages = [
        { role: 'system', content: BOSS_AGENT_SYSTEM_PROMPT },
        { role: 'system', content: buildRagContextPrompt(ragContext) },
        ...historyMessages,
      ];
    } else {
      // Pre-user placement (default): splice the context immediately before
      // the most recent user message so the LLM cannot anchor on stale
      // context from earlier turns.
      historyMessages.splice(lastUserIndex, 0, {
        role: 'system',
        content: buildRagContextPrompt(ragContext),
      });
      llmMessages = [{ role: 'system', content: BOSS_AGENT_SYSTEM_PROMPT }, ...historyMessages];
    }

    let response = await getLLMGateway().chat(llmMessages, onToken);
    if (!response.trim()) {
      logger.warn('LLM returned an empty answer; sending fallback message', {
        conversationId: activeConversationId,
      });
      response = EMPTY_ANSWER_FALLBACK;
      onToken?.(response);
    }
    await this.conversationManager.addMessage(activeConversationId, {
      role: 'assistant',
      content: response,
      sources,
    });

    return { conversationId: activeConversationId, sources, retrieval: diagnostics };
  }

  /**
   * Run the structured branch: route the question, execute the query over the
   * catalog and format the result for the prompt.
   *
   * Returns null when the structured branch cannot answer — the caller then
   * falls back to the vector branch. The reason is recorded in `diagnostics`.
   */
  private async retrieveStructured(
    message: string,
    diagnostics: RetrievalDiagnostics
  ): Promise<{ context: string; sources: IConversationSource[] } | null> {
    const catalog = await loadCatalogSafely();
    if (!catalog) {
      diagnostics.fallbackReason = 'the catalog could not be loaded';
      return null;
    }

    const outcome = await routeQuery(message, catalog, {
      forceStructured: diagnostics.mode === 'structured',
    });

    if (outcome.kind === 'lookup') {
      diagnostics.routerKind = 'lookup';
      return null;
    }
    if (outcome.kind === 'invalid' || !outcome.query) {
      diagnostics.routerKind = 'invalid';
      diagnostics.fallbackReason = outcome.reason ?? 'the query could not be built';
      return null;
    }

    diagnostics.routerKind = 'structured';
    diagnostics.query = outcome.query;

    const result = executeQuery(outcome.query, catalog.services, catalog.scenarios);
    const aggregate = outcome.query.aggregate?.op ?? 'list';

    if (result.matchCount === 0) {
      diagnostics.emptyResult = true;
      // A list or count over an empty set has a well-defined answer ("none"
      // / 0); a min/max does not, so that case falls back to the vector branch.
      if (aggregate === 'min' || aggregate === 'max') {
        diagnostics.fallbackReason = 'the query matched no service';
        return null;
      }
    }

    return {
      context: formatStructuredResult(result, outcome.query),
      sources: structuredSources(result.services),
    };
  }
}
