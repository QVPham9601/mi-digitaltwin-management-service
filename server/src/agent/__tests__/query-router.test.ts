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
    { title: 'DDoS attack', serviceShortNames: [] },
    {
      title: 'CI attack → MMT detection → AI4SOAR block',
      serviceShortNames: ['MAG', 'CI-SIM', 'SECANOD', 'KAFKA', 'AI4SOAR'],
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
