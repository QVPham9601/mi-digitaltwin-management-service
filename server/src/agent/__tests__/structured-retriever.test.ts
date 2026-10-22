import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildVocabulary,
  executeQuery,
  formatStructuredResult,
  resolveScenarioTitle,
  resolveVocabularyValue,
  type Catalog,
  type CatalogScenario,
  type CatalogService,
  type Predicate,
  type StructuredQuery,
} from '../structured-retriever.js';

// ---------------------------------------------------------------------------
// Fixtures — a miniature catalog with the same shape as the real one.
// ---------------------------------------------------------------------------

function makeService(overrides: Partial<CatalogService> & { shortName: string }): CatalogService {
  return {
    id: `id-${overrides.shortName}`,
    title: `${overrides.shortName} title`,
    provider: 'Montimage (MTI)',
    category: 'Ops Services',
    sector: null,
    type: 'Software',
    uiType: 'web',
    trlCurrent: 5,
    trlExpected: 7,
    potentialUseCases: [],
    repositoryTable: 'INTACT_TOOLBOX',
    standards: [],
    license: 'TBD',
    ...overrides,
  };
}

const SERVICES: CatalogService[] = [
  makeService({ shortName: 'SECANOD', category: 'Monitor', trlCurrent: 6, trlExpected: 8 }),
  makeService({ shortName: 'SECAISOAR', category: 'Ops Services', trlCurrent: 4, trlExpected: 6 }),
  makeService({ shortName: 'CI-SIM', category: 'Target', trlCurrent: 6, trlExpected: 8 }),
  makeService({ shortName: 'HTTP-SIM', category: 'Target', trlCurrent: 6, trlExpected: 8 }),
  makeService({
    shortName: 'MMT-PROBE',
    category: 'Monitor',
    trlCurrent: 7,
    trlExpected: 8,
    provider: 'Montimage (MTI)',
  }),
  makeService({
    shortName: 'MAG',
    category: 'Attack',
    trlCurrent: 6,
    trlExpected: 8,
    uiType: 'terminal',
    type: 'Software',
  }),
  makeService({
    shortName: 'KAFKA',
    category: 'Ops Services',
    provider: 'Apache Software Foundation',
    uiType: 'terminal',
    type: 'Software',
    trlCurrent: 9,
    trlExpected: 9,
    license: 'Apache-2.0',
    repositoryTable: 'OTHER_SERVICES',
  }),
  makeService({
    shortName: 'SECSAC',
    category: 'Dev Services',
    provider: 'Tecnalia (TEC)',
    trlCurrent: 3,
    trlExpected: 6,
    sector: 'Research',
  }),
  makeService({
    shortName: 'SECINTERP',
    category: 'Dev Services',
    provider: 'Tecnalia (TEC)',
    trlCurrent: 4,
    trlExpected: 6,
    sector: 'Research',
    standards: ['ISO/IEC 15408', 'EUCC'],
    potentialUseCases: ['UC1 - Telecom Software Development Life Cycle'],
  }),
  makeService({
    shortName: 'ORO-5GLAB',
    category: '5G Testbeds',
    provider: 'ORO (Orange Romania)',
    license: 'N/A (Partner Infrastructure)',
    repositoryTable: 'OTHER_SERVICES',
    type: 'Hardware',
    sector: 'Digital infrastructure',
    standards: ['3GPP'],
    potentialUseCases: [
      'UC1 - Telecom Software Development Life Cycle',
      'Cross-cutting infrastructure support',
    ],
  }),
  makeService({
    shortName: 'PPC-EMOB',
    category: 'E-Mobility & IIoT',
    provider: 'PPC',
    license: 'N/A (Partner Infrastructure)',
    repositoryTable: 'OTHER_SERVICES',
    type: 'Software',
    sector: 'Energy',
    potentialUseCases: ['UC5 - Smart Charging Stations'],
  }),
];

const SCENARIOS: CatalogScenario[] = [
  { title: 'DDoS attack', serviceShortNames: [] },
  {
    title: 'CI attack → MMT detection → AI4SOAR block',
    serviceShortNames: ['MAG', 'CI-SIM', 'SECANOD', 'KAFKA'],
  },
];

const CATALOG: Catalog = { services: SERVICES, scenarios: SCENARIOS, loadedAt: Date.now() };

function query(overrides: Partial<StructuredQuery> = {}): StructuredQuery {
  return { where: [], whereAny: [], ...overrides };
}

function names(result: { services: CatalogService[] }): string[] {
  return result.services.map((service) => service.shortName);
}

// ---------------------------------------------------------------------------

describe('structured query operators', () => {
  it('eq matches a single value', () => {
    const result = executeQuery(
      query({ where: [{ field: 'provider', op: 'eq', value: 'Montimage (MTI)' }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toContain('MMT-PROBE');
    expect(names(result)).not.toContain('SECSAC');
  });

  it('eq ignores case and surrounding spaces', () => {
    const result = executeQuery(
      query({ where: [{ field: 'provider', op: 'eq', value: '  tecnalia (tec) ' }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['SECINTERP', 'SECSAC']);
  });

  it('ne excludes a value', () => {
    const result = executeQuery(
      query({ where: [{ field: 'provider', op: 'ne', value: 'Montimage (MTI)' }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['KAFKA', 'ORO-5GLAB', 'PPC-EMOB', 'SECINTERP', 'SECSAC']);
  });

  it('in matches any value of the list', () => {
    const result = executeQuery(
      query({ where: [{ field: 'provider', op: 'in', value: ['Tecnalia (TEC)', 'PPC'] }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['PPC-EMOB', 'SECINTERP', 'SECSAC']);
  });

  it('contains matches an element of a list field', () => {
    const result = executeQuery(
      query({ where: [{ field: 'standards', op: 'contains', value: '3GPP' }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['ORO-5GLAB']);
  });

  it('contains matches a substring of a list element', () => {
    const result = executeQuery(
      query({
        where: [{ field: 'potentialUseCases', op: 'contains', value: 'UC1' }],
      }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['ORO-5GLAB', 'SECINTERP']);
  });

  it('supports the four numeric comparisons', () => {
    const below = executeQuery(
      query({ where: [{ field: 'trl.current', op: 'lt', value: 4 }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(below)).toEqual(['SECSAC']);

    const atMost = executeQuery(
      query({ where: [{ field: 'trl.current', op: 'lte', value: 4 }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(atMost)).toEqual(['SECAISOAR', 'SECINTERP', 'SECSAC']);

    const above = executeQuery(
      query({ where: [{ field: 'trl.current', op: 'gt', value: 8 }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(above)).toEqual(['KAFKA']);

    const atLeast = executeQuery(
      query({ where: [{ field: 'trl.current', op: 'gte', value: 9 }] }),
      SERVICES,
      SCENARIOS
    );
    expect(names(atLeast)).toEqual(['KAFKA']);
  });

  it('negates a predicate with not', () => {
    const result = executeQuery(
      query({
        where: [
          { field: 'provider', op: 'eq', value: 'Montimage (MTI)' },
          { field: 'category', op: 'eq', value: 'Ops Services', not: true },
        ],
      }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['CI-SIM', 'HTTP-SIM', 'MAG', 'MMT-PROBE', 'SECANOD']);
  });

  it('ANDs the predicates', () => {
    const result = executeQuery(
      query({
        where: [
          { field: 'category', op: 'eq', value: 'Dev Services' },
          { field: 'trl.current', op: 'eq', value: 4 },
        ],
      }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['SECINTERP']);
  });

  it('ORs the whereAny groups', () => {
    const result = executeQuery(
      query({
        whereAny: [
          [{ field: 'category', op: 'eq', value: 'Attack' }],
          [{ field: 'category', op: 'eq', value: 'Target' }],
        ],
      }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['CI-SIM', 'HTTP-SIM', 'MAG']);
  });
});

describe('aggregates', () => {
  it('counts the matching services', () => {
    const result = executeQuery(
      query({
        where: [{ field: 'provider', op: 'eq', value: 'Montimage (MTI)' }],
        aggregate: { op: 'count' },
      }),
      SERVICES,
      SCENARIOS
    );
    expect(result.value).toBe(6);
    expect(result.matchCount).toBe(6);
  });

  it('finds the minimum and the services holding it', () => {
    const result = executeQuery(
      query({
        where: [{ field: 'provider', op: 'eq', value: 'Tecnalia (TEC)' }],
        aggregate: { op: 'min', field: 'trl.current' },
      }),
      SERVICES,
      SCENARIOS
    );
    expect(result.value).toBe(3);
    expect(result.valueServices).toEqual(['SECSAC']);
  });

  it('finds the maximum', () => {
    const result = executeQuery(
      query({
        where: [{ field: 'category', op: 'eq', value: 'Dev Services' }],
        aggregate: { op: 'max', field: 'trl.current' },
      }),
      SERVICES,
      SCENARIOS
    );
    expect(result.value).toBe(4);
    expect(result.valueServices).toEqual(['SECINTERP']);
  });

  it('min/max over a single-service set works and over an empty filter is undefined', () => {
    const result = executeQuery(
      query({
        where: [{ field: 'category', op: 'eq', value: 'No such category' }],
        aggregate: { op: 'min', field: 'trl.current' },
      }),
      SERVICES,
      SCENARIOS
    );
    expect(result.value).toBeUndefined();
  });
});

describe('group-by', () => {
  it('groups by a scalar field', () => {
    const result = executeQuery(
      query({
        where: [{ field: 'category', op: 'eq', value: 'Dev Services' }],
        groupBy: 'provider',
        aggregate: { op: 'count' },
      }),
      SERVICES,
      SCENARIOS
    );
    expect(result.groups).toEqual([
      { key: 'Tecnalia (TEC)', services: ['SECINTERP', 'SECSAC'], count: 2 },
    ]);
    expect(result.topGroupKeys).toEqual(['Tecnalia (TEC)']);
    expect(result.topGroupCount).toBe(2);
  });

  it('groups by each element of a list field', () => {
    const result = executeQuery(
      query({
        where: [{ field: 'license', op: 'eq', value: 'N/A (Partner Infrastructure)' }],
        groupBy: 'potentialUseCases',
        aggregate: { op: 'list' },
      }),
      SERVICES,
      SCENARIOS
    );
    expect(result.groups?.map((group) => group.key)).toEqual([
      'Cross-cutting infrastructure support',
      'UC1 - Telecom Software Development Life Cycle',
      'UC5 - Smart Charging Stations',
    ]);
  });

  it('keeps only the group keys starting with the prefix', () => {
    const result = executeQuery(
      query({
        where: [{ field: 'license', op: 'eq', value: 'N/A (Partner Infrastructure)' }],
        groupBy: 'potentialUseCases',
        groupByPrefix: 'UC',
        aggregate: { op: 'list' },
      }),
      SERVICES,
      SCENARIOS
    );
    expect(result.groups?.map((group) => group.key)).toEqual([
      'UC1 - Telecom Software Development Life Cycle',
      'UC5 - Smart Charging Stations',
    ]);
  });
});

describe('scenario join', () => {
  it('restricts the query to the services of the scenario', () => {
    const result = executeQuery(
      query({ scenario: 'CI attack → MMT detection → AI4SOAR block' }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['CI-SIM', 'KAFKA', 'MAG', 'SECANOD']);
  });

  it('excludes the services of a scenario', () => {
    const result = executeQuery(
      query({
        notInScenario: 'CI attack → MMT detection → AI4SOAR block',
        where: [{ field: 'category', op: 'eq', value: 'Target' }],
      }),
      SERVICES,
      SCENARIOS
    );
    expect(names(result)).toEqual(['HTTP-SIM']);
  });

  it('resolves an informal scenario name', () => {
    const resolution = resolveScenarioTitle('the attack-detect-respond scenario', CATALOG);
    expect(resolution).toEqual({
      ok: true,
      title: 'CI attack → MMT detection → AI4SOAR block',
    });
  });

  it('rejects an unresolvable scenario name', () => {
    const resolution = resolveScenarioTitle('the flying saucer scenario', CATALOG);
    expect(resolution.ok).toBe(false);
  });
});

describe('vocabulary resolution', () => {
  const vocabulary = buildVocabulary(CATALOG);

  it('accepts an exact value', () => {
    expect(resolveVocabularyValue('provider', 'Montimage (MTI)', vocabulary)).toEqual({
      ok: true,
      value: 'Montimage (MTI)',
    });
  });

  it('resolves a partial value when it is unique', () => {
    expect(resolveVocabularyValue('provider', 'Montimage', vocabulary)).toEqual({
      ok: true,
      value: 'Montimage (MTI)',
    });
  });

  it('rejects a value outside the vocabulary', () => {
    const resolution = resolveVocabularyValue('category', 'Ops Services', vocabulary);
    // "Ops Services" is in the vocabulary of this fixture.
    expect(resolution.ok).toBe(true);

    const unknown = resolveVocabularyValue('provider', 'ACME Corp', vocabulary);
    expect(unknown.ok).toBe(false);
  });
});

describe('prompt formatting', () => {
  it('states the query, the result and the matching services', () => {
    const result = executeQuery(
      query({
        where: [
          { field: 'provider', op: 'eq', value: 'Montimage (MTI)' },
          { field: 'category', op: 'eq', value: 'Ops Services', not: true },
        ],
        aggregate: { op: 'list' },
      }),
      SERVICES,
      SCENARIOS
    );
    const text = formatStructuredResult(result, query({ where: [], aggregate: { op: 'list' } }));
    expect(text).toContain('Structured query:');
    expect(text).toContain('matching services');
    expect(text).toContain('CI-SIM');
  });

  it('formats the group counts and the largest group', () => {
    const q = query({
      where: [{ field: 'category', op: 'eq', value: 'Dev Services' }],
      groupBy: 'provider',
      aggregate: { op: 'count' },
    });
    const result = executeQuery(q, SERVICES, SCENARIOS);
    const text = formatStructuredResult(result, q);
    expect(text).toContain('Group with the most members: Tecnalia (TEC) (2)');
  });
});

describe('the executor agrees with the independent Python ground truth', () => {
  /**
   * The evaluation question set ships its ground truth computed by
   * `scripts/evaluation-dynamic-rag/ground_truth.py` (Python, independent of
   * this executor). Replaying it here keeps the two implementations honest.
   */
  const snapshotPath = fileURLToPath(
    new URL('../../../scripts/evaluation-dynamic-rag/catalog-snapshot.json', import.meta.url)
  );
  const questionsPath = fileURLToPath(
    new URL('../../../scripts/evaluation-dynamic-rag/questions-dynamic-rag.json', import.meta.url)
  );

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as {
    services: Array<Record<string, unknown>>;
    scenarios: Array<{ title: string; services: string[] }>;
  };
  const questions = JSON.parse(readFileSync(questionsPath, 'utf-8')) as Array<{
    id: string;
    category: string;
    expected: Record<string, unknown>;
    spec: Record<string, unknown>;
  }>;

  const PY_FIELD: Record<string, string> = {
    trlCurrent: 'trl.current',
    trlExpected: 'trl.expected',
  };

  function toPredicate(raw: unknown): Predicate {
    const [field, op, value, negate] = raw as [string, string, unknown, boolean?];
    return {
      field: (PY_FIELD[field] ?? field) as Predicate['field'],
      op: op as Predicate['op'],
      value: value as Predicate['value'],
      ...(negate ? { not: true } : {}),
    };
  }

  function toQuery(spec: Record<string, unknown>): StructuredQuery {
    const agg = String(spec.agg ?? 'list');
    const [aggOp, aggField] = agg.split(':');
    const group = spec.group as string | undefined;
    // 'or_not_web' (DR27) replaces the where clause entirely: the Python ground
    // truth lists a dummy NOT there that the executor must not apply on its own.
    const orNotWeb = Boolean(spec.or_not_web);
    const base: StructuredQuery = {
      where: orNotWeb ? [] : ((spec.where as unknown[]) ?? []).map(toPredicate),
      whereAny: orNotWeb
        ? [
            [{ field: 'type', op: 'ne', value: 'Software' }],
            [{ field: 'uiType', op: 'ne', value: 'web' }],
          ]
        : [],
      ...(spec.scenario ? { scenario: spec.scenario as string } : {}),
      ...(spec.notInScenario ? { notInScenario: spec.notInScenario as string } : {}),
      ...(group ? { groupBy: (PY_FIELD[group] ?? group) as StructuredQuery['groupBy'] } : {}),
      ...(spec.groupPrefix ? { groupByPrefix: spec.groupPrefix as string } : {}),
    };
    if (aggOp === 'argmaxCount' || aggOp === 'countPerGroup') {
      return { ...base, aggregate: { op: 'count' } };
    }
    if (aggOp === 'listPerGroup') {
      return { ...base, aggregate: { op: 'list' } };
    }
    if (aggOp === 'min' || aggOp === 'max') {
      return {
        ...base,
        aggregate: { op: aggOp, field: (PY_FIELD[aggField ?? ''] ?? aggField) as 'trl.current' },
      };
    }
    return { ...base, aggregate: { op: aggOp as 'list' } };
  }

  const snapshotServices: CatalogService[] = snapshot.services.map((service) => ({
    id: String(service.shortName),
    shortName: String(service.shortName),
    title: String(service.shortName),
    provider: String(service.provider),
    category: (service.category as string | null) ?? null,
    sector: (service.sector as string | null) ?? null,
    type: String(service.type),
    uiType: String(service.uiType),
    trlCurrent: (service.trlCurrent as number | null) ?? null,
    trlExpected: (service.trlExpected as number | null) ?? null,
    potentialUseCases: (service.potentialUseCases as string[]) ?? [],
    repositoryTable: String(service.repositoryTable),
    standards: (service.standards as string[]) ?? [],
    license: (service.license as string | null) ?? null,
  }));
  const snapshotScenarios: CatalogScenario[] = snapshot.scenarios.map((scenario) => ({
    title: scenario.title,
    serviceShortNames: scenario.services,
  }));

  it.each(
    questions
      .filter((question) => question.category !== 'lookup-control')
      .map((question) => [question.id, question] as const)
  )('%s matches the Python ground truth', (id, question) => {
    const q = toQuery(question.spec);
    const result = executeQuery(q, snapshotServices, snapshotScenarios);
    const expected = question.expected;

    if (expected.type === 'set') {
      expect(names(result)).toEqual(expected.value);
    } else if (expected.type === 'number') {
      expect(result.value).toBe(expected.value);
      expect(names(result)).toEqual(expected.services);
    } else if (expected.type === 'extremum') {
      expect(result.value).toBe(expected.value);
      expect(result.valueServices).toEqual(expected.services);
    } else if (expected.type === 'argmax') {
      expect(result.topGroupKeys).toEqual(expected.value);
      expect(result.topGroupCount).toBe(expected.count);
    } else if (expected.type === 'counts') {
      const counts = Object.fromEntries(
        (result.groups ?? []).map((group) => [group.key, group.count])
      );
      expect(counts).toEqual(expected.value);
    } else if (expected.type === 'groups') {
      const groups = Object.fromEntries(
        (result.groups ?? []).map((group) => [group.key, group.services])
      );
      expect(groups).toEqual(expected.value);
    } else {
      throw new Error(`unknown expected type for ${id}`);
    }
  });
});
