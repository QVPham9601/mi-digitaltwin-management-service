import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.fn();
const chatJson = vi.fn();
const isServiceQuery = vi.fn();
const retrieveSimilar = vi.fn();
const formatContextForPrompt = vi.fn();
vi.mock('../index.js', () => ({
  getLLMGateway: () => ({ chat, chatJson }),
  getIntentClassifier: () => ({ isServiceQuery }),
  getRAGRetriever: () => ({
    retrieveSimilar,
    formatContextForPrompt,
  }),
}));

// The catalog and the twin state are stubbed: chat() reads them live from
// MongoDB in auto mode, and these tests are pure module tests.
vi.mock('../structured-retriever.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../structured-retriever.js')>();
  return { ...actual, loadCatalogSafely: vi.fn() };
});
vi.mock('../state-retriever.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state-retriever.js')>();
  return { ...actual, loadTwinStateSafely: vi.fn() };
});

import { AgentService } from '../agent-service.js';
import type { Catalog } from '../structured-retriever.js';
import type { TwinState } from '../state-retriever.js';
import type { ConversationManager } from '../conversation-manager.js';

const DEMO = 'CI attack → MMT detection → AI4SOAR block';

const CATALOG: Catalog = {
  services: [],
  scenarios: [
    {
      title: DEMO,
      description: null,
      serviceShortNames: ['MAG', 'CI-SIM', 'SECANOD', 'KAFKA', 'AI4SOAR'],
      aliases: [],
    },
  ],
  loadedAt: Date.now(),
};

function twinState(): TwinState {
  const readAt = '2026-11-09T12:00:00Z';
  return {
    readAt,
    runs: [
      {
        scenario: DEMO,
        runId: 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a1',
        runNumber: 2,
        executedAt: '2026-11-09T11:00:00.000Z',
        executedBy: 'grad-student',
        status: 'running',
        outcome: null,
        completedAt: null,
        durationMs: null,
        ageMs: 3_600_000,
        alertsTotal: null,
        uniqueAttackers: null,
        attackers: [],
        errorLines: null,
        warnings: null,
        restarts: null,
        hasReport: false,
        partial: false,
        suspectStale: false,
      },
    ],
    runServices: [],
  };
}

function fakeConversationManager() {
  return {
    create: vi.fn(async () => 'conv-1'),
    getHistory: vi.fn(async () => ({ messages: [] })),
    addMessage: vi.fn(),
    ensureTitleFromFirstUserMessage: vi.fn(),
  } as unknown as ConversationManager;
}

beforeEach(() => {
  chat.mockReset().mockResolvedValue('It is running right now.');
  chatJson.mockReset();
  isServiceQuery.mockReset().mockResolvedValue(true);
  retrieveSimilar.mockReset().mockResolvedValue([]);
  formatContextForPrompt.mockReset();
});

describe('AgentService.chat: auto → state route', () => {
  it('answers a run-state question from a live twin-state read', async () => {
    const { loadCatalogSafely } = await import('../structured-retriever.js');
    const { loadTwinStateSafely, buildTwinState } = await import('../state-retriever.js');
    vi.mocked(loadCatalogSafely).mockResolvedValue(CATALOG);
    // Load the state through buildTwinState so the fixture stays realistic.
    vi.mocked(loadTwinStateSafely).mockResolvedValue(twinState());

    // The router answers { kind: 'state', ... } for this question.
    chatJson.mockResolvedValue({
      kind: 'state',
      state: { scenario: DEMO, select: 'latest', where: [], whereAny: [] },
    });

    const manager = fakeConversationManager();
    const result = await new AgentService(manager).chat(
      'user-1',
      'Is the demo scenario running right now?',
      undefined,
      undefined,
      {
        retrievalMode: 'auto',
      }
    );

    expect(result.retrieval).toMatchObject({
      mode: 'auto',
      route: 'state',
      routerKind: 'state',
    });
    expect(result.retrieval?.stateReadAt).toBe('2026-11-09T12:00:00Z');
    expect(result.retrieval?.stateRowCount).toBe(1);
    expect(result.retrieval?.suspectStaleCount).toBe(0);
    expect(result.retrieval?.stateMatchCount).toBe(1);
    expect((result.retrieval?.stateQuery as { select?: string }).select).toBe('latest');
    // State hits cite the run facts in the context, not catalog sources.
    expect(result.sources).toEqual([]);

    // The prompt context carries the live-read header and the run line.
    const prompt = chat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const context = prompt
      .filter((message) => message.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(context).toContain('Twin state read live at 2026-11-09T12:00:00Z.');
    expect(context).toContain(`run #2 of "${DEMO}"`);
    expect(context).toContain('status: running');
    void buildTwinState;
  });

  it('falls back to the vector branch when the state route is invalid', async () => {
    const { loadCatalogSafely } = await import('../structured-retriever.js');
    const { loadTwinStateSafely } = await import('../state-retriever.js');
    vi.mocked(loadCatalogSafely).mockResolvedValue(CATALOG);
    vi.mocked(loadTwinStateSafely).mockResolvedValue(twinState());

    chatJson.mockResolvedValue({
      kind: 'state',
      state: { where: [{ field: 'status', op: 'eq', value: 'crashed' }], whereAny: [] },
    });

    const manager = fakeConversationManager();
    const result = await new AgentService(manager).chat(
      'user-1',
      'Which runs crashed?',
      undefined,
      undefined,
      {
        retrievalMode: 'auto',
      }
    );

    expect(result.retrieval).toMatchObject({ route: 'fallback', routerKind: 'invalid' });
    expect(result.retrieval?.fallbackReason).toContain('crashed');
    expect(result.retrieval?.stateQuery).toBeUndefined();
  });
});
