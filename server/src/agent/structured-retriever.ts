import { z } from 'zod';
import { Service } from '../models/Service.js';
import { Category } from '../models/Category.js';
import { Sector } from '../models/Sector.js';
import { Scenario } from '../models/Scenario.js';
import { logger } from '../utils/logger.js';

/**
 * Structured (dynamic) retrieval for the Boss Agent.
 *
 * The vector branch answers "which services look most like this text?". It
 * cannot answer "how many…", "which one has the highest TRL" or "every service
 * in category X" — no value of k fixes that, because the quantity is not in the
 * ranking. This module adds the missing branch: a small, closed query language
 * over the catalog's structured fields, executed in memory over the (small) set
 * of non-deprecated services.
 *
 * The executor is a pure function over plain objects so it can be unit-tested
 * without MongoDB (see `__tests__/structured-retriever.test.ts`).
 */

// ---------------------------------------------------------------------------
// Query language
// ---------------------------------------------------------------------------

export const QUERY_FIELDS = [
  'provider',
  'category',
  'sector',
  'type',
  'uiType',
  'trl.current',
  'trl.expected',
  'potentialUseCases',
  'repositoryTable',
  'standards',
  'license',
  'shortName',
] as const;
export type QueryField = (typeof QUERY_FIELDS)[number];

export const QUERY_OPS = ['eq', 'ne', 'in', 'contains', 'lt', 'lte', 'gt', 'gte'] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

export const AGGREGATE_OPS = ['list', 'count', 'min', 'max'] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];

/** Fields whose value is a number (the only ones min/max can be applied to). */
export const NUMERIC_FIELDS: QueryField[] = ['trl.current', 'trl.expected'];

export const predicateSchema = z.object({
  field: z.enum(QUERY_FIELDS),
  op: z.enum(QUERY_OPS),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
  /** Negate the predicate: `not: true` means "is not". */
  not: z.boolean().optional(),
});
export type Predicate = z.infer<typeof predicateSchema>;

export const aggregateSchema = z.object({
  op: z.enum(AGGREGATE_OPS),
  /** Required for min/max — the numeric field to compare. */
  field: z.enum(QUERY_FIELDS).optional(),
});
export type AggregateSpec = z.infer<typeof aggregateSchema>;

/**
 * A structured query over the catalog.
 *
 * `scenario` restricts the query to the services of a scenario's topology;
 * `notInScenario` does the opposite (used by "…are not used in the X
 * scenario"). `where` is an AND of predicates; `whereAny` adds a disjunction
 * (a list of AND-groups, of which at least one must hold) — needed for
 * questions like "not software-only web tools", i.e. NOT(type = Software AND
 * uiType = web). `groupBy` groups by a field (a list field groups by each of
 * its elements). `groupByPrefix` keeps only the group keys starting with a
 * prefix (the use-case groups "UC1" … "UC5").
 */
export const structuredQuerySchema = z.object({
  scenario: z.string().optional(),
  notInScenario: z.string().optional(),
  where: z.array(predicateSchema).default([]),
  whereAny: z.array(z.array(predicateSchema)).default([]),
  groupBy: z.enum(QUERY_FIELDS).optional(),
  groupByPrefix: z.string().optional(),
  aggregate: aggregateSchema.optional(),
});
export type StructuredQuery = z.infer<typeof structuredQuerySchema>;

// ---------------------------------------------------------------------------
// Catalog snapshot
// ---------------------------------------------------------------------------

/** One catalog service, flattened for querying (names resolved, no ObjectIds). */
export interface CatalogService {
  id: string;
  shortName: string;
  title: string;
  provider: string;
  category: string | null;
  sector: string | null;
  type: string;
  uiType: string;
  trlCurrent: number | null;
  trlExpected: number | null;
  potentialUseCases: string[];
  repositoryTable: string;
  standards: string[];
  license: string | null;
}

export interface CatalogScenario {
  title: string;
  /** shortNames of the services in the scenario's topology. */
  serviceShortNames: string[];
}

export interface Catalog {
  services: CatalogService[];
  scenarios: CatalogScenario[];
  loadedAt: number;
}

const CATALOG_TTL_MS = 60_000;

let cachedCatalog: Catalog | null = null;
let catalogPromise: Promise<Catalog> | null = null;

/**
 * Load the non-deprecated catalog into memory. The catalog is small (tens of
 * records), so it is cached and refreshed on a short TTL or on an explicit
 * invalidation (a catalog write or an index refresh).
 */
export async function getCatalog(force = false): Promise<Catalog> {
  if (!force && cachedCatalog && Date.now() - cachedCatalog.loadedAt < CATALOG_TTL_MS) {
    return cachedCatalog;
  }
  if (!force && catalogPromise) {
    return catalogPromise;
  }

  catalogPromise = (async () => {
    const [services, categories, sectors, scenarios] = await Promise.all([
      Service.find({ deprecated: { $ne: true } }).lean(),
      Category.find({}, { name: 1 }).lean(),
      Sector.find({}, { name: 1 }).lean(),
      Scenario.find({}, { title: 1, topology: 1 }).lean(),
    ]);

    const categoryNames = new Map(categories.map((c) => [String(c._id), c.name]));
    const sectorNames = new Map(sectors.map((s) => [String(s._id), s.name]));
    const shortNameById = new Map(services.map((s) => [String(s._id), s.shortName]));

    const catalog: Catalog = {
      services: services.map((service) => ({
        id: String(service._id),
        shortName: service.shortName,
        title: service.title,
        provider: service.provider,
        category: categoryNames.get(String(service.categoryId)) ?? null,
        sector: service.sectorId ? (sectorNames.get(String(service.sectorId)) ?? null) : null,
        type: service.type,
        uiType: service.uiType,
        trlCurrent: service.trl?.current ?? null,
        trlExpected: service.trl?.expected ?? null,
        potentialUseCases: service.potentialUseCases ?? [],
        repositoryTable: service.repositoryTable,
        standards: service.standards ?? [],
        license: service.license ?? null,
      })),
      scenarios: scenarios.map((scenario) => ({
        title: scenario.title,
        serviceShortNames: (scenario.topology?.nodes ?? [])
          .map((node) => shortNameById.get(String(node.serviceId ?? node.data?.serviceId ?? '')))
          .filter((name): name is string => Boolean(name)),
      })),
      loadedAt: Date.now(),
    };

    cachedCatalog = catalog;
    return catalog;
  })();

  try {
    return await catalogPromise;
  } finally {
    catalogPromise = null;
  }
}

/** Drop the cached catalog — called after a catalog write or an index refresh. */
export function invalidateCatalog(): void {
  cachedCatalog = null;
  catalogPromise = null;
}

// ---------------------------------------------------------------------------
// Vocabulary (the closed value sets the router must use)
// ---------------------------------------------------------------------------

export interface CatalogVocabulary {
  providers: string[];
  categories: string[];
  sectors: string[];
  types: string[];
  uiTypes: string[];
  repositoryTables: string[];
  licenses: string[];
  standards: string[];
  useCases: string[];
  scenarios: string[];
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)),
  ]
    .map((v) => v.trim())
    .sort((a, b) => a.localeCompare(b));
}

export function buildVocabulary(catalog: Catalog): CatalogVocabulary {
  return {
    providers: uniqueSorted(catalog.services.map((s) => s.provider)),
    categories: uniqueSorted(catalog.services.map((s) => s.category)),
    sectors: uniqueSorted(catalog.services.map((s) => s.sector)),
    types: uniqueSorted(catalog.services.map((s) => s.type)),
    uiTypes: uniqueSorted(catalog.services.map((s) => s.uiType)),
    repositoryTables: uniqueSorted(catalog.services.map((s) => s.repositoryTable)),
    licenses: uniqueSorted(catalog.services.map((s) => s.license)),
    standards: uniqueSorted(catalog.services.flatMap((s) => s.standards)),
    useCases: uniqueSorted(catalog.services.flatMap((s) => s.potentialUseCases)),
    scenarios: uniqueSorted(catalog.scenarios.map((s) => s.title)),
  };
}

/** The vocabulary per query field — the values a predicate may use. */
export function vocabularyForField(field: QueryField, vocabulary: CatalogVocabulary): string[] {
  switch (field) {
    case 'provider':
      return vocabulary.providers;
    case 'category':
      return vocabulary.categories;
    case 'sector':
      return vocabulary.sectors;
    case 'type':
      return vocabulary.types;
    case 'uiType':
      return vocabulary.uiTypes;
    case 'repositoryTable':
      return vocabulary.repositoryTables;
    case 'license':
      return vocabulary.licenses;
    case 'standards':
      return vocabulary.standards;
    case 'potentialUseCases':
      return vocabulary.useCases;
    case 'shortName':
      return [];
    case 'trl.current':
    case 'trl.expected':
      return [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Value resolution (keep the generated query inside the real vocabulary)
// ---------------------------------------------------------------------------

export type ResolutionResult = { ok: true; value: string } | { ok: false; reason: string };

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Map a model-generated value onto the catalog's vocabulary.
 *
 * 1. exact match (case/space-insensitive),
 * 2. unique substring match in either direction ("SINTEF" → "SINTEF (STF)").
 *
 * Anything else is rejected: an unmapped value would silently produce an
 * empty (and wrong) result set, so the caller falls back to the vector branch.
 */
export function resolveVocabularyValue(
  field: QueryField,
  value: string,
  vocabulary: CatalogVocabulary
): ResolutionResult {
  const candidates = vocabularyForField(field, vocabulary);
  if (candidates.length === 0) {
    return { ok: true, value };
  }

  const needle = normalise(value);
  if (!needle) {
    return { ok: false, reason: `empty value for field ${field}` };
  }

  const exact = candidates.find((candidate) => normalise(candidate) === needle);
  if (exact) {
    return { ok: true, value: exact };
  }

  const partial = candidates.filter(
    (candidate) => normalise(candidate).includes(needle) || needle.includes(normalise(candidate))
  );
  if (partial.length === 1) {
    return { ok: true, value: partial[0] };
  }

  return {
    ok: false,
    reason: `value "${value}" is not in the catalog vocabulary for ${field}`,
  };
}

// ---------------------------------------------------------------------------
// Scenario resolution
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'in',
  'scenario',
  'scenarios',
  'service',
  'services',
  'which',
  'what',
  'who',
  'for',
  'to',
  'by',
  'are',
  'is',
  'that',
  'this',
  'used',
  'uses',
  'use',
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/** Crude stemmer — enough to match "detect" against "detection". */
function stem(token: string): string {
  return token
    .replace(/(ations|ation|ions|ion|ing|ers|er|ed|es|s)$/i, '')
    .replace(/(detect|respond|attack)$/i, '$1');
}

export type ScenarioResolution = { ok: true; title: string } | { ok: false; reason: string };

/**
 * Map a (possibly informal) scenario reference onto a real scenario title.
 *
 * The evaluation set refers to the demo scenario as "the attack-detect-respond
 * scenario" while its title is "CI attack → MMT detection → AI4SOAR block", so
 * an exact match is not enough: token overlap decides, with a 50% threshold and
 * a unique winner.
 */
export function resolveScenarioTitle(reference: string, catalog: Catalog): ScenarioResolution {
  const titles = catalog.scenarios.map((s) => s.title);
  if (titles.length === 0) {
    return { ok: false, reason: 'the catalog has no scenarios' };
  }

  const needle = normalise(reference);
  const exact = titles.find((title) => normalise(title) === needle);
  if (exact) {
    return { ok: true, title: exact };
  }

  const queryTokens = tokenise(reference).map(stem);
  if (queryTokens.length === 0) {
    return { ok: false, reason: `scenario "${reference}" could not be resolved` };
  }

  const scored = titles
    .map((title) => {
      const titleTokens = new Set(tokenise(title).map(stem));
      const hits = queryTokens.filter((token) => titleTokens.has(token)).length;
      return { title, score: hits / queryTokens.length };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (best && best.score >= 0.5 && (!runnerUp || best.score > runnerUp.score)) {
    return { ok: true, title: best.title };
  }

  return { ok: false, reason: `scenario "${reference}" could not be resolved` };
}

// ---------------------------------------------------------------------------
// Executor (pure)
// ---------------------------------------------------------------------------

export interface StructuredGroup {
  key: string;
  services: string[];
  count: number;
}

export interface StructuredResult {
  /** Every service matching the `where` clauses (and the scenario filter). */
  services: CatalogService[];
  matchCount: number;
  /** Present when the query groups by a field. */
  groups?: StructuredGroup[];
  /** The aggregate value (count, min, max). */
  value?: number | string | null;
  /** The services holding the aggregate value (min/max). */
  valueServices?: string[];
  /** The group key(s) with the most members — answers "which provider has most…". */
  topGroupKeys?: string[];
  topGroupCount?: number;
}

type FieldValue = string | number | string[] | null;

const FIELD_ACCESSORS: Record<QueryField, (service: CatalogService) => FieldValue> = {
  provider: (s) => s.provider,
  category: (s) => s.category,
  sector: (s) => s.sector,
  type: (s) => s.type,
  uiType: (s) => s.uiType,
  'trl.current': (s) => s.trlCurrent,
  'trl.expected': (s) => s.trlExpected,
  potentialUseCases: (s) => s.potentialUseCases,
  repositoryTable: (s) => s.repositoryTable,
  standards: (s) => s.standards,
  license: (s) => s.license,
  shortName: (s) => s.shortName,
};

function equalsValue(actual: FieldValue, expected: unknown): boolean {
  if (actual === null || actual === undefined) {
    return false;
  }
  if (typeof actual === 'number') {
    return typeof expected === 'number' ? actual === expected : Number(expected) === actual;
  }
  if (typeof actual === 'string') {
    return typeof expected === 'string' && normalise(actual) === normalise(expected);
  }
  // List field: membership (exact, case-insensitive).
  if (Array.isArray(actual)) {
    const wanted = Array.isArray(expected) ? expected : [expected];
    return wanted.some(
      (candidate) =>
        typeof candidate === 'string' &&
        actual.some((element) => normalise(element) === normalise(candidate))
    );
  }
  return false;
}

function containsValue(actual: FieldValue, expected: unknown): boolean {
  if (actual === null || actual === undefined) {
    return false;
  }
  const needle = normalise(String(expected));
  if (!needle) {
    return false;
  }
  if (Array.isArray(actual)) {
    return actual.some((element) => {
      const value = normalise(element);
      return value === needle || value.includes(needle);
    });
  }
  if (typeof actual === 'number') {
    return normalise(String(actual)) === needle;
  }
  return normalise(actual).includes(needle);
}

function compareNumeric(actual: FieldValue, expected: unknown, op: QueryOp): boolean {
  if (typeof actual !== 'number' || actual === null) {
    return false;
  }
  const wanted = typeof expected === 'number' ? expected : Number(expected);
  if (Number.isNaN(wanted)) {
    return false;
  }
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

/** Does one service satisfy one predicate (before the `not` flag)? */
export function matchesPredicate(service: CatalogService, predicate: Predicate): boolean {
  const actual = FIELD_ACCESSORS[predicate.field](service);
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
    default:
      outcome = false;
  }

  return predicate.not ? !outcome : outcome;
}

function groupKeysFor(service: CatalogService, field: QueryField): string[] {
  const value = FIELD_ACCESSORS[field](service);
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string' && entry.length > 0);
  }
  return [String(value)];
}

/**
 * Execute a structured query over the catalog. Pure: no MongoDB, no LLM.
 *
 * `query.scenario` restricts the query to a scenario's services and
 * `query.notInScenario` excludes them.
 */
export function executeQuery(
  query: StructuredQuery,
  services: CatalogService[],
  scenarios: CatalogScenario[]
): StructuredResult {
  let rows = services;

  if (query.scenario) {
    const scenario = scenarios.find((s) => s.title === query.scenario);
    const members = new Set(scenario?.serviceShortNames ?? []);
    rows = rows.filter((service) => members.has(service.shortName));
  }
  if (query.notInScenario) {
    const scenario = scenarios.find((s) => s.title === query.notInScenario);
    const members = new Set(scenario?.serviceShortNames ?? []);
    rows = rows.filter((service) => !members.has(service.shortName));
  }

  const where = query.where ?? [];
  const whereAny = query.whereAny ?? [];
  rows = rows.filter(
    (service) =>
      where.every((predicate) => matchesPredicate(service, predicate)) &&
      (whereAny.length === 0 ||
        whereAny.some((group) => group.every((predicate) => matchesPredicate(service, predicate))))
  );
  rows = [...rows].sort((a, b) => a.shortName.localeCompare(b.shortName));

  const result: StructuredResult = { services: rows, matchCount: rows.length };

  if (query.groupBy) {
    const groups = new Map<string, string[]>();
    for (const service of rows) {
      for (const key of groupKeysFor(service, query.groupBy)) {
        if (query.groupByPrefix && !key.startsWith(query.groupByPrefix)) {
          continue;
        }
        const bucket = groups.get(key) ?? [];
        bucket.push(service.shortName);
        groups.set(key, bucket);
      }
    }
    const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    result.groups = ordered.map(([key, members]) => ({
      key,
      services: [...members].sort((a, b) => a.localeCompare(b)),
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

  const aggregate = query.aggregate ?? { op: 'list' as AggregateOp };
  if (aggregate.op === 'count') {
    result.value = rows.length;
    return result;
  }
  if (aggregate.op === 'min' || aggregate.op === 'max') {
    const field = aggregate.field;
    if (!field || !NUMERIC_FIELDS.includes(field)) {
      return result;
    }
    const values = rows
      .map((service) => FIELD_ACCESSORS[field](service))
      .filter((value): value is number => typeof value === 'number');
    if (values.length === 0) {
      return result;
    }
    const best = aggregate.op === 'min' ? Math.min(...values) : Math.max(...values);
    result.value = best;
    result.valueServices = rows
      .filter((service) => FIELD_ACCESSORS[field](service) === best)
      .map((service) => service.shortName);
    return result;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

function formatPredicate(predicate: Predicate): string {
  const operator = predicate.not ? `NOT(${predicate.op})` : predicate.op;
  const value = Array.isArray(predicate.value)
    ? `[${predicate.value.join(', ')}]`
    : String(predicate.value);
  return `${predicate.field} ${operator} ${value}`;
}

/** The query in words — shown to the model so it can check the interpretation. */
export function describeQuery(query: StructuredQuery): string {
  const parts: string[] = [];
  if (query.scenario) {
    parts.push(`in scenario "${query.scenario}"`);
  }
  if (query.notInScenario) {
    parts.push(`not in scenario "${query.notInScenario}"`);
  }
  const where = query.where ?? [];
  if (where.length > 0) {
    parts.push(where.map(formatPredicate).join(' AND '));
  }
  const whereAny = query.whereAny ?? [];
  if (whereAny.length > 0) {
    parts.push(
      `any of (${whereAny.map((group) => group.map(formatPredicate).join(' AND ')).join(' | ')})`
    );
  }
  if (query.groupBy) {
    const prefix = query.groupByPrefix ? ` (keys starting with "${query.groupByPrefix}")` : '';
    parts.push(`grouped by ${query.groupBy}${prefix}`);
  }
  const aggregate = query.aggregate?.op ?? 'list';
  const field = query.aggregate?.field ? ` on ${query.aggregate.field}` : '';
  parts.push(`aggregate: ${aggregate}${field}`);
  return parts.join('; ');
}

function serviceDetailLines(service: CatalogService, query: StructuredQuery): string {
  const used = new Set((query.where ?? []).map((predicate) => predicate.field));
  const lines: string[] = [];
  lines.push(`provider: ${service.provider}`);
  if (service.category) {
    lines.push(`category: ${service.category}`);
  }
  if (service.sector) {
    lines.push(`sector: ${service.sector}`);
  }
  lines.push(`type: ${service.type}`);
  lines.push(`uiType: ${service.uiType}`);
  if (service.trlCurrent !== null || service.trlExpected !== null) {
    lines.push(
      `trl: current=${service.trlCurrent ?? 'n/a'}, expected=${service.trlExpected ?? 'n/a'}`
    );
  }
  if (used.has('license')) {
    lines.push(`license: ${service.license ?? 'n/a'}`);
  }
  if (used.has('repositoryTable')) {
    lines.push(`repositoryTable: ${service.repositoryTable}`);
  }
  if (used.has('standards') && service.standards.length > 0) {
    lines.push(`standards: ${service.standards.join(', ')}`);
  }
  if (used.has('potentialUseCases') && service.potentialUseCases.length > 0) {
    lines.push(`potentialUseCases: ${service.potentialUseCases.join(' | ')}`);
  }
  return lines.join(' | ');
}

/**
 * Format the structured result for the prompt. Mirrors the source-citation
 * style of `RAGRetriever.formatContextForPrompt` so the two branches are
 * indistinguishable to the model apart from their content.
 */
export function formatStructuredResult(result: StructuredResult, query: StructuredQuery): string {
  const lines: string[] = [];
  lines.push(`Structured query: ${describeQuery(query)}`);

  if (result.groups && result.groups.length > 0) {
    lines.push('');
    lines.push(`Grouped by ${query.groupBy} (${result.groups.length} groups):`);
    for (const group of result.groups) {
      lines.push(`- ${group.key}: ${group.count} — ${group.services.join(', ')}`);
    }
    if (result.topGroupKeys && result.topGroupKeys.length > 0) {
      lines.push(
        `Group with the most members: ${result.topGroupKeys.join(', ')} (${result.topGroupCount})`
      );
    }
    if (query.aggregate?.op === 'count') {
      lines.push(`Total in the largest group: ${result.value}`);
    }
    return lines.join('\n');
  }

  if (query.aggregate?.op === 'count') {
    lines.push(`Result: ${result.value} matching services.`);
  } else if (query.aggregate?.op === 'min' || query.aggregate?.op === 'max') {
    if (result.value === undefined) {
      lines.push('Result: no matching service carries a comparable value.');
    } else {
      lines.push(
        `Result: ${query.aggregate.op} ${query.aggregate.field} = ${result.value} (${
          (result.valueServices ?? []).join(', ') || 'none'
        }).`
      );
    }
  } else if (result.matchCount === 0) {
    lines.push('Result: no service matches this query.');
  } else {
    lines.push(`Result: ${result.matchCount} matching services.`);
  }

  if (result.services.length > 0) {
    lines.push('');
    result.services.forEach((service, index) => {
      lines.push(`[${index + 1}] ${service.shortName} - ${service.title}`);
      lines.push(serviceDetailLines(service, query));
    });
  }

  return lines.join('\n');
}

/** Load the catalog and log a failure without breaking the request. */
export async function loadCatalogSafely(): Promise<Catalog | null> {
  try {
    return await getCatalog();
  } catch (error) {
    logger.warn('Structured retrieval: failed to load the catalog', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
