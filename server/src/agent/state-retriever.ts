import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Scenario } from '../models/Scenario.js';
import { ExecutionReport } from '../models/ExecutionReport.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

/**
 * Twin-state retrieval for the Boss Agent.
 *
 * The structured branch answers questions about the service catalog. It cannot
 * answer "was the last run of the demo scenario a pass?", "is anything running
 * right now?" or "which service was down?" — those live in the *run state*:
 * the scenarios' embedded executions plus the closed-run execution reports.
 *
 * Unlike the catalog (cached for 60 s), the state is read fresh from MongoDB on
 * every question, and every answer carries how old the information is. A run
 * that says "running" but has no completion date after AGENT_STALE_RUN_MS is
 * flagged `suspectStale` so the agent reports the doubt instead of presenting
 * the record as live.
 *
 * The executor is a pure function over plain objects, mirroring the catalog
 * query language's style (see `structured-retriever.ts`), so it is unit-tested
 * without MongoDB (`__tests__/state-retriever.test.ts`).
 */

// ---------------------------------------------------------------------------
// State tables
// ---------------------------------------------------------------------------

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type RunOutcome = 'passed' | 'failed' | 'partial';

export const RUN_STATUSES: RunStatus[] = ['pending', 'running', 'completed', 'failed'];
export const RUN_OUTCOMES: RunOutcome[] = ['passed', 'failed', 'partial'];

/** One run of one scenario — the `runs` table (§4.1 of IMPLEMENTATION.md). */
export interface RunRow {
  scenario: string;
  /** Execution id as a plain string (Mongo ObjectId hex). */
  runId: string;
  /** 1 = oldest run of the scenario, by executedAt. */
  runNumber: number;
  executedAt: string;
  executedBy: string;
  status: RunStatus;
  /** The execution's outcome, falling back to the report's outcome. */
  outcome: RunOutcome | null;
  completedAt: string | null;
  durationMs: number | null;
  /** now - executedAt at read time. */
  ageMs: number;
  alertsTotal: number | null;
  uniqueAttackers: number | null;
  /** Distinct attacker addresses from the report's alerts, sorted. */
  attackers: string[];
  errorLines: number | null;
  warnings: number | null;
  restarts: number | null;
  hasReport: boolean;
  /** The report's `partial` flag (false for runs without a report). */
  partial: boolean;
  /**
   * status in (pending, running) AND no completedAt AND ageMs >
   * AGENT_STALE_RUN_MS: the record is almost certainly stale (its namespace is
   * long gone) and must not be presented as live.
   */
  suspectStale: boolean;
}

/** One deployed service in one run — the `runServices` table. */
export interface RunServiceRow {
  scenario: string;
  runId: string;
  runNumber: number;
  /** Kubernetes resource name / topology node name. */
  service: string;
  /** Deploy status (from the execution's deployedServices, report if closed). */
  status: RunStatus | null;
  /** Last traffic probe succeeded before teardown (report only). */
  up: boolean | null;
  /** Share of successful probes over the run, 0–1. */
  availability: number | null;
  errorRate: number | null;
  requestRate: number | null;
  latencyP95Ms: number | null;
}

export interface TwinState {
  /** When the read happened — the header of every state answer. */
  readAt: string;
  runs: RunRow[];
  runServices: RunServiceRow[];
}

// ---------------------------------------------------------------------------
// State query language (same style as the catalog query language)
// ---------------------------------------------------------------------------

export const STATE_TABLES = ['runs', 'runServices'] as const;
export type StateTable = (typeof STATE_TABLES)[number];

/**
 * Fields the state query language may reference. Field semantics (shown to the
 * router, one line each) live with the vocabulary builder.
 */
export const RUN_FIELDS = [
  'scenario',
  'runNumber',
  'status',
  'outcome',
  'executedBy',
  'durationMs',
  'alertsTotal',
  'uniqueAttackers',
  'attackers',
  'errorLines',
  'warnings',
  'restarts',
  'hasReport',
  'partial',
  'suspectStale',
] as const;
export type RunField = (typeof RUN_FIELDS)[number];

export const RUN_SERVICE_FIELDS = [
  'service',
  'status',
  'up',
  'availability',
  'errorRate',
  'requestRate',
  'latencyP95Ms',
] as const;
export type RunServiceField = (typeof RUN_SERVICE_FIELDS)[number];

export const STATE_FIELDS = [...new Set([...RUN_FIELDS, ...RUN_SERVICE_FIELDS])] as string[];

export const STATE_SELECTS = ['latest', 'all', 'running'] as const;
export type StateSelect = (typeof STATE_SELECTS)[number];

export const STATE_OPS = [
  'eq',
  'ne',
  'in',
  'contains',
  'lt',
  'lte',
  'gt',
  'gte',
  'sizeEq',
  'sizeGte',
  'sizeLte',
] as const;
export type StateOp = (typeof STATE_OPS)[number];

export const STATE_AGGREGATE_OPS = ['list', 'count', 'min', 'max', 'rank'] as const;
export type StateAggregateOp = (typeof STATE_AGGREGATE_OPS)[number];

/** Fields whose value is a number (the only ones min/max can be applied to). */
export const STATE_NUMERIC_FIELDS = [
  'runNumber',
  'durationMs',
  'alertsTotal',
  'uniqueAttackers',
  'errorLines',
  'warnings',
  'restarts',
  'availability',
  'errorRate',
  'requestRate',
  'latencyP95Ms',
] as const;

/** List-valued fields (the size operators and a rank by size apply to them). */
export const STATE_LIST_FIELDS = ['attackers'] as const;

/** Fields whose value is a boolean, queried with eq/ne ("true"/"false"). */
export const STATE_BOOLEAN_FIELDS = ['hasReport', 'partial', 'suspectStale', 'up'] as const;

export const statePredicateSchema = z.object({
  field: z.string(),
  op: z.enum(STATE_OPS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  /** Negate the predicate: `not: true` means "is not". */
  not: z.boolean().optional(),
});
export type StatePredicate = z.infer<typeof statePredicateSchema>;

export const stateAggregateSchema = z.object({
  op: z.enum(STATE_AGGREGATE_OPS),
  /** Required for min/max/rank (a numeric field, or a list field ranked by size). */
  field: z.string().optional(),
});
export type StateAggregateSpec = z.infer<typeof stateAggregateSchema>;

/**
 * A state query over the twin's run tables.
 *
 * `table` picks the flat table (`runs` by default, or `runServices` —
 * per-service health/traffic rows). `scenario` restricts the rows to one
 * scenario (a title or other name, resolved by the router). `select` picks
 * which runs are in scope: `latest` (the newest run per scenario), `running`
 * (only runs still pending/running) or `all`; `runNumber` pins an exact run
 * (1 = oldest). `where` is an AND of predicates; `whereAny` adds a
 * disjunction (at least one AND-group must hold), as in the catalog language.
 */
export const stateQuerySchema = z.object({
  table: z.enum(STATE_TABLES).optional(),
  scenario: z.string().optional(),
  select: z.enum(STATE_SELECTS).optional(),
  runNumber: z.number().int().positive().optional(),
  where: z.array(statePredicateSchema).default([]),
  whereAny: z.array(z.array(statePredicateSchema)).default([]),
  groupBy: z.string().optional(),
  aggregate: stateAggregateSchema.optional(),
});
export type StateQuery = z.infer<typeof stateQuerySchema>;

// ---------------------------------------------------------------------------
// Loader (fresh, no cache — contrast the catalog's 60 s TTL)
// ---------------------------------------------------------------------------

interface ReportLike {
  scenarioId: unknown;
  executionId: unknown;
  outcome?: string;
  durationMs?: number;
  completedAt: unknown;
  services: Array<{ name: string; status?: string; containers?: Array<{ status?: string }> }>;
  metrics?: {
    containers?: { restarts?: number };
    logs?: { errorLines?: number };
    events?: { warnings?: number };
    alerts?: { total?: number; uniqueAttackers?: number };
  };
  alerts: Array<{ attacker?: string }>;
  traffic?: Array<Record<string, unknown>>;
  partial: boolean;
}

interface ScenarioLike {
  _id?: unknown;
  title: string;
  deprecated?: boolean;
  executions: Array<{
    _id?: unknown;
    executedAt: Date | string;
    executedBy?: string;
    status?: RunStatus;
    completedAt?: Date | string | null;
    durationMs?: number | null;
    outcome?: string | null;
    deployedServices?: Array<{ name?: string; status?: RunStatus }>;
  }>;
}

function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : value ? new Date(String(value)) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function metricNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function distinctAttackers(alerts: ReportLike['alerts']): string[] {
  const attackers = new Set<string>();
  for (const alert of alerts) {
    if (typeof alert.attacker === 'string' && alert.attacker.trim()) {
      attackers.add(alert.attacker.trim());
    }
  }
  return [...attackers].sort((a, b) => a.localeCompare(b));
}

/** Turn the raw documents into the two flat state tables. Pure. */
export function buildTwinState(
  scenarios: ScenarioLike[],
  reports: ReportLike[],
  now: Date = new Date()
): TwinState {
  const reportByRun = new Map<string, ReportLike>();
  for (const report of reports) {
    reportByRun.set(`${String(report.scenarioId)}:${String(report.executionId)}`, report);
  }

  const runs: RunRow[] = [];
  const runServices: RunServiceRow[] = [];

  for (const scenario of scenarios) {
    if (scenario.deprecated) continue;
    const sorted = [...(scenario.executions ?? [])].sort(
      (a, b) => (Date.parse(String(a.executedAt)) || 0) - (Date.parse(String(b.executedAt)) || 0)
    );
    for (const [index, execution] of sorted.entries()) {
      const runId = String(execution._id ?? `no-id-${index}`);
      const report = reportByRun.get(`${String(scenario._id)}:${runId}`);
      const executedAtIso = iso(execution.executedAt) ?? new Date(0).toISOString();
      const ageMs = now.getTime() - (Date.parse(executedAtIso) || 0);
      const status = (execution.status ?? 'pending') as RunStatus;
      const reportedOutcome = RUN_OUTCOMES.includes(execution.outcome as RunOutcome)
        ? (execution.outcome as RunOutcome)
        : RUN_OUTCOMES.includes(report?.outcome as RunOutcome)
          ? (report?.outcome as RunOutcome)
          : null;
      const attackers = report ? distinctAttackers(report.alerts) : [];

      const run: RunRow = {
        scenario: scenario.title,
        runId,
        runNumber: index + 1,
        executedAt: executedAtIso,
        executedBy: execution.executedBy ?? '',
        status,
        outcome: reportedOutcome,
        completedAt: iso(execution.completedAt) ?? (report ? iso(report.completedAt) : null),
        durationMs: metricNumber(execution.durationMs) ?? metricNumber(report?.durationMs) ?? null,
        ageMs,
        alertsTotal: metricNumber(report?.metrics?.alerts?.total),
        uniqueAttackers: metricNumber(report?.metrics?.alerts?.uniqueAttackers),
        attackers,
        errorLines: metricNumber(report?.metrics?.logs?.errorLines),
        warnings: metricNumber(report?.metrics?.events?.warnings),
        restarts: metricNumber(report?.metrics?.containers?.restarts),
        hasReport: Boolean(report),
        partial: report ? Boolean(report.partial) : false,
        suspectStale:
          (status === 'pending' || status === 'running') &&
          !execution.completedAt &&
          ageMs > env.AGENT_STALE_RUN_MS,
      };
      runs.push(run);

      // Per-service rows: the execution's deployedServices joined with the
      // report's services (status, container restarts) and traffic (health)
      // by Kubernetes resource name.
      const reportServices = new Map(
        (report?.services ?? []).map((service) => [service.name, service])
      );
      const reportTraffic = new Map(
        (report?.traffic ?? []).map((traffic) => [
          String(traffic['service'] ?? ''),
          traffic as Record<string, unknown>,
        ])
      );
      for (const deployed of execution.deployedServices ?? []) {
        const service = String(deployed.name ?? '');
        if (!service) continue;
        const reportService = reportServices.get(service);
        const traffic = reportTraffic.get(service);
        runServices.push({
          scenario: scenario.title,
          runId,
          runNumber: run.runNumber,
          service,
          status: (deployed.status ?? reportService?.status ?? null) as RunStatus | null,
          up: typeof traffic?.['up'] === 'boolean' ? (traffic['up'] as boolean) : null,
          availability: metricNumber(traffic?.['availability']),
          errorRate: metricNumber(traffic?.['errorRate']),
          requestRate: metricNumber(traffic?.['requestRate']),
          latencyP95Ms: metricNumber(traffic?.['latencyP95Ms']),
        });
      }
    }
  }

  return { readAt: now.toISOString(), runs, runServices };
}

/**
 * Load the twin's run state from MongoDB — never cached, unlike the catalog:
 * the answer must reflect the state at answer time.
 */
export async function loadTwinState(now: Date = new Date()): Promise<TwinState> {
  const [scenarios, reports] = await Promise.all([
    Scenario.find({ deprecated: { $ne: true } })
      .select('title deprecated executions')
      .lean(),
    ExecutionReport.find()
      .select(
        'scenarioId executionId outcome durationMs completedAt services metrics alerts traffic partial'
      )
      .lean(),
  ]);
  return buildTwinState(
    scenarios as unknown as ScenarioLike[],
    reports as unknown as ReportLike[],
    now
  );
}

/** Load the state without breaking the request (logs a warning instead). */
export async function loadTwinStateSafely(now: Date = new Date()): Promise<TwinState | null> {
  try {
    return await loadTwinState(now);
  } catch (error) {
    logger.warn('State retrieval: failed to read the twin state', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Executor (pure)
// ---------------------------------------------------------------------------

export interface StateGroup {
  key: string;
  /** Group members: run labels ("run #2 of "X"") or service names. */
  runs: string[];
  count: number;
}

export interface StateResult {
  table: StateTable;
  /** Matching rows of the selected table (empty list = no match, say so). */
  runs: RunRow[];
  runServices: RunServiceRow[];
  matchCount: number;
  groups?: StateGroup[];
  /** Aggregate value: count / min / max. */
  value?: number;
  /** The winning rows of a min/max (run labels, or services with their run). */
  valueRows?: string[];
  /** Group key(s) with the most members — "which service failed most". */
  topGroupKeys?: string[];
  topGroupCount?: number;
  /** rank: matching rows ordered by the ranked value, highest first. */
  ranking?: Array<{ run: string; value: number }>;
}

/** Short human label for a run row. */
export function runLabel(row: RunRow): string {
  return `run #${row.runNumber} of "${row.scenario}"`;
}

/** Label for a runServices row, ready to cite in an answer. */
export function serviceRowLabel(row: RunServiceRow): string {
  return `${row.service} (run #${row.runNumber} of "${row.scenario}")`;
}

type StateFieldValue = string | number | boolean | string[] | null;

function fieldOf(row: RunRow | RunServiceRow, field: string): StateFieldValue {
  if (field === 'scenario' || field === 'runNumber' || field === 'runId') {
    return row[field];
  }
  return (row as unknown as Record<string, StateFieldValue>)[field] ?? null;
}

function rowIsRun(row: RunRow | RunServiceRow): row is RunRow {
  return 'executedAt' in row;
}

function equalsValue(actual: StateFieldValue, expected: unknown): boolean {
  if (actual === null || actual === undefined) return false;
  if (typeof actual === 'boolean') {
    const wanted =
      typeof expected === 'boolean' ? expected : String(expected).toLowerCase() === 'true';
    return actual === wanted;
  }
  if (typeof actual === 'number') {
    return typeof expected === 'number' ? actual === expected : Number(expected) === actual;
  }
  if (typeof actual === 'string') {
    return typeof expected === 'string' && actual.toLowerCase() === expected.toLowerCase();
  }
  if (Array.isArray(actual)) {
    const wanted = Array.isArray(expected) ? expected : [expected];
    return wanted.some(
      (candidate) =>
        typeof candidate === 'string' &&
        actual.some((element) => element.toLowerCase() === candidate.toLowerCase())
    );
  }
  return false;
}

function containsValue(actual: StateFieldValue, expected: unknown): boolean {
  if (actual === null || actual === undefined) return false;
  const needle = String(expected).toLowerCase();
  if (Array.isArray(actual)) {
    return actual.some(
      (element) => element.toLowerCase() === needle || element.toLowerCase().includes(needle)
    );
  }
  return String(actual).toLowerCase().includes(needle);
}

function compareNumeric(actual: StateFieldValue, expected: unknown, op: StateOp): boolean {
  if (typeof actual !== 'number') return false;
  const wanted = typeof expected === 'number' ? expected : Number(expected);
  if (Number.isNaN(wanted)) return false;
  switch (op) {
    case 'lt':
      return actual < wanted;
    case 'lte':
      return actual <= wanted;
    case 'gt':
      return actual > wanted;
    case 'gte':
      return actual >= wanted;
    default:
      return false;
  }
}

/** Does one row satisfy one predicate (before the `not` flag)? */
export function matchesStatePredicate(
  row: RunRow | RunServiceRow,
  predicate: StatePredicate
): boolean {
  const actual = fieldOf(row, predicate.field);
  let outcome: boolean;

  switch (predicate.op) {
    case 'eq':
      outcome = equalsValue(actual, predicate.value);
      break;
    case 'ne':
      outcome = !equalsValue(actual, predicate.value);
      break;
    case 'in':
      outcome = Array.isArray(predicate.value)
        ? predicate.value.some((candidate) => equalsValue(actual, candidate))
        : equalsValue(actual, predicate.value);
      break;
    case 'contains':
      outcome = containsValue(actual, predicate.value);
      break;
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      outcome = compareNumeric(actual, predicate.value, predicate.op);
      break;
    case 'sizeEq':
    case 'sizeGte':
    case 'sizeLte': {
      const size = Array.isArray(actual) ? actual.length : 0;
      const expected = Number(predicate.value);
      outcome =
        predicate.op === 'sizeEq'
          ? size === expected
          : predicate.op === 'sizeGte'
            ? size >= expected
            : size <= expected;
      break;
    }
    default:
      outcome = false;
  }

  return predicate.not ? !outcome : outcome;
}

/** The value a rank orders by: a number field, or the size of a list field. */
function stateRankValue(row: RunRow | RunServiceRow, field: string): number {
  const value = fieldOf(row, field);
  if (Array.isArray(value)) return value.length;
  return typeof value === 'number' ? value : 0;
}

function rankFieldOf(query: StateQuery): string | null {
  const field = query.aggregate?.field;
  if (!field) return null;
  if (STATE_NUMERIC_FIELDS.includes(field as never) || STATE_LIST_FIELDS.includes(field as never)) {
    return field;
  }
  return null;
}

/** Label a row for prompts/answers, whatever table it came from. */
function rowLabel(row: RunRow | RunServiceRow): string {
  return rowIsRun(row) ? runLabel(row) : serviceRowLabel(row);
}

/** The rows of one state table, as a uniform list. */
function rowsOf(state: TwinState, table: StateTable): Array<RunRow | RunServiceRow> {
  return table === 'runServices' ? state.runServices : state.runs;
}

function naturalKey(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Execute a state query over the twin state. Pure: no MongoDB, no LLM.
 *
 * Scope is fixed first (scenario, then runNumber, then select — latest keeps
 * the newest runNumber per scenario in scope, running keeps only pending /
 * running rows), then the predicates filter, then the aggregate applies.
 */
export function executeStateQuery(query: StateQuery, state: TwinState): StateResult {
  const table: StateTable = query.table ?? 'runs';
  const scenario = query.scenario;
  const runNumber = query.runNumber;
  const select: StateSelect = query.select ?? 'all';

  const scoped = rowsOf(state, table).filter(
    (row) => (!scenario || row.scenario === scenario) && (!runNumber || row.runNumber === runNumber)
  );
  let rows: Array<RunRow | RunServiceRow> = scoped;
  if (select === 'running') {
    rows = rows.filter((row) => {
      const runStatus = rowIsRun(row) ? row.status : row.service ? row.status : null;
      return runStatus === 'pending' || runStatus === 'running';
    });
  } else if (select === 'latest') {
    const topPerScenario = new Map<string, number>();
    for (const row of scoped) {
      const top = topPerScenario.get(row.scenario);
      if (top === undefined || row.runNumber > top) {
        topPerScenario.set(row.scenario, row.runNumber);
      }
    }
    rows = rows.filter((row) => topPerScenario.get(row.scenario) === row.runNumber);
  }

  const where = query.where ?? [];
  const whereAny = query.whereAny ?? [];
  rows = rows.filter(
    (row) =>
      where.every((predicate) => matchesStatePredicate(row, predicate)) &&
      (whereAny.length === 0 ||
        whereAny.some((group) => group.every((predicate) => matchesStatePredicate(row, predicate))))
  );

  const result: StateResult = {
    table,
    runs: table === 'runs' ? (rows as RunRow[]) : [],
    runServices: table === 'runServices' ? (rows as RunServiceRow[]) : [],
    matchCount: rows.length,
  };

  // min / max over all matching rows — a simultaneous groupBy would turn every
  // group into a count of 1, as in the catalog executor.
  const extremum = query.aggregate?.op === 'min' || query.aggregate?.op === 'max';
  if (query.groupBy && !extremum) {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const value = fieldOf(row, query.groupBy);
      if (value === null || value === undefined) continue;
      const keys = Array.isArray(value) ? value : [String(value)];
      for (const key of keys.filter(Boolean)) {
        const bucket = groups.get(key) ?? [];
        bucket.push(rowLabel(row));
        groups.set(key, bucket);
      }
    }
    const ordered = [...groups.entries()].sort((a, b) => naturalKey(a[0], b[0]));
    result.groups = ordered.map(([key, members]) => ({
      key,
      runs: [...new Set(members)].sort(naturalKey),
      count: members.length,
    }));
    const top = Math.max(0, ...result.groups.map((group) => group.count));
    if (result.groups.length > 0) {
      result.topGroupKeys = result.groups
        .filter((group) => group.count === top)
        .map((group) => group.key);
      result.topGroupCount = top;
    }
    if (query.aggregate?.op === 'count') {
      result.value = top;
    }
    return result;
  }

  const aggregate = query.aggregate ?? { op: 'list' as StateAggregateOp };
  if (aggregate.op === 'count') {
    result.value = rows.length;
    return result;
  }
  if (aggregate.op === 'min' || aggregate.op === 'max') {
    const field = rankFieldOf(query);
    if (!field || !STATE_NUMERIC_FIELDS.includes(field as never)) {
      return result;
    }
    const values = rows
      .map((row) => fieldOf(row as never, field))
      .filter((value): value is number => typeof value === 'number');
    if (values.length === 0) return result;
    const best = aggregate.op === 'min' ? Math.min(...values) : Math.max(...values);
    result.value = best;
    result.valueRows = rows.filter((row) => fieldOf(row as never, field) === best).map(rowLabel);
    return result;
  }
  if (aggregate.op === 'rank') {
    const field = rankFieldOf(query);
    if (!field) return result;
    result.ranking = rows
      .map((row) => ({ run: rowLabel(row), value: stateRankValue(row, field) }))
      .sort((a, b) => b.value - a.value || naturalKey(a.run, b.run));
    return result;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Static baseline index (§4.4 of IMPLEMENTATION.md)
// ---------------------------------------------------------------------------

/**
 * One run summary as indexed at a fixed time t0 — the same facts as a RunRow
 * plus its services, with `executedAt` but NO "as of now" information (no
 * age, no staleness). The `state-static` retrieval mode answers from this
 * snapshot; it stands for the common practice of indexing operational data
 * periodically, and goes stale when the state changes.
 */
export interface StaticRunEntry {
  summary: string;
  embedding: number[];
}

export interface StaticIndex {
  builtAt: string;
  runs: StaticRunEntry[];
}

/** Default location of the snapshot written by build-static-index.mjs. */
export const STATIC_INDEX_PATH = new URL(
  '../../scripts/evaluation-live-state/static-index.json',
  import.meta.url
);

/** Read the static baseline index, or null when it has not been built yet. */
export function loadStaticIndex(path: URL | string = STATIC_INDEX_PATH): StaticIndex | null {
  try {
    return JSON.parse(readFileSync(path).toString()) as StaticIndex;
  } catch (error) {
    logger.warn('State retrieval: no static run index available', {
      path: String(path),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Retrieve the top-k run summaries from the static index by embedding
 * similarity to `query`. The query is embedded with the same gateway and task
 * prefix the vector branch uses for catalog queries ('search_query'); the
 * summaries were embedded as 'search_document' by build-static-index.mjs.
 */
export async function retrieveStaticRuns(
  query: string,
  gateway: { embed(text: string, task?: string): Promise<number[]> },
  topK = 4
): Promise<{ entries: Array<StaticRunEntry & { score: number }>; builtAt: string | null }> {
  const index = loadStaticIndex();
  if (!index || index.runs.length === 0) {
    return { entries: [], builtAt: null };
  }
  const queryVector = await gateway.embed(query, 'search_query');
  const entries = index.runs
    .map((entry) => ({ ...entry, score: cosineSimilarity(queryVector, entry.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return { entries, builtAt: index.builtAt };
}

// ---------------------------------------------------------------------------
// Vocabulary for the router (§4.2)
// ---------------------------------------------------------------------------

/** Field semantics for the state route, one meaning per line. */
export const STATE_FIELD_SEMANTICS = [
  'scenario, executedBy, service, status, outcome: single-valued strings.',
  'status is the deploy/run status: pending = created but not started, running = started and not',
  'closed, completed = closed cleanly, failed = closed because the deploy failed. outcome is the',
  'overall verdict of a closed run: passed | failed | partial.',
  'runNumber: the 1-based position of the run in the scenario history (1 = the first/oldest run).',
  'durationMs, alertsTotal, uniqueAttackers, errorLines, warnings, restarts, availability,',
  'errorRate, requestRate, latencyP95Ms: numbers (availability 0..1; errorRate/requestRate per',
  'second; latencyP95Ms in milliseconds).',
  'attackers: list of attacker addresses seen in the run — use op "contains" with the address',
  '(e.g. an IP), or sizeEq/sizeGte/sizeLte to compare the NUMBER of distinct attackers.',
  'hasReport, partial, suspectStale, up: booleans ("true"/"false"). hasReport = a closed-run',
  'report exists for the run; suspectStale = the record looks stale (see the WARNING lines in',
  'the result); up = the last health probe of the service succeeded.',
].join('\n');

/** State operators text (parallel to the catalog branch's OPERATORS). */
export const STATE_OPERATORS = `Operators: eq, ne, in, contains, lt, lte, gt, gte, sizeEq, sizeGte, sizeLte.
- eq / ne: equality ("true"/"false" for booleans, e.g. "has a report" -> hasReport eq true).
- in: the value is a list of accepted values.
- contains: the field contains the value (substring; membership in attackers).
- lt / lte / gt / gte: numeric comparison ("more than 20 alerts" -> alertsTotal gt 20).
- sizeEq / sizeGte / sizeLte: compare the NUMBER of entries of attackers with a number, e.g.
  "at least two distinct attackers" -> attackers sizeGte 2.`;

/** State mapping rules (parallel to MAPPING_RULES in query-router.ts). */
export const STATE_MAPPING_RULES = [
  '- Which runs/executions exist or happened ("how many times", "did X ever fail"): table "runs".',
  '- Per-service facts inside a run (was a service down, its availability, restarts, its UI type',
  '  while deployed): table "runServices".',
  '- "the last/latest run" -> select "latest"; "right now / currently / still running" -> select',
  '  "running"; otherwise leave select unset ("all").',
  '- "the second run", "run number 3": set runNumber to that integer (1 = oldest).',
  '- "how many times did X run" -> scenario X, aggregate op "count".',
  '- "the run with the most alerts" -> aggregate "max" on alertsTotal; "fastest/longest run" ->',
  '  min/max on durationMs; "most reliable/least reliable" -> max/min on availability.',
  '- "top N runs by X" -> aggregate op "rank" on that field.',
  '- "each run / per run / for every service" -> groupBy the field named in the question.',
  '- An "or" condition -> "whereAny"; a negation ("never", "not", "no completion") -> "not": true',
  '  on that predicate.',
  '- If you set a predicate on service / up / availability / errorRate / requestRate / latencyP95Ms,',
  '  table "runServices" is understood automatically (leaving table unset is fine).',
  '- Attacker addresses are data: an IP such as 10.244.0.99 is a normal "contains" value.',
].join('\n');

// ---------------------------------------------------------------------------
// Prompt formatting (§4.1)
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** An age in words ("just now", "3 hours ago", "2 months ago"). */
export function ageInWords(ageMs: number): string {
  if (ageMs < 2 * MS_PER_MINUTE) return 'just now';
  if (ageMs < MS_PER_HOUR) {
    const n = Math.round(ageMs / MS_PER_MINUTE);
    return n === 1 ? '1 minute ago' : `${n} minutes ago`;
  }
  if (ageMs < MS_PER_DAY) {
    const n = Math.round(ageMs / MS_PER_HOUR);
    return n === 1 ? '1 hour ago' : `${n} hours ago`;
  }
  if (ageMs < 45 * MS_PER_DAY) {
    const n = Math.round(ageMs / MS_PER_DAY);
    return n === 1 ? '1 day ago' : `${n} days ago`;
  }
  const months = Math.round(ageMs / (30 * MS_PER_DAY));
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

const MAX_ROWS_SHOWN = 12;
const ATTACKERS_SHOWN = 6;

function formatAttackers(row: RunRow): string {
  if (row.attackers.length === 0) {
    return row.uniqueAttackers !== null ? `${row.uniqueAttackers} attackers` : '';
  }
  const shown = row.attackers.slice(0, ATTACKERS_SHOWN).join(', ');
  const more =
    row.attackers.length > ATTACKERS_SHOWN ? ` … (+${row.attackers.length - ATTACKERS_SHOWN})` : '';
  return `${row.uniqueAttackers ?? row.attackers.length} attackers: ${shown}${more}`;
}

function formatRunRow(row: RunRow): string[] {
  const parts = [
    `executedAt ${row.executedAt}`,
    ageInWords(row.ageMs),
    `by ${row.executedBy || 'unknown'}`,
    `status: ${row.status}`,
    `outcome: ${row.outcome ?? 'n/a'}`,
  ];
  if (row.completedAt) parts.push(`completedAt ${row.completedAt}`);
  if (row.durationMs !== null) parts.push(`duration ${(row.durationMs / 1000).toFixed(0)}s`);
  const attackersLine = formatAttackers(row);
  if (attackersLine) parts.push(attackersLine);
  if (row.errorLines !== null) parts.push(`error log lines: ${row.errorLines}`);
  if (row.warnings !== null) parts.push(`warnings: ${row.warnings}`);
  if (row.restarts !== null) parts.push(`container restarts: ${row.restarts}`);
  parts.push(`report: ${row.hasReport ? 'yes' : 'no'}`);
  if (row.partial) parts.push('partial capture');

  const lines = [`- ${runLabel(row)} [id ${row.runId.slice(0, 8)}]: ${parts.join(', ')}`];
  if (row.suspectStale) {
    const days = Math.max(1, Math.round(row.ageMs / MS_PER_DAY));
    lines.push(
      `  WARNING: status "${row.status}" recorded ${days} days ago with no completion — this record may be stale; say so in the answer and do not present the run as live.`
    );
  }
  return lines;
}

function formatServiceRunRow(row: RunServiceRow): string {
  const parts = [
    `status: ${row.status ?? 'n/a'}`,
    `up: ${row.up === null ? 'n/a' : row.up}`,
    `availability: ${row.availability ?? 'n/a'}`,
    `errorRate: ${row.errorRate ?? 'n/a'}`,
    `requestRate: ${row.requestRate ?? 'n/a'}`,
    `latencyP95Ms: ${row.latencyP95Ms ?? 'n/a'}`,
  ];
  return `- ${serviceRowLabel(row)}: ${parts.join(', ')}`;
}

/**
 * Format the state result for the prompt. The first line always states when
 * the twin state was read; every run line carries its age; suspect-stale runs
 * get the explicit WARNING line from the implementation instructions.
 */
export function formatStateResult(
  result: StateResult,
  query: StateQuery,
  state: TwinState
): string {
  void query; // the query is echoed separately by the caller (describeStateQuery)
  const lines: string[] = [`Twin state read live at ${state.readAt}.`];
  const noun = result.table === 'runs' ? 'run' : 'run service';
  const plural = `${noun}s`;

  if (result.matchCount === 0) {
    lines.push(`Result: no ${noun} matches this query.`);
    return lines.join('\n');
  }

  if (result.groups && result.groups.length > 0) {
    lines.push(`Result: ${result.matchCount} matching ${plural}, grouped by ${query.groupBy}:`);
    for (const group of result.groups) {
      lines.push(`- ${group.key}: ${group.count}`);
    }
    if (result.topGroupKeys && result.topGroupKeys.length > 0) {
      lines.push(
        `Group with the most members: ${result.topGroupKeys.join(', ')} (${result.topGroupCount})`
      );
    }
    return lines.join('\n');
  }

  if (result.ranking) {
    lines.push(`Result: ${result.matchCount} matching ${plural}, ranked highest first:`);
    result.ranking.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry.run}: ${entry.value}`);
    });
    return lines.join('\n');
  }

  if (result.value !== undefined) {
    if (query.aggregate?.op === 'min' || query.aggregate?.op === 'max') {
      lines.push(
        `Result: ${query.aggregate.op} of ${query.aggregate.field} = ${result.value} (${
          (result.valueRows ?? []).join('; ') || 'none'
        }).`
      );
    } else {
      lines.push(`Result: ${result.value} matching ${plural}.`);
    }
    return lines.join('\n');
  }

  lines.push(`Result: ${result.matchCount} matching ${plural}.`);
  lines.push('');
  const rows: Array<RunRow | RunServiceRow> =
    result.table === 'runs' ? result.runs : result.runServices;
  for (const row of rows.slice(0, MAX_ROWS_SHOWN)) {
    lines.push(...(rowIsRun(row) ? formatRunRow(row) : [formatServiceRunRow(row)]));
  }
  if (result.matchCount > MAX_ROWS_SHOWN) {
    lines.push(`… (${result.matchCount - MAX_ROWS_SHOWN} more not shown)`);
  }

  return lines.join('\n');
}

/** The state query in words, for the prompt and the diagnostics. */
export function describeStateQuery(query: StateQuery): string {
  const parts: string[] = [`table ${query.table ?? 'runs'}`];
  if (query.scenario) parts.push(`scenario "${query.scenario}"`);
  if (query.select) parts.push(`select ${query.select}`);
  if (query.runNumber) parts.push(`runNumber ${query.runNumber}`);
  const where = query.where ?? [];
  if (where.length > 0) {
    parts.push(where.map(formatStatePredicate).join(' AND '));
  }
  const whereAny = query.whereAny ?? [];
  if (whereAny.length > 0) {
    parts.push(
      `any of (${whereAny.map((group) => group.map(formatStatePredicate).join(' AND ')).join(' | ')})`
    );
  }
  if (query.groupBy) parts.push(`grouped by ${query.groupBy}`);
  if (query.aggregate) {
    const field = query.aggregate.field ? ` on ${query.aggregate.field}` : '';
    parts.push(`aggregate: ${query.aggregate.op}${field}`);
  }
  return parts.join('; ');
}

function formatStatePredicate(predicate: StatePredicate): string {
  const operator = predicate.not ? `NOT(${predicate.op})` : predicate.op;
  const value = Array.isArray(predicate.value)
    ? `[${predicate.value.join(', ')}]`
    : String(predicate.value);
  return `${predicate.field} ${operator} ${value}`;
}
