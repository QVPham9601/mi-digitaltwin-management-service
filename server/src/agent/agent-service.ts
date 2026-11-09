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
  formatRelaxations,
  formatStructuredResult,
  loadCatalogSafely,
  relaxEmptyQuery,
  type CatalogService,
  type Relaxation,
  type StructuredQuery,
} from './structured-retriever.js';
import {
  executeStateQuery,
  formatStateResult,
  loadTwinStateSafely,
  retrieveStaticRuns,
} from './state-retriever.js';
import type { ChatMessage } from './types.js';

export interface ChatResult {
  conversationId: string;
  sources: IConversationSource[];
  /** Which retrieval branch produced the context (evaluation diagnostics). */
  retrieval?: RetrievalDiagnostics;
}

/**
 * The retrieval strategies: today's vector search, the structured catalog
 * branch, their routed combination (auto), and the evaluation-only static
 * baseline `state-static` (top-k run summaries from the snapshot index, §4.4).
 */
export type RetrievalMode = 'vector' | 'structured' | 'auto' | 'state-static';

export interface RetrievalDiagnostics {
  mode: RetrievalMode;
  /** Which branch produced the context. */
  route: 'none' | 'vector' | 'structured' | 'state' | 'state-static' | 'fallback';
  /** The router's decision, when the router ran. */
  routerKind?: 'lookup' | 'structured' | 'state' | 'invalid';
  /** Why the structured branch was not used. */
  fallbackReason?: string;
  /** The structured query matched nothing and the prompt got its relaxations instead of "none". */
  relaxed?: boolean;
  /** The structured query that was executed. */
  query?: unknown;
  /** The state query that was executed (kind = state). */
  stateQuery?: unknown;
  /** Rows loaded in the twin-state tables (runs + run services + flat total). */
  stateRowCount?: number;
  /** Matching rows of the state query. */
  stateMatchCount?: number;
  /** How many loaded runs look stale. */
  suspectStaleCount?: number;
  /** When the twin state was read (state / state-static routes). */
  stateReadAt?: string;
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

/** Top-k run summaries retrieved from the static index. */
const TOP_STATIC_RUNS = 4;

/** Sources for a structured hit: the query matched it exactly. */
function structuredSources(services: CatalogService[]): IConversationSource[] {
  return services.map((service) => ({
    serviceId: service.id,
    shortName: service.shortName,
    title: service.title,
    score: 1,
  }));
}

// State hits have no catalog sources of their own: run facts are cited in the
// context itself (scenario, run number, execution id). The per-service health
// rows of the runs table are plain data, so `sources` stays empty on a state
// route and the answer leans on its own citation lines.

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
        // The static state baseline predates the router: it never routes and
        // never reads the live state (that is the point of the comparison).
        if (diagnostics.mode === 'state-static') {
          ragContext =
            (await this.retrieveStateStatic(trimmedMessage, diagnostics)) ??
            retriever.formatContextForPrompt(retrieved);
          if (diagnostics.stateReadAt) {
            diagnostics.route = 'state-static';
          }
        } else {
          const isServiceQuery = await getIntentClassifier().isServiceQuery(trimmedMessage);
          if (isServiceQuery) {
            if (diagnostics.mode === 'vector') {
              retrieved = await retriever.retrieveSimilar(trimmedMessage, 4);
              diagnostics.route = 'vector';
            } else {
              const structured = await this.retrieveStructuredAuto(trimmedMessage, diagnostics);
              if (structured) {
                ragContext = structured.context;
                sources = structured.sources;
                diagnostics.route = structured.route;
              } else {
                // Fallback: invalid query, execution error or an empty result —
                // the vector branch answers instead (logged for the evaluation).
                retrieved = await retriever.retrieveSimilar(trimmedMessage, 4);
                diagnostics.route = 'fallback';
              }
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
   * Run the routed structured/state branch: route the question, then execute
   * the catalog query (`structured`) or the run-state query (`state`) and
   * format the result for the prompt.
   *
   * Returns null when neither branch can answer — the caller then falls back
   * to the vector branch. The reason is recorded in `diagnostics`.
   */
  private async retrieveStructuredAuto(
    message: string,
    diagnostics: RetrievalDiagnostics
  ): Promise<{
    context: string;
    sources: IConversationSource[];
    route: 'structured' | 'state';
  } | null> {
    const catalog = await loadCatalogSafely();
    if (!catalog) {
      diagnostics.fallbackReason = 'the catalog could not be loaded';
      return null;
    }

    // One live read of the twin state per question; it gives the router its
    // run-state vocabulary and, on a state route, is the state that is
    // queried. (No cache: the answer must reflect the state at answer time.)
    const twinState =
      diagnostics.mode === 'auto' && diagnostics.routerKind !== 'invalid'
        ? await loadTwinStateSafely()
        : null;

    const outcome = await routeQuery(message, catalog, {
      forceStructured: diagnostics.mode === 'structured',
      ...(twinState ? { twinState } : {}),
    });

    if (outcome.kind === 'state' && outcome.query) {
      const state = twinState ?? (await loadTwinStateSafely());
      if (state) {
        diagnostics.routerKind = 'state';
        diagnostics.stateQuery = outcome.query;
        diagnostics.stateRowCount = state.runs.length + state.runServices.length;
        diagnostics.suspectStaleCount = state.runs.filter((run) => run.suspectStale).length;
        diagnostics.stateReadAt = state.readAt;
        const result = executeStateQuery(outcome.query, state);
        diagnostics.stateMatchCount = result.matchCount;
        return {
          context: formatStateResult(result, outcome.query, state),
          sources: [],
          route: 'state',
        };
      }
      diagnostics.routerKind = 'invalid';
      diagnostics.fallbackReason = 'the twin state could not be loaded';
      return null;
    }

    if (outcome.kind === 'lookup') {
      diagnostics.routerKind = 'lookup';
      return null;
    }
    if (outcome.kind === 'invalid' || !outcome.query) {
      diagnostics.routerKind = 'invalid';
      diagnostics.fallbackReason = outcome.reason ?? 'the query could not be built';
      return null;
    }

    const structuredQuery = outcome.query as StructuredQuery;
    diagnostics.routerKind = 'structured';
    diagnostics.query = structuredQuery;

    const result = executeQuery(structuredQuery, catalog.services, catalog.scenarios);
    const aggregate = structuredQuery.aggregate?.op ?? 'list';

    let relaxations: Relaxation[] = [];
    if (result.matchCount === 0) {
      diagnostics.emptyResult = true;
      // An empty result from several conditions is often an over-strict reading
      // of the question: show what each one-condition relaxation matches.
      relaxations = relaxEmptyQuery(structuredQuery, catalog.services, catalog.scenarios);
      diagnostics.relaxed = relaxations.length > 0;
      // A list or count over an empty set has a well-defined answer ("none"
      // / 0); a min/max does not, so that case falls back to the vector branch.
      if (!diagnostics.relaxed && (aggregate === 'min' || aggregate === 'max')) {
        diagnostics.fallbackReason = 'the query matched no service';
        return null;
      }
    }

    const context = formatStructuredResult(result, structuredQuery);
    return {
      context: diagnostics.relaxed ? `${context}\n\n${formatRelaxations(relaxations)}` : context,
      sources: structuredSources(result.services),
      route: 'structured',
    };
  }

  /**
   * The evaluation-only static baseline: the top-k run summaries from the
   * snapshot index (built once, §4.4), embedded-side similarity only — no
   * live read of MongoDB.
   */
  private async retrieveStateStatic(
    message: string,
    diagnostics: RetrievalDiagnostics
  ): Promise<string | null> {
    try {
      const { entries, builtAt } = await retrieveStaticRuns(
        message,
        getLLMGateway(),
        TOP_STATIC_RUNS
      );
      if (builtAt === null) {
        diagnostics.fallbackReason = 'the static run index has not been built yet';
        return null;
      }
      diagnostics.stateReadAt = builtAt;
      const lines = [
        `Twin state from the static index (built ${builtAt}) — NOT read live: the facts below were`,
        'indexed once and may be out of date. Say when the snapshot was built, and say you cannot',
        'know whether anything changed since.',
        '',
      ];
      if (entries.length === 0) {
        lines.push('No run summaries were retrieved from the static index.');
      } else {
        lines.push(
          ...entries.map(
            (entry, index) => `[${index + 1}] (score=${entry.score.toFixed(3)})\n${entry.summary}`
          )
        );
      }
      return lines.join('\n');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('Static state retrieval failed; falling back', { error: reason });
      diagnostics.fallbackReason = `the static run index could not be read: ${reason}`;
      return null;
    }
  }
}
