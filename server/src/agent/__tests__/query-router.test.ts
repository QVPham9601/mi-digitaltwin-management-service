import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { routeQuery, resolveQuery, type ChatJsonFn } from '../query-router.js';
import type { Catalog, CatalogService } from '../structured-retriever.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function service(shortName: string, overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    id: `id-${shortName}`,
    title: `${shortName} title`,
    provider: 'Montimage (MTI)',
    category: 'Monitor',
    sector: null,
    type: 'Software',
    uiType: 'web',
    trlCurrent: 7,
    trlExpected: 8,
    potentialUseCases: [],
    repositoryTable: 'INTACT_TOOLBOX',
    standards: [],
    license: 'TBD',
    description: null,
    ...overrides,
  };
}

const CATALOG: Catalog = {
  services: [
    service('SECANOD'),
    service('SECSAC', { provider: 'Tecnalia (TEC)', category: 'Dev Services', trlCurrent: 3 }),
    service('KAFKA', {
      provider: 'Apache Software Foundation',
      category: 'Ops Services',
      license: 'Apache-2.0',
      repositoryTable: 'OTHER_SERVICES',
    }),
    service('PCIE-CENTER', {
      category: 'National Institute of Standards and Technology (NIST)-provided resources',
      provider: 'CERTH',
      trlExpected: null,
    }),
  ],
  scenarios: [
    { title: 'DDoS attack', description: null, serviceShortNames: [], aliases: [] },
    {
      title: 'CI attack → MMT detection → AI4SOAR block',
      description: null,
      serviceShortNames: ['MAG', 'CI-SIM', 'SECANOD', 'KAFKA', 'AI4SOAR'],
      aliases: ['Montimage attack→detect→respond'],
    },
  ],
  loadedAt: Date.now(),
};

/** A chatJson stub that returns a canned output and can be told to throw. */
function stubChatJson(output: unknown, error?: Error): ChatJsonFn {
  return async () => {
    if (error) {
      throw error;
    }
    return output as never;
  };
}

let consoleWarn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  consoleWarn.mockRestore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('routeQuery', () => {
  it('accepts exact equality on a numeric field ("a TRL of 4")', async () => {
    const outcome = await routeQuery('Which Tecnalia services have a TRL of 4?', CATALOG, {
      chatJson: stubChatJson({
        kind: 'structured',
        where: [{ field: 'trl.current', op: 'eq', value: '4' }],
        aggregate: { op: 'list' },
      }),
    });

    expect(outcome.kind).toBe('structured');
    expect(outcome.query?.where).toEqual([{ field: 'trl.current', op: 'eq', value: 4 }]);
  });

  it('returns a structured outcome with resolved values', async () => {
    const outcome = await routeQuery('Which Tecnalia services have a low TRL?', CATALOG, {
      chatJson: stubChatJson({
        kind: 'structured',
        where: [{ field: 'provider', op: 'eq', value: 'Tecnalia' }],
        aggregate: { op: 'list' },
      }),
    });

    expect(outcome.kind).toBe('structured');
    expect(outcome.query?.where).toEqual([
      { field: 'provider', op: 'eq', value: 'Tecnalia (TEC)' },
    ]);
  });

  it('resolves an informal scenario name to the real title', async () => {
    const outcome = await routeQuery('Which services run in the demo scenario?', CATALOG, {
      chatJson: stubChatJson({
        kind: 'structured',
        where: [],
        scenario: 'attack-detect-respond',
      }),
    });

    expect(outcome.kind).toBe('structured');
    expect(outcome.query?.scenario).toBe('CI attack → MMT detection → AI4SOAR block');
  });

  it('records an unmapped vocabulary value as an invalid route', async () => {
    const outcome = await routeQuery('Which ACME services exist?', CATALOG, {
      chatJson: stubChatJson({
        kind: 'structured',
        where: [{ field: 'provider', op: 'eq', value: 'ACME Corp' }],
        aggregate: { op: 'list' },
      }),
    });

    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toMatch(/vocabulary for provider/);
  });

  it('rejects min/max without a numeric field', async () => {
    const outcome = await routeQuery('What is the lowest TRL?', CATALOG, {
      chatJson: stubChatJson({
        kind: 'structured',
        where: [],
        aggregate: { op: 'min', field: 'provider' },
      }),
    });

    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toMatch(/numeric field/);
  });

  it('rejects a comparison operator on a non-numeric field', async () => {
    const outcome = await routeQuery('Which providers are below the limit?', CATALOG, {
      chatJson: stubChatJson({
        kind: 'structured',
        where: [{ field: 'provider', op: 'lt', value: 4 }],
        aggregate: { op: 'list' },
      }),
    });

    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toMatch(/only valid on a numeric field/);
  });

  it('returns a lookup outcome for a factual question', async () => {
    const outcome = await routeQuery('Who provides SECSAC?', CATALOG, {
      chatJson: stubChatJson({ kind: 'lookup', service: 'SECSAC', where: [] }),
    });

    expect(outcome.kind).toBe('lookup');
    expect(outcome.query).toBeUndefined();
    expect(outcome.service).toBe('SECSAC');
  });

  it('forces the structured branch when asked', async () => {
    const outcome = await routeQuery('Who provides SECSAC?', CATALOG, {
      forceStructured: true,
      chatJson: stubChatJson({
        kind: 'structured',
        where: [{ field: 'shortName', op: 'eq', value: 'SECSAC' }],
        aggregate: { op: 'list' },
      }),
    });

    expect(outcome.kind).toBe('structured');
    expect(outcome.query?.where[0]).toEqual({ field: 'shortName', op: 'eq', value: 'SECSAC' });
  });

  it('survives a schema-violating output', async () => {
    const outcome = await routeQuery('Which services exist?', CATALOG, {
      chatJson: stubChatJson({ kind: 'maybe', where: [] }),
    });

    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toMatch(/invalid router output/);
  });

  it('falls back with a reason when the router call throws', async () => {
    const outcome = await routeQuery('Which services exist?', CATALOG, {
      chatJson: stubChatJson(undefined, new Error('model overloaded')),
    });

    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toMatch(/router call failed: model overloaded/);
  });

  it('resolves whereAny groups', async () => {
    const outcome = await routeQuery('Which tools are not software-only web tools?', CATALOG, {
      chatJson: stubChatJson({
        kind: 'structured',
        where: [],
        whereAny: [
          [{ field: 'type', op: 'ne', value: 'Software' }],
          [{ field: 'uiType', op: 'ne', value: 'web' }],
        ],
      }),
    });

    expect(outcome.kind).toBe('structured');
    expect(outcome.query?.whereAny).toHaveLength(2);
  });
});

describe('resolveQuery', () => {
  it('turns a scenario title used as a use case into a scenario filter', () => {
    const resolved = resolveQuery(
      {
        kind: 'structured',
        where: [
          {
            field: 'potentialUseCases',
            op: 'contains',
            value: 'CI attack → MMT detection → AI4SOAR block',
            not: true,
          },
        ],
      },
      CATALOG
    );
    expect(resolved.ok && resolved.query.notInScenario).toBe(
      'CI attack → MMT detection → AI4SOAR block'
    );
  });

  it('turns a scenario named as a use case into a scenario filter', () => {
    const resolved = resolveQuery(
      {
        kind: 'structured',
        where: [
          {
            field: 'potentialUseCases',
            op: 'contains',
            value: 'Montimage attack→detect→respond scenario',
          },
        ],
      },
      CATALOG
    );
    expect(resolved.ok && resolved.query.scenario).toBe(
      'CI attack → MMT detection → AI4SOAR block'
    );
    expect(resolved.ok && resolved.query.where).toEqual([]);
  });

  it('throws no error on an empty structured output', () => {
    const resolved = resolveQuery({ kind: 'structured', where: [] }, CATALOG);
    expect(resolved.ok).toBe(true);
  });

  it('resolves a numeric string to a number', () => {
    const resolved = resolveQuery(
      {
        kind: 'structured',
        where: [{ field: 'trl.current', op: 'gte', value: '6' }],
        aggregate: { op: 'list' },
      },
      CATALOG
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.query.where[0]?.value).toBe(6);
    }
  });
});

describe('resolveQuery: list sizes and ranking', () => {
  it('accepts a size operator on a list field with a whole number', () => {
    const resolved = resolveQuery(
      { kind: 'structured', where: [{ field: 'standards', op: 'sizeGte', value: '2' }] },
      CATALOG
    );
    expect(resolved.ok && resolved.query.where[0]).toEqual({
      field: 'standards',
      op: 'sizeGte',
      value: 2,
    });
  });

  it('rejects a size operator on a scalar field', () => {
    const resolved = resolveQuery(
      { kind: 'structured', where: [{ field: 'provider', op: 'sizeGte', value: 2 }] },
      CATALOG
    );
    expect(resolved.ok).toBe(false);
  });

  it('accepts rank on a list or numeric field and rejects it on a string field', () => {
    const ok = (field: string) =>
      resolveQuery(
        { kind: 'structured', where: [], aggregate: { op: 'rank', field } } as never,
        CATALOG
      ).ok;
    expect(ok('standards')).toBe(true);
    expect(ok('trl.current')).toBe(true);
    expect(ok('provider')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State route: the twin's run state questions (M1 live state)
// ---------------------------------------------------------------------------

import { stateVocabularySection, type StateQuery } from '../query-router.js';
import type { TwinState } from '../state-retriever.js';

const DEMO = 'CI attack → MMT detection → AI4SOAR block';

function twinState(): TwinState {
  return {
    readAt: '2026-11-09T12:00:00Z',
    runs: [
      {
        scenario: DEMO,
        runId: 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a1',
        runNumber: 1,
        executedAt: '2026-10-05T09:48:00.000Z',
        executedBy: 'grad-student',
        status: 'completed',
        outcome: 'passed',
        completedAt: '2026-10-05T10:02:00.000Z',
        durationMs: 840_000,
        ageMs: Number.MAX_SAFE_INTEGER,
        alertsTotal: 5,
        uniqueAttackers: 1,
        attackers: ['10.244.0.7'],
        errorLines: 0,
        warnings: 1,
        restarts: 0,
        hasReport: true,
        partial: false,
        suspectStale: false,
      },
      {
        scenario: DEMO,
        runId: 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a2',
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
    runServices: [
      {
        scenario: DEMO,
        runId: 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a1',
        runNumber: 1,
        service: 'SECANOD',
        status: 'completed',
        up: true,
        availability: 1,
        errorRate: 0,
        requestRate: 3,
        latencyP95Ms: 90,
      },
      {
        scenario: DEMO,
        runId: 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0',
        runNumber: 2,
        service: 'CI-SIM',
        status: 'completed',
        up: false,
        availability: 0.42,
        errorRate: 0.5,
        requestRate: 8,
        latencyP95Ms: 250,
      },
    ],
  };
}

describe('routeQuery: state kind', () => {
  it('resolves a state query and an informal scenario name', async () => {
    const outcome = await routeQuery(
      'What happened in the last run of Montimage attack→detect→respond?',
      CATALOG,
      {
        twinState: twinState(),
        chatJson: stubChatJson({
          kind: 'state',
          state: {
            scenario: 'Montimage attack→detect→respond',
            select: 'latest',
            where: [],
            whereAny: [],
          },
        }),
      }
    );
    expect(outcome.kind).toBe('state');
    const query = outcome.query as StateQuery;
    expect(query.scenario).toBe(DEMO);
    expect(query.select).toBe('latest');
  });

  it('resolves state vocabulary values (status, attacker, boolean)', async () => {
    const outcome = await routeQuery('Which runs saw the 10.244.0.7 attacker?', CATALOG, {
      twinState: twinState(),
      chatJson: stubChatJson({
        kind: 'state',
        state: {
          where: [{ field: 'status', op: 'eq', value: 'completed' }],
          whereAny: [],
        },
      }),
    });
    expect(outcome.kind).toBe('state');
    const query = outcome.query as StateQuery;
    expect(query.where).toEqual([{ field: 'status', op: 'eq', value: 'completed' }]);
  });

  it('records the run-state vocabulary in the router prompt', async () => {
    let messages: unknown;
    await routeQuery('Is anything running right now?', CATALOG, {
      twinState: twinState(),
      chatJson: async (called) => {
        messages = called;
        return { kind: 'lookup', where: [] } as never;
      },
    });
    const system = (messages as Array<{ role: string; content: string }>).find(
      (message) => message.role === 'system'
    )?.content;
    expect(system).toContain('Run-state mapping rules');
    expect(system).toContain(statusVocab(twinState()));
  });

  function statusVocab(state: TwinState): string {
    return stateVocabularySection(state).split('\n')[0];
  }

  it('rejects an unknown run status', async () => {
    const outcome = await routeQuery('Which runs are stopped?', CATALOG, {
      twinState: twinState(),
      chatJson: stubChatJson({
        kind: 'state',
        state: {
          where: [{ field: 'status', op: 'eq', value: 'stopped' }],
          whereAny: [],
        },
      }),
    });
    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toContain('not a known status');
  });

  it('rejects an unknown state field', async () => {
    const outcome = await routeQuery('Which runs used banana mode?', CATALOG, {
      twinState: twinState(),
      chatJson: stubChatJson({
        kind: 'state',
        state: {
          where: [{ field: 'banana', op: 'eq', value: 'yes' }],
          whereAny: [],
        },
      }),
    });
    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toContain('banana');
  });

  it('rejects a state answer when the caller passed no twin state', async () => {
    const outcome = await routeQuery('What was the outcome of the last run?', CATALOG, {
      chatJson: stubChatJson({
        kind: 'state',
        state: { where: [], whereAny: [] },
      }),
    });
    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toContain('run state');
  });

  it('corrects the table to runServices when a service-only field is referenced', async () => {
    const outcome = await routeQuery('Was CI-SIM up in the failed demo run?', CATALOG, {
      twinState: twinState(),
      chatJson: stubChatJson({
        kind: 'state',
        state: {
          where: [
            { field: 'service', op: 'eq', value: 'CI-SIM' },
            { field: 'up', op: 'eq', value: 'false' },
          ],
          whereAny: [],
        },
      }),
    });
    expect(outcome.kind).toBe('state');
    const query = outcome.query as StateQuery;
    expect(query.table).toBe('runServices');
    expect(query.where.map((p) => p.field)).toEqual(['service', 'up']);
  });

  it('rejects min/max on a non-numeric state field', async () => {
    const outcome = await routeQuery('What scenario ran fastest?', CATALOG, {
      twinState: twinState(),
      chatJson: stubChatJson({
        kind: 'state',
        state: {
          aggregate: { op: 'max', field: 'service' },
          where: [],
          whereAny: [],
        },
        where: [],
      }),
    });
    expect(outcome.kind).toBe('invalid');
    expect(outcome.reason).toContain('numeric run-state field');
  });
});
