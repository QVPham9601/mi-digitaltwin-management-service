import { z } from 'zod';
import { getLLMGateway } from './index.js';
import { logger } from '../utils/logger.js';
import type { ChatMessage } from './types.js';
import {
  AGGREGATE_OPS,
  LIST_FIELDS,
  NUMERIC_FIELDS,
  SIZE_OPS,
  QUERY_FIELDS,
  QUERY_OPS,
  aggregateSchema,
  buildVocabulary,
  predicateSchema,
  resolveScenarioTitle,
  scenarioByExactName,
  resolveVocabularyValue,
  type Catalog,
  type CatalogVocabulary,
  type Predicate,
  type StructuredQuery,
} from './structured-retriever.js';
import {
  RUN_FIELDS,
  RUN_OUTCOMES,
  RUN_SERVICE_FIELDS,
  RUN_STATUSES,
  STATE_BOOLEAN_FIELDS,
  STATE_FIELD_SEMANTICS,
  STATE_LIST_FIELDS,
  STATE_MAPPING_RULES,
  STATE_NUMERIC_FIELDS,
  STATE_OPS,
  STATE_OPERATORS,
  STATE_TABLES,
  stateQuerySchema,
  type StatePredicate,
  type StateQuery,
  type TwinState,
} from './state-retriever.js';

/**
 * Query router: decides between the vector branch (a factual lookup), the
 * structured branch (a filter / count / group / join over the catalog) and
 * the state branch (a filter / count / group over the *run state* read live
 * from MongoDB), and builds the structured query when a structured or state
 * route is chosen.
 *
 * The model only *fills in* a closed schema. Every value it produces is
 * resolved against the real vocabulary; an unmappable value makes the route
 * invalid so the caller can fall back to the vector branch.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const routerSchema = z.object({
  kind: z.enum(['lookup', 'structured', 'state']),
  /** The service a lookup question is about (shortName). */
  service: z.string().optional(),
  scenario: z.string().optional(),
  notInScenario: z.string().optional(),
  where: z.array(predicateSchema).default([]),
  /** Disjunction: a list of AND-groups, of which at least one must hold. */
  whereAny: z.array(z.array(predicateSchema)).default([]),
  groupBy: z.enum(QUERY_FIELDS).optional(),
  groupByPrefix: z.string().optional(),
  aggregate: aggregateSchema.optional(),
  /** The state query, when kind = "state". */
  state: stateQuerySchema.optional(),
});
export type RouterOutput = z.infer<typeof routerSchema>;

/** JSON schema handed to the model (Ollama / vLLM structured outputs). */
export const ROUTER_JSON_SCHEMA = stripJsonSchemaMeta(z.toJSONSchema(routerSchema));

function stripJsonSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function formatVocabulary(vocabulary: CatalogVocabulary): string {
  const lines: string[] = [];
  const add = (label: string, values: string[]) => {
    if (values.length > 0) {
      lines.push(`${label}: ${values.join(' | ')}`);
    }
  };
  add('providers', vocabulary.providers);
  add('categories', vocabulary.categories);
  add('sectors', vocabulary.sectors);
  add('types', vocabulary.types);
  add('uiTypes', vocabulary.uiTypes);
  add('repositoryTables', vocabulary.repositoryTables);
  add('licenses', vocabulary.licenses);
  add('standards', vocabulary.standards);
  add('use cases', vocabulary.useCases);
  if (vocabulary.scenarioDetails.length > 0) {
    lines.push('scenarios (title — other names — services):');
    lines.push(...vocabulary.scenarioDetails.map((line) => `- ${line}`));
  }
  return lines.join('\n');
}

const FIELD_SEMANTICS = [
  'provider, category, sector, type, uiType, repositoryTable, license, shortName: single-valued strings.',
  'potentialUseCases, standards: list-valued strings — use op "contains" with the full string.',
  'trl.current, trl.expected: numbers (current / expected Technology Readiness Level, 1..9).',
].join('\n');

const OPERATORS = `Operators: ${QUERY_OPS.join(', ')}.
- eq / ne: equality (ne = not equal).
- in: the value is a list of accepted values.
- contains: the field contains the value (list membership or substring).
- lt / lte / gt / gte: numeric comparison, only on trl.current or trl.expected.
- sizeEq / sizeGte / sizeLte: compare the NUMBER of entries of a list field (standards,
  potentialUseCases) with a number, e.g. "at least two standards" -> standards sizeGte 2.`;

const MAPPING_RULES = [
  '- "partner infrastructure" means license = "N/A (Partner Infrastructure)".',
  '- "toolbox services" means repositoryTable = "INTACT_TOOLBOX".',
  '- Negation ("not", "excluding", "other than", "apart from") -> set "not": true on that predicate.',
  '- "how many" -> aggregate op "count"; "which/who/what" over a set -> "list".',
  '- "lowest/highest/least/most" -> "min"/"max" with the numeric field (trl.current / trl.expected).',
  '- "rank", "top N", "order by" -> aggregate op "rank" with the field: a numeric field, or a list',
  '  field (standards, potentialUseCases) to rank by its number of entries.',
  '- "each", "per", "for every" -> groupBy the field named in the question.',
  '- To keep only some group keys (e.g. keys that share a prefix), set groupByPrefix.',
  '- Which services a deployment scenario contains is answered ONLY with "scenario" (or',
  '  "notInScenario" for services not in it): pick the scenario title from the list that best',
  "  matches the user's wording or one of its other names. Membership is the scenario's services",
  '  list, not use-case text: potentialUseCases never decide scenario membership.',
  '- An "or" condition -> "whereAny": a list of AND-groups, at least one of which must hold.',
  '  A negated conjunction NOT(A AND B) is the "or" of the negations: whereAny: [[NOT A], [NOT B]].',
].join('\n');

export function buildRouterMessages(
  question: string,
  vocabulary: CatalogVocabulary,
  forceStructured: boolean,
  stateSection?: string
): ChatMessage[] {
  const kindRules = forceStructured
    ? [
        'You must answer kind = "structured" with a complete query: this question always needs a',
        'filter, a count, a comparison, a group-by or a scenario join over the whole catalog.',
      ].join('\n')
    : stateSection
      ? [
          'kind = "lookup" when the question asks for one fact about one named service',
          '(e.g. "Who provides SECSAC?", "What is the current TRL of MMT-PROBE?").',
          'kind = "structured" when the question filters, counts, compares, groups or joins over the',
          'catalog (e.g. "Which services are in the Monitor category?", "Which provider has the most',
          'services in Y?"). Facts about what a service IS stay here.',
          'kind = "state" when the question asks about the twin\'s RUNS: executions, deployments,',
          'alert counts, attackers, availability or health, or says "now", "currently", "last",',
          '"latest", "how many times", "was the last run a success". Fill the "state" query object.',
          'A service name inside a run-state question does NOT make it a catalog question.',
        ].join('\n')
      : [
          'kind = "lookup" when the question asks for one fact about one named service',
          '(e.g. "Who provides SECSAC?", "What is the current TRL of MMT-PROBE?").',
          'kind = "structured" when the question filters, counts, compares, groups or joins over the',
          'catalog (e.g. "Which services are in the Monitor category?", "How many services does X",',
          '"Which provider has the most services in Y?").',
        ].join('\n');

  const system = `You are the query router of a cybersecurity service catalog agent.
You translate a user question into a structured query over the service catalog
or, when the question is about past and current executions, over the runs.

Catalog vocabulary (use these exact strings, never invent one):
${formatVocabulary(vocabulary)}
${stateSection ? `\nRun-state vocabulary (use these exact values):\n${stateSection}\n` : ''}
Fields you may query on:
${FIELD_SEMANTICS}
${stateSection ? `\nRun-state fields:\n${STATE_FIELD_SEMANTICS}\n` : ''}
${OPERATORS}
${stateSection ? `\n${STATE_OPERATORS}\n` : ''}

${MAPPING_RULES}
${stateSection ? `\nRun-state mapping rules:\n${STATE_MAPPING_RULES}` : ''}

${kindRules}

Rules:
- Use only values from the vocabulary above.
- "where" is an AND of predicates.
- Answer with the JSON object only.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Question: ${question}` },
  ];
}

// ---------------------------------------------------------------------------
// Run-state routing (resolve + validate a `state` query, §4.2)
// ---------------------------------------------------------------------------

/** The fields a predicate may use on each state table. */
export function stateFieldsForTable(table: 'runs' | 'runServices'): string[] {
  return table === 'runServices'
    ? ['scenario', 'runNumber', ...RUN_SERVICE_FIELDS]
    : [...RUN_FIELDS];
}

/** The one-line "Run-state vocabulary" section for the router prompt. */
export function stateVocabularySection(state: TwinState): string {
  const executedBy = [...new Set(state.runs.map((run) => run.executedBy).filter(Boolean))];
  const services = [...new Set(state.runServices.map((row) => row.service))].sort();
  const attackers = [...new Set(state.runs.flatMap((run) => run.attackers))];
  const scenarios = [...new Set(state.runs.map((run) => run.scenario))];
  const lines = [
    `tables: ${STATE_TABLES.join(' | ')}`,
    `run statuses: ${RUN_STATUSES.join(' | ')}`,
    `run outcomes: ${RUN_OUTCOMES.join(' | ')}`,
    scenarios.length > 0
      ? `scenarios with runs: ${scenarios.join(' | ')}`
      : 'scenarios with runs: (none)',
    executedBy.length > 0 ? `executedBy (names on record): ${executedBy.join(' | ')}` : '',
    services.length > 0 ? `services seen in runs: ${services.join(' | ')}` : '',
    attackers.length > 0 ? `attacker addresses on record: ${attackers.join(' | ')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/** Resolve one state predicate's value, or the reason it could not be resolved. */
function resolveStatePredicate(
  predicate: StatePredicate,
  table: 'runs' | 'runServices',
  state: TwinState
): { ok: true; predicate: StatePredicate } | { ok: false; reason: string } {
  const allowed = stateFieldsForTable(table);
  if (!allowed.includes(predicate.field)) {
    return {
      ok: false,
      reason: `field ${predicate.field} is not a ${table} field (use one of: ${allowed.join(', ')})`,
    };
  }

  if (
    STATE_OPS.filter((op) => ['sizeEq', 'sizeGte', 'sizeLte'].includes(op)).includes(predicate.op)
  ) {
    if (predicate.field !== 'attackers') {
      return { ok: false, reason: `operator ${predicate.op} is only valid on the attackers list` };
    }
    const value = Number(Array.isArray(predicate.value) ? predicate.value[0] : predicate.value);
    if (!Number.isInteger(value) || value < 0) {
      return { ok: false, reason: `operator ${predicate.op} needs a whole number` };
    }
    return { ok: true, predicate: { ...predicate, value } };
  }

  const numericOp = ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'].includes(predicate.op);
  const isNumeric = STATE_NUMERIC_FIELDS.includes(predicate.field as never);
  if (isNumeric) {
    const raw = Array.isArray(predicate.value) ? predicate.value[0] : predicate.value;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return { ok: false, reason: `field ${predicate.field} needs a numeric value` };
    }
    if (!numericOp) {
      return { ok: false, reason: `operator ${predicate.op} is not valid on ${predicate.field}` };
    }
    return { ok: true, predicate: { ...predicate, value } };
  }

  if (['lt', 'lte', 'gt', 'gte'].includes(predicate.op)) {
    return {
      ok: false,
      reason: `operator ${predicate.op} is only valid on a numeric run-state field`,
    };
  }

  if (predicate.field === 'scenario') {
    // Resolved against the catalog's scenario titles later, in resolveStateQuery.
    if (typeof predicate.value !== 'string') {
      return { ok: false, reason: 'field scenario needs a string value' };
    }
    if (predicate.op !== 'eq') {
      return { ok: false, reason: `operator ${predicate.op} is not valid on scenario` };
    }
    return { ok: true, predicate };
  }

  if (STATE_BOOLEAN_FIELDS.includes(predicate.field as never)) {
    const raw = predicate.value;
    if (typeof raw !== 'boolean' && !['true', 'false'].includes(String(raw).toLowerCase())) {
      return { ok: false, reason: `field ${predicate.field} needs true or false` };
    }
    const value = typeof raw === 'boolean' ? raw : String(raw).toLowerCase() === 'true';
    return { ok: true, predicate: { ...predicate, value } };
  }

  // The remaining string fields have a vocabulary from the twin state itself:
  // status/outcome from the closed sets, executedBy/service/attackers from the
  // records. An unknown value is rejected, never silently accepted.
  const closedSets: Record<string, string[]> = {
    status: RUN_STATUSES,
    outcome: RUN_OUTCOMES,
  };
  const stateSets: Record<string, string[]> = {
    executedBy: [...new Set(state.runs.map((run) => run.executedBy).filter(Boolean))],
    service: [...new Set(state.runServices.map((row) => row.service))],
    attackers: [...new Set(state.runs.flatMap((run) => run.attackers))],
  };
  const candidates = closedSets[predicate.field] ?? stateSets[predicate.field] ?? [];
  if (candidates.length === 0) {
    return { ok: false, reason: `field ${predicate.field} is not a state field` };
  }

  const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
  const resolved: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      return { ok: false, reason: `field ${predicate.field} needs a string value` };
    }
    const needle = value.trim().toLowerCase();
    const exact = candidates.find((candidate) => candidate.toLowerCase() === needle);
    if (exact) {
      resolved.push(exact);
      continue;
    }
    const partial = candidates.filter(
      (candidate) =>
        candidate.toLowerCase().includes(needle) || needle.includes(candidate.toLowerCase())
    );
    if (partial.length === 1) {
      resolved.push(partial[0]);
      continue;
    }
    return {
      ok: false,
      reason: closedSets[predicate.field]
        ? `value "${value}" is not a known ${predicate.field} (use one of: ${candidates.join(', ')})`
        : `value "${value}" is not in the run-state vocabulary for ${predicate.field}`,
    };
  }

  return {
    ok: true,
    predicate: { ...predicate, value: Array.isArray(predicate.value) ? resolved : resolved[0] },
  };
}

/**
 * Resolve the model's state query against the real twin state and the
 * catalog's scenarios. Returns a cleaned query, or why it could not be built.
 */
export function resolveStateQuery(
  output: StateQuery,
  catalog: Catalog,
  state: TwinState
): { ok: true; query: StateQuery } | { ok: false; reason: string } {
  const table = output.table ?? 'runs';
  let scenario: string | undefined;

  if (output.scenario) {
    const resolution = resolveScenarioTitle(output.scenario, catalog);
    if (!resolution.ok) {
      return { ok: false, reason: resolution.reason };
    }
    scenario = resolution.title;
  }

  const cleanPredicateGroups = (
    groups: Array<StatePredicate[]>
  ): { ok: true; cleaned: StatePredicate[][] } | { ok: false; reason: string } => {
    const cleaned: StatePredicate[][] = [];
    for (const group of groups) {
      const resolvedGroup: StatePredicate[] = [];
      for (const predicate of group) {
        const resolved = resolveStatePredicate(predicate, table, state);
        if (!resolved.ok) {
          return { ok: false, reason: resolved.reason };
        }
        resolvedGroup.push(resolved.predicate);
      }
      if (resolvedGroup.length > 0) {
        cleaned.push(resolvedGroup);
      }
    }
    return { ok: true, cleaned };
  };

  const where = cleanPredicateGroups([output.where ?? []]);
  if (!where.ok) {
    return { ok: false, reason: where.reason };
  }
  const whereAny = cleanPredicateGroups(output.whereAny ?? []);
  if (!whereAny.ok) {
    return { ok: false, reason: whereAny.reason };
  }

  if (output.groupBy && !stateFieldsForTable(table).includes(output.groupBy)) {
    return {
      ok: false,
      reason: `cannot group ${table} by ${output.groupBy} (use one of: ${stateFieldsForTable(table).join(', ')})`,
    };
  }

  if (output.aggregate) {
    const aggregate = output.aggregate;
    if (aggregate.op === 'min' || aggregate.op === 'max') {
      if (!aggregate.field || !STATE_NUMERIC_FIELDS.includes(aggregate.field as never)) {
        return {
          ok: false,
          reason: `aggregate ${aggregate.op} needs a numeric run-state field (e.g. durationMs, alertsTotal, availability)`,
        };
      }
    }
    if (aggregate.op === 'rank') {
      const field = aggregate.field;
      if (
        !field ||
        !(
          STATE_NUMERIC_FIELDS.includes(field as never) ||
          STATE_LIST_FIELDS.includes(field as never)
        )
      ) {
        return {
          ok: false,
          reason: 'aggregate rank needs a numeric run-state field or the attackers list',
        };
      }
    }
  }

  const query: StateQuery = {
    ...(output.table ? { table: output.table } : {}),
    ...(scenario ? { scenario } : {}),
    ...(output.select ? { select: output.select } : {}),
    ...(output.runNumber ? { runNumber: output.runNumber } : {}),
    where: where.cleaned[0] ?? [],
    whereAny: whereAny.cleaned,
    ...(output.groupBy ? { groupBy: output.groupBy } : {}),
    ...(output.aggregate ? { aggregate: output.aggregate } : {}),
  };
  return { ok: true, query };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type RouteKind = 'lookup' | 'structured' | 'state' | 'invalid';

export interface RouteOutcome {
  kind: RouteKind;
  /** The structured catalog query (kind = structured) or state query (kind = state). */
  query?: StructuredQuery | StateQuery;
  /** The service a lookup question is about, when the model named one. */
  service?: string;
  /** Why the route failed (invalid query, unmapped value, …). */
  reason?: string;
  /** The raw model output, for diagnostics. */
  raw?: unknown;
}

export type ChatJsonFn = <T>(messages: ChatMessage[], schema: object, model?: string) => Promise<T>;

export interface RouteOptions {
  /** Ignore the model's routing decision and always build a structured query. */
  forceStructured?: boolean;
  /**
   * The run state, loaded live by the caller when the state branch should be
   * routable (auto mode). Without it the router prompt does not advertise the
   * state branch and a model "state" answer is invalid.
   */
  twinState?: TwinState;
  /** Injectable for tests. */
  chatJson?: ChatJsonFn;
  /** Model used for routing (defaults to the agent's chat model). */
  model?: string;
}

/**
 * Resolve one predicate's value against the catalog's vocabulary.
 * Returns a cleaned predicate, or the reason it could not be resolved.
 */
function resolvePredicate(
  predicate: Predicate,
  vocabulary: CatalogVocabulary
): { ok: true; predicate: Predicate } | { ok: false; reason: string } {
  const field = predicate.field;
  if (SIZE_OPS.includes(predicate.op)) {
    const value = Number(Array.isArray(predicate.value) ? predicate.value[0] : predicate.value);
    if (!LIST_FIELDS.includes(field)) {
      return { ok: false, reason: `operator ${predicate.op} is only valid on a list field` };
    }
    if (!Number.isInteger(value) || value < 0) {
      return { ok: false, reason: `operator ${predicate.op} needs a whole number` };
    }
    return { ok: true, predicate: { ...predicate, value } };
  }
  const numeric = NUMERIC_FIELDS.includes(field);
  const comparison = ['lt', 'lte', 'gt', 'gte'].includes(predicate.op);
  // Numeric fields accept the comparisons plus exact (in)equality ("a TRL of 4").
  const numericOp = comparison || ['eq', 'ne'].includes(predicate.op);

  if (numeric) {
    const raw = Array.isArray(predicate.value) ? predicate.value[0] : predicate.value;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return { ok: false, reason: `field ${field} needs a numeric value` };
    }
    if (!numericOp) {
      return { ok: false, reason: `operator ${predicate.op} is not valid on ${field}` };
    }
    return { ok: true, predicate: { ...predicate, value } };
  }

  if (comparison) {
    return { ok: false, reason: `operator ${predicate.op} is only valid on a numeric field` };
  }

  const values = Array.isArray(predicate.value) ? predicate.value : [predicate.value];
  const resolved: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      return { ok: false, reason: `field ${field} needs a string value` };
    }
    const resolution = resolveVocabularyValue(field, value, vocabulary);
    if (!resolution.ok) {
      return { ok: false, reason: resolution.reason };
    }
    resolved.push(resolution.value);
  }

  return {
    ok: true,
    predicate: { ...predicate, value: Array.isArray(predicate.value) ? resolved : resolved[0] },
  };
}

/**
 * The scenario a potentialUseCases predicate names ("... attack→detect→respond
 * scenario"), or null. Use-case text never decides scenario membership, even
 * when the text is a real use case.
 */
function scenarioFromUseCase(predicate: Predicate, catalog: Catalog): string | null {
  if (predicate.field !== 'potentialUseCases' || typeof predicate.value !== 'string') {
    return null;
  }
  // A scenario's exact title or other name, even without the word "scenario".
  const exact = scenarioByExactName(predicate.value, catalog);
  if (exact) {
    return exact;
  }
  if (!/\bscenario\b/i.test(predicate.value)) {
    return null;
  }
  const resolution = resolveScenarioTitle(predicate.value, catalog);
  return resolution.ok ? resolution.title : null;
}

/**
 * Resolve the model's values against the catalog's real vocabulary.
 * Returns a cleaned query, or the reason it could not be resolved.
 */
export function resolveQuery(
  output: RouterOutput,
  catalog: Catalog
): { ok: true; query: StructuredQuery } | { ok: false; reason: string } {
  const vocabulary = buildVocabulary(catalog);
  const where: StructuredQuery['where'] = [];
  let scenario = output.scenario;
  let notInScenario = output.notInScenario;

  for (const predicate of output.where ?? []) {
    // A scenario named as a use case ("... attack→detect→respond scenario") is a
    // scenario filter: membership comes from the scenario, not from use-case text.
    const asScenario = scenarioFromUseCase(predicate, catalog);
    if (asScenario) {
      if (predicate.not) {
        notInScenario ??= asScenario;
      } else {
        scenario ??= asScenario;
      }
      continue;
    }
    const resolved = resolvePredicate(predicate, vocabulary);
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }
    where.push(resolved.predicate);
  }

  const whereAny: Predicate[][] = [];
  for (const group of output.whereAny ?? []) {
    const resolvedGroup: Predicate[] = [];
    for (const predicate of group) {
      const resolved = resolvePredicate(predicate, vocabulary);
      if (!resolved.ok) {
        return { ok: false, reason: resolved.reason };
      }
      resolvedGroup.push(resolved.predicate);
    }
    if (resolvedGroup.length > 0) {
      whereAny.push(resolvedGroup);
    }
  }

  if (scenario) {
    const resolution = resolveScenarioTitle(scenario, catalog);
    if (!resolution.ok) {
      return { ok: false, reason: resolution.reason };
    }
    scenario = resolution.title;
  }

  if (notInScenario) {
    const resolution = resolveScenarioTitle(notInScenario, catalog);
    if (!resolution.ok) {
      return { ok: false, reason: resolution.reason };
    }
    notInScenario = resolution.title;
  }

  const aggregate = output.aggregate;
  if (aggregate && (aggregate.op === 'min' || aggregate.op === 'max')) {
    if (!aggregate.field || !NUMERIC_FIELDS.includes(aggregate.field)) {
      return {
        ok: false,
        reason: `aggregate ${aggregate.op} needs a numeric field (trl.current / trl.expected)`,
      };
    }
  }
  if (aggregate?.op === 'rank') {
    const field = aggregate.field;
    if (!field || !(NUMERIC_FIELDS.includes(field) || LIST_FIELDS.includes(field))) {
      return { ok: false, reason: 'aggregate rank needs a numeric field or a list field' };
    }
  }

  const query: StructuredQuery = {
    where,
    whereAny,
    ...(scenario ? { scenario } : {}),
    ...(notInScenario ? { notInScenario } : {}),
    ...(output.groupBy ? { groupBy: output.groupBy } : {}),
    ...(output.groupByPrefix ? { groupByPrefix: output.groupByPrefix } : {}),
    ...(aggregate ? { aggregate } : {}),
  };

  return { ok: true, query };
}

/**
 * Route a question: ask the model for the kind and the query, then validate
 * the query against the catalog.
 */
export async function routeQuery(
  question: string,
  catalog: Catalog,
  options: RouteOptions = {}
): Promise<RouteOutcome> {
  const forceStructured = options.forceStructured ?? false;
  // The state branch needs the live state both for the prompt's vocabulary
  // (services seen in runs, statuses on record) and to resolve the values the
  // model produces. The caller loads it (fresh, one read per question) and
  // passes it in; without it the router prompt does not advertise the state
  // branch and a model "state" answer is invalid.
  const twinState = options.twinState ?? null;
  const chatJson: ChatJsonFn =
    options.chatJson ??
    ((messages, schema, model) => getLLMGateway().chatJson(messages, schema, model));

  let raw: unknown;
  try {
    raw = await chatJson<unknown>(
      buildRouterMessages(
        question,
        buildVocabulary(catalog),
        forceStructured,
        twinState && !forceStructured ? stateVocabularySection(twinState) : undefined
      ),
      ROUTER_JSON_SCHEMA,
      options.model
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Structured retrieval: router call failed', { error: reason });
    return { kind: 'invalid', reason: `router call failed: ${reason}`, raw: undefined };
  }

  const parsed = routerSchema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    logger.warn('Structured retrieval: router output did not match the schema', { reason });
    return { kind: 'invalid', reason: `invalid router output: ${reason}`, raw };
  }

  const output = parsed.data;

  if (output.kind === 'state') {
    if (!twinState) {
      return {
        kind: 'invalid',
        reason: 'the route needs run state: answer with kind "structured" or "lookup"',
        raw,
      };
    }
    const resolution = resolveStateQuery(
      output.state ?? { where: [], whereAny: [] },
      catalog,
      twinState
    );
    if (!resolution.ok) {
      logger.warn('Structured retrieval: state query could not be resolved', {
        reason: resolution.reason,
      });
      return { kind: 'invalid', reason: resolution.reason, raw };
    }
    return { kind: 'state', query: resolution.query, raw };
  }

  if (forceStructured || output.kind === 'structured') {
    const resolved = resolveQuery(output, catalog);
    if (!resolved.ok) {
      logger.warn('Structured retrieval: query could not be resolved', { reason: resolved.reason });
      return { kind: 'invalid', reason: resolved.reason, raw };
    }
    return {
      kind: 'structured',
      query: resolved.query,
      ...(output.service ? { service: output.service } : {}),
      raw,
    };
  }

  return {
    kind: 'lookup',
    ...(output.service ? { service: output.service } : {}),
    raw,
  };
}

export { AGGREGATE_OPS, QUERY_FIELDS, QUERY_OPS };
