import { z } from 'zod';
import { getLLMGateway } from './index.js';
import { logger } from '../utils/logger.js';
import type { ChatMessage } from './types.js';
import {
  AGGREGATE_OPS,
  NUMERIC_FIELDS,
  QUERY_FIELDS,
  QUERY_OPS,
  aggregateSchema,
  buildVocabulary,
  predicateSchema,
  resolveScenarioTitle,
  resolveVocabularyValue,
  type Catalog,
  type CatalogVocabulary,
  type Predicate,
  type StructuredQuery,
} from './structured-retriever.js';

/**
 * Query router: decides between the vector branch (a factual lookup) and the
 * structured branch (a filter / count / group / join over the catalog), and
 * builds the structured query when the structured branch is chosen.
 *
 * The model only *fills in* a closed schema. Every value it produces is
 * resolved against the catalog's real vocabulary; an unmappable value makes
 * the route invalid so the caller can fall back to the vector branch.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const routerSchema = z.object({
  kind: z.enum(['lookup', 'structured']),
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
  add('scenarios', vocabulary.scenarios);
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
- lt / lte / gt / gte: numeric comparison, only on trl.current or trl.expected.`;

const MAPPING_RULES = [
  '- "partner infrastructure" means license = "N/A (Partner Infrastructure)".',
  '- "toolbox services" means repositoryTable = "INTACT_TOOLBOX".',
  '- Negation ("not", "excluding", "other than", "apart from") -> set "not": true on that predicate.',
  '- "how many" -> aggregate op "count"; "which/who/what" over a set -> "list".',
  '- "lowest/highest/least/most" -> "min"/"max" with the numeric field (trl.current / trl.expected).',
  '- "each", "per", "for every" -> groupBy the field named in the question.',
  '- "for each use case UC1 to UC5" -> groupBy "potentialUseCases" and groupByPrefix "UC".',
  '- "services in the <scenario>" -> "scenario" = the exact scenario title from the list.',
  '- "not used in the <scenario>" -> "notInScenario" = the exact scenario title from the list.',
  '- An "or" condition -> "whereAny": a list of AND-groups, at least one of which must hold.',
  '  Example: "not software-only web tools" is NOT(type = Software AND uiType = web), i.e.',
  '  whereAny: [[{field: "type", op: "ne", value: "Software"}], [{field: "uiType", op: "ne", value: "web"}]].',
].join('\n');

export function buildRouterMessages(
  question: string,
  vocabulary: CatalogVocabulary,
  forceStructured: boolean
): ChatMessage[] {
  const kindRules = forceStructured
    ? [
        'You must answer kind = "structured" with a complete query: this question always needs a',
        'filter, a count, a comparison, a group-by or a scenario join over the whole catalog.',
      ].join('\n')
    : [
        'kind = "lookup" when the question asks for one fact about one named service',
        '(e.g. "Who provides SECSAC?", "What is the current TRL of MMT-PROBE?").',
        'kind = "structured" when the question filters, counts, compares, groups or joins over the',
        'catalog (e.g. "Which services are in the Monitor category?", "How many services does X",',
        '"Which provider has the most services in Y?").',
      ].join('\n');

  const system = `You are the query router of a cybersecurity service catalog agent.
You translate a user question into a structured query over the service catalog.

Catalog vocabulary (use these exact strings, never invent one):
${formatVocabulary(vocabulary)}

Fields you may query on:
${FIELD_SEMANTICS}

${OPERATORS}

${MAPPING_RULES}

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
// Routing
// ---------------------------------------------------------------------------

export type RouteKind = 'lookup' | 'structured' | 'invalid';

export interface RouteOutcome {
  kind: RouteKind;
  query?: StructuredQuery;
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
  const numeric = NUMERIC_FIELDS.includes(field);
  const comparison = ['lt', 'lte', 'gt', 'gte'].includes(predicate.op);

  if (numeric) {
    const raw = Array.isArray(predicate.value) ? predicate.value[0] : predicate.value;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return { ok: false, reason: `field ${field} needs a numeric value` };
    }
    if (!comparison) {
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
 * Resolve the model's values against the catalog's real vocabulary.
 * Returns a cleaned query, or the reason it could not be resolved.
 */
export function resolveQuery(
  output: RouterOutput,
  catalog: Catalog
): { ok: true; query: StructuredQuery } | { ok: false; reason: string } {
  const vocabulary = buildVocabulary(catalog);
  const where: StructuredQuery['where'] = [];

  for (const predicate of output.where ?? []) {
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

  let scenario = output.scenario;
  if (scenario) {
    const resolution = resolveScenarioTitle(scenario, catalog);
    if (!resolution.ok) {
      return { ok: false, reason: resolution.reason };
    }
    scenario = resolution.title;
  }

  let notInScenario = output.notInScenario;
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
  const chatJson: ChatJsonFn =
    options.chatJson ??
    ((messages, schema, model) => getLLMGateway().chatJson(messages, schema, model));

  let raw: unknown;
  try {
    raw = await chatJson<unknown>(
      buildRouterMessages(question, buildVocabulary(catalog), forceStructured),
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
