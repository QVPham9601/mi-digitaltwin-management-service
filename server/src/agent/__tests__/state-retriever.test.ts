import { describe, expect, it } from 'vitest';
import {
  ageInWords,
  buildTwinState,
  describeStateQuery,
  executeStateQuery,
  formatStateResult,
  runLabel,
  type RunRow,
  type RunServiceRow,
  type TwinState,
} from '../state-retriever.js';
import { env } from '../../config/env.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// AGENT_STALE_RUN_MS is 6 hours in the test environment, so a run just under
// the threshold is ~1h old and a run just over is ~7h old. A "fixed now" of
// 2026-11-09T12:00:00Z anchors both.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-09T12:00:00Z');

function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    scenario: 'CI attack → MMT detection → AI4SOAR block',
    runId: 'aaaaaaaa-death-4e4c-a0f0-0c0ffee0f1e2',
    runNumber: 1,
    executedAt: new Date('2026-11-09T06:00:00Z').toISOString(), // 6h old
    executedBy: 'operator-1',
    status: 'running',
    outcome: null,
    completedAt: null,
    durationMs: null,
    ageMs: 6 * 3_600_000,
    alertsTotal: null,
    uniqueAttackers: null,
    attackers: [],
    errorLines: null,
    warnings: null,
    restarts: null,
    hasReport: false,
    partial: false,
    suspectStale: false,
    ...overrides,
  };
}

const SCENARIO_TITLE = 'CI attack → MMT detection → AI4SOAR block';

/** Scenario + reports as they come out of the DB, for buildTwinState. */
function dbScenario(executions: unknown[]) {
  return {
    _id: 'scen-1',
    title: SCENARIO_TITLE,
    executions,
  };
}

const MINUTE = 60_000;

describe('buildTwinState: joins and suspectStale', () => {
  it('numbers runs by executedAt (1 = oldest) and joins the report', () => {
    const report = {
      scenarioId: 'scen-1',
      executionId: 'exec-2',
      outcome: 'partial',
      durationMs: 300_000,
      completedAt: new Date('2026-11-01T10:10:00Z'),
      services: [{ name: 'ci-sim', status: 'completed', containers: [{ status: 'completed' }] }],
      metrics: {
        containers: { restarts: 2 },
        logs: { errorLines: 5 },
        events: { warnings: 3 },
        alerts: { total: 12, uniqueAttackers: 2 },
      },
      alerts: [{ attacker: '10.244.0.7' }, { attacker: '10.244.0.9' }, { attacker: '10.244.0.7' }],
      traffic: [{ service: 'ci-sim', up: true, availability: 0.9, errorRate: 0.01 }],
      partial: true,
    };
    const state = buildTwinState(
      [
        dbScenario([
          // Newest first in storage — the loader must sort by executedAt.
          {
            _id: 'exec-2',
            executedAt: new Date('2026-11-01T10:00:00Z'),
            executedBy: 'operator-2',
            status: 'completed',
            completedAt: new Date('2026-11-01T10:10:00Z'),
            deployedServices: [{ name: 'ci-sim', status: 'completed' }],
          },
          {
            _id: 'exec-1',
            executedAt: new Date('2026-10-20T09:00:00Z'),
            executedBy: 'operator-1',
            status: 'completed',
            outcome: 'passed',
            deployedServices: [],
          },
        ]),
      ],
      [report],
      NOW
    );

    expect(state.runs).toHaveLength(2);
    const [first, second] = state.runs;
    expect(first.runNumber).toBe(1);
    expect(second.runNumber).toBe(2);
    // exec-2 has no outcome of its own → falls back to the report's 'partial'.
    expect(second).toMatchObject({
      outcome: 'partial',
      alertsTotal: 12,
      uniqueAttackers: 2,
      attackers: ['10.244.0.7', '10.244.0.9'],
      errorLines: 5,
      warnings: 3,
      restarts: 2,
      hasReport: true,
      partial: true,
    });
    expect(first.outcome).toBe('passed'); // the execution's own outcome
    expect(first.attackers).toEqual([]);
    // runServices rows joined by service name:
    expect(state.runServices).toEqual([
      {
        scenario: SCENARIO_TITLE,
        runId: 'exec-2',
        runNumber: 2,
        service: 'ci-sim',
        status: 'completed',
        up: true,
        availability: 0.9,
        errorRate: 0.01,
        requestRate: null,
        latencyP95Ms: null,
      },
    ]);
  });

  it('flags a pending/running run just over the staleness threshold and not one just under', () => {
    const scenario = dbScenario([
      {
        _id: 'exec-stale',
        executedAt: new Date(NOW.getTime() - 7 * 3_600_000), // 7h: over 6h
        executedBy: 'operator-1',
        status: 'running',
      },
      {
        _id: 'exec-fresh',
        executedAt: new Date(NOW.getTime() - 60 * MINUTE), // 1h: under 6h
        executedBy: 'operator-1',
        status: 'running',
      },
      {
        _id: 'exec-closed',
        executedAt: new Date(NOW.getTime() - 30 * 86_400_000), // long ago but completed
        executedBy: 'operator-1',
        status: 'completed',
        completedAt: new Date(NOW.getTime() - 29 * 86_400_000),
      },
    ]);
    const state = buildTwinState([scenario], [], NOW);

    expect(env.AGENT_STALE_RUN_MS).toBe(6 * 3_600_000);
    // Loader sorts by executedAt: closed (30d), stale (7h), fresh (1h).
    expect(state.runs.map((run) => run.runId)).toEqual(['exec-closed', 'exec-stale', 'exec-fresh']);
    expect(state.runs.map((run) => run.suspectStale)).toEqual([false, true, false]);
    // The stale run's age is exposed so the answer can say how old it is.
    expect(state.runs[1].ageMs).toBeGreaterThan(env.AGENT_STALE_RUN_MS);
  });
});

describe('executeStateQuery', () => {
  const run = (overrides: Partial<RunRow>): RunRow => runRow(overrides);
  const runService = (overrides: Partial<RunServiceRow>): RunServiceRow => ({
    scenario: SCENARIO_TITLE,
    runId: 'aaaaaaaa-death-4e4c-a0f0-0c0ffee0f1e2',
    runNumber: 1,
    service: 'ci-sim',
    status: 'completed',
    up: true,
    availability: 0.5,
    errorRate: 0.02,
    requestRate: 10,
    latencyP95Ms: 120,
    ...overrides,
  });

  const state: TwinState = {
    readAt: NOW.toISOString(),
    runs: [
      run({ runNumber: 1, ageMs: 7 * 3_600_000, suspectStale: true }),
      run({
        runNumber: 2,
        executedAt: new Date('2026-11-08T10:00:00Z').toISOString(),
        status: 'completed',
        outcome: 'failed',
        durationMs: 600_000,
        alertsTotal: 35,
        uniqueAttackers: 1,
        attackers: ['10.244.0.5'],
        hasReport: true,
        executedBy: 'operator-2',
      }),
      run({
        runNumber: 3,
        executedAt: new Date('2026-11-09T06:00:00Z').toISOString(),
        status: 'completed',
        outcome: 'passed',
        durationMs: 300_000,
        alertsTotal: 3,
        uniqueAttackers: 1,
        attackers: ['10.244.0.5', '10.244.0.9'],
        executedBy: 'operator-2',
        hasReport: true,
        partial: true,
      }),
    ],
    runServices: [
      runService({
        runNumber: 2,
        service: 'ci-sim',
        up: false,
        availability: 0.42,
        status: 'completed',
      }),
      runService({ runNumber: 2, service: 'secanod', status: 'completed', availability: 1 }),
      runService({
        runNumber: 3,
        service: 'ci-sim',
        up: true,
        availability: 0.99,
        status: 'completed',
      }),
    ],
  };

  it('selects the latest run per scenario', () => {
    const result = executeStateQuery({ select: 'latest', where: [], whereAny: [] }, state);
    expect(result.runs.map(runLabel)).toEqual([runLabel(state.runs[2])]);

    const scoped = executeStateQuery(
      { scenario: SCENARIO_TITLE, select: 'latest', where: [], whereAny: [] },
      state
    );
    expect(scoped.runs).toHaveLength(1);
    expect(scoped.runs[0].runNumber).toBe(3);
  });

  it('selects pinned runNumber', () => {
    const result = executeStateQuery(
      { scenario: SCENARIO_TITLE, runNumber: 2, where: [], whereAny: [] },
      state
    );
    expect(result.runs[0]).toMatchObject({ runNumber: 2, outcome: 'failed', alertsTotal: 35 });
  });

  it('counts and answers min/max', () => {
    const count = executeStateQuery(
      { scenario: SCENARIO_TITLE, where: [], whereAny: [], aggregate: { op: 'count' } },
      state
    );
    expect(count.value).toBe(3);

    const max = executeStateQuery(
      {
        scenario: SCENARIO_TITLE,
        where: [],
        whereAny: [],
        aggregate: { op: 'max', field: 'alertsTotal' },
      },
      state
    );
    expect(max.value).toBe(35);
    expect(max.valueRows).toEqual([runLabel(state.runs[1])]);

    const min = executeStateQuery(
      {
        scenario: SCENARIO_TITLE,
        where: [],
        whereAny: [],
        aggregate: { op: 'min', field: 'durationMs' },
      },
      state
    );
    expect(min.value).toBe(300_000);
  });

  it('ranks and groups', () => {
    const ranking = executeStateQuery(
      {
        scenario: SCENARIO_TITLE,
        where: [],
        whereAny: [],
        aggregate: { op: 'rank', field: 'alertsTotal' },
      },
      state
    );
    expect(ranking.ranking?.[0].value).toBe(35);
    // null alertsTotal ranks with value 0, last.
    expect(ranking.ranking?.map((entry) => entry.value)).toEqual([35, 3, 0]);

    const grouped = executeStateQuery(
      { scenario: SCENARIO_TITLE, where: [], whereAny: [], groupBy: 'outcome' },
      state
    );
    expect(grouped.groups?.map((g) => [g.key, g.count])).toEqual([
      ['failed', 1],
      ['passed', 1],
    ]);
  });

  it('supports OR (whereAny) and NOT', () => {
    const either = executeStateQuery(
      {
        scenario: SCENARIO_TITLE,
        where: [],
        whereAny: [
          [{ field: 'outcome', op: 'eq', value: 'passed' }],
          [{ field: 'alertsTotal', op: 'gt', value: 20 }],
        ],
      },
      state
    );
    expect(either.matchCount).toBe(2);

    const notRunning = executeStateQuery(
      {
        scenario: SCENARIO_TITLE,
        where: [{ field: 'status', op: 'eq', value: 'running', not: true }],
      },
      state
    );
    expect(notRunning.matchCount).toBe(2);
  });

  it('executes the runServices table', () => {
    const down = executeStateQuery(
      {
        table: 'runServices',
        scenario: SCENARIO_TITLE,
        runNumber: 2,
        where: [],
        whereAny: [],
      },
      state
    );
    expect(down.runServices.map((row) => row.service)).toEqual(['ci-sim', 'secanod']);

    const unhealthy = executeStateQuery(
      {
        table: 'runServices',
        where: [{ field: 'up', op: 'eq', value: 'false' }],
      },
      state
    );
    expect(unhealthy.runServices).toHaveLength(1);
    expect(unhealthy.runServices[0].service).toBe('ci-sim');

    const manyAttackers = executeStateQuery(
      { where: [{ field: 'attackers', op: 'sizeGte', value: 2 }] },
      state
    );
    expect(manyAttackers.matchCount).toBe(1);
    expect(manyAttackers.runs[0].runNumber).toBe(3);
  });

  it('matches nothing and says so', () => {
    const result = executeStateQuery(
      {
        scenario: SCENARIO_TITLE,
        where: [{ field: 'outcome', op: 'eq', value: 'failed' }],
        select: 'latest',
      },
      state
    );
    expect(result.matchCount).toBe(0);
    expect(result.runs).toEqual([]);
    expect(formatStateResult(result, { where: [] }, state)).toContain(
      'Result: no run matches this query.'
    );
  });
});

describe('formatStateResult', () => {
  const state: TwinState = {
    readAt: '2026-11-09T12:00:00Z',
    runs: [runRow()],
    runServices: [],
  };

  it('starts with the live-read header', () => {
    const result = executeStateQuery({ where: [], whereAny: [] }, state);
    const text = formatStateResult(result, { where: [] }, state);
    expect(text.startsWith('Twin state read live at 2026-11-09T12:00:00Z.')).toBe(true);
  });

  it('formats the run age and a WARNING for a suspect-stale run', () => {
    const stale = runRow({
      executedAt: new Date('2026-10-20T12:00:00Z').toISOString(), // 20 days old
      ageMs: 20 * 86_400_000,
      suspectStale: true,
    });
    const staleState: TwinState = {
      readAt: '2026-11-09T12:00:00Z',
      runs: [stale],
      runServices: [],
    };
    const result = executeStateQuery({ where: [], whereAny: [] }, staleState);
    const text = formatStateResult(result, { where: [] }, staleState);
    expect(text).toContain('20 days ago');
    expect(text).toMatch(
      /WARNING: status "running" recorded \d+ days? ago with no completion — this record may be stale; say so in the answer and do not present the run as live\./
    );
  });

  it('says explicitly when the query matched nothing', () => {
    const empty = executeStateQuery(
      { where: [{ field: 'outcome', op: 'eq', value: 'passed' }] },
      state
    );
    const text = formatStateResult(empty, { where: [] }, state);
    expect(text).toContain('Result: no run matches this query.');
    expect(text).toContain('Twin state read live at');
  });

  it('formats counts and service rows', () => {
    const count = formatStateResult(
      {
        table: 'runs',
        runs: state.runs,
        runServices: [],
        matchCount: 1,
        value: 1,
      },
      { where: [], aggregate: { op: 'count' } },
      state
    );
    expect(count).toContain('Result: 1 matching runs.');
  });
});

describe('ageInWords', () => {
  it('uses words a person would say', () => {
    expect(ageInWords(30_000)).toBe('just now');
    expect(ageInWords(3 * 60_000)).toBe('3 minutes ago');
    expect(ageInWords(2 * 3_600_000)).toBe('2 hours ago');
    expect(ageInWords(2 * 86_400_000)).toBe('2 days ago');
    expect(ageInWords(31 * 86_400_000)).toBe('31 days ago'); // months from day 45
    expect(ageInWords(60 * 86_400_000)).toBe('2 months ago');
  });
});

describe('describeStateQuery', () => {
  it('summarises the query for the diagnostics', () => {
    expect(
      describeStateQuery({
        scenario: 'X',
        select: 'latest',
        where: [{ field: 'status', op: 'eq', value: 'running' }],
        whereAny: [],
        aggregate: { op: 'count' },
      })
    ).toContain('table runs; scenario "X"; select latest');
  });
});
