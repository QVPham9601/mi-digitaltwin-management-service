# Implementation brief — Dynamic (structured) retrieval for the Boss Agent

_Instructions for an implementing agent. Read the research note first:
`docs/architecture/dynamic-retrieval-research-note.md` (why, prior art, design)._

## 0. Goal in one sentence

Add a **structured retrieval branch** that answers aggregate / constraint questions
by querying the catalog's fields (filter, negation, comparison, count/min/max,
group-by, one scenario join), route questions between it and the existing vector
retrieval, and **evaluate** it against the current fixed top-k = 4 retrieval.

The research question being tested: _does routing aggregate/constraint questions
to a structured query over the digital twin's catalog recover the questions that
similarity retrieval cannot answer, without degrading simple lookups?_

## 1. Ground rules (hard)

- Branch: create `viet-dynamic-rag` from `viet-monitor-agent`. Do not work on `main`.
- Read `CLAUDE.md` and `docs/AGENT_ENV.md` first. npm only (`npm ci`), never bun.
  Node ≥ 22.12 (`nvm use 22.23.3` if the default is older).
- Before each commit: `npm run typecheck && npm run lint && npm test`. Never
  `--no-verify`. Conventional Commits. **No `Co-Authored-By` / AI attribution
  lines in commit messages.** Do not push unless the user asks.
- Do not change the Monitor agent (`server/src/agent/monitor/`) or the LLM
  provider code beyond what this brief needs. Do not edit secrets in `.env`.
- Default behaviour must stay unchanged: with no new env var set, chat uses the
  current vector retrieval exactly as today.
- If something in this brief is wrong about the code or data, stop and report it;
  do not work around it silently.

## 2. Current code (where to plug in)

- `server/src/agent/agent-service.ts` (~line 68–75): if the intent classifier says
  it is a service query, `retriever.retrieveSimilar(trimmedMessage, 4)` → this is
  the only retrieval call to route.
- `server/src/agent/rag-retriever.ts`: `RAGRetriever` (vector search,
  `formatContextForPrompt`), `IntentClassifier`, and the catalog context loader
  (category / sector name maps). Deprecated services are already excluded from the
  index — exclude them from the structured branch too.
- `server/src/agent/llm-gateway.ts`: `chatJson<T>(messages, schema, model?)` returns
  JSON constrained by a JSON schema (works on Ollama and on OpenAI-compatible
  servers). Use it for query generation. See `monitor/triage.ts` for the pattern
  (zod schema → `z.toJSONSchema`, then `schema.parse` on the result).
- Data (`server/src/models/`):
  - `Service`: `shortName`, `title`, `provider`, `categoryId` → `Category.name`,
    `sectorId` → `Sector.name`, `type` ('Software' | 'Hardware' |
    'Software/Hardware'), `uiType` ('web' | 'terminal' | 'both'),
    `trl.current`, `trl.expected`, `potentialUseCases: string[]` (e.g.
    `"UC1 - Telecom Software Development Life Cycle"`), `repositoryTable`
    ('INTACT_TOOLBOX' | 'OTHER_SERVICES' — the latter = partner infrastructure),
    `standards: string[]`, `license`.
  - `Scenario.topology.nodes[].serviceId` → which services a scenario contains.

## 3. Design to implement

### 3.1 Query language (zod schema → JSON schema)

A small, closed language; the LLM only fills it in:

```ts
{
  scenario?: string,            // optional join: restrict to services in this scenario's topology
  where: {                      // AND of predicates (empty = all services)
    field: Field, op: 'eq'|'ne'|'in'|'contains'|'lt'|'lte'|'gt'|'gte', value: string|number|string[],
    not?: boolean
  }[],
  groupBy?: Field,              // a list field (potentialUseCases, standards) groups by each element
  aggregate?: { op: 'list'|'count'|'min'|'max', field?: Field },   // min/max need a numeric field
}
Field = 'provider'|'category'|'sector'|'type'|'uiType'|'trl.current'|'trl.expected'
      |'potentialUseCases'|'repositoryTable'|'standards'|'license'|'shortName'
```

- **Constrain values to the real catalog vocabulary.** At startup (and when the
  catalog changes), collect the distinct providers, category names, sector names,
  use-case strings and scenario titles, and put them in the prompt (and, where the
  JSON schema allows, as enums). This is the main mitigation for mis-mapped values
  ("Ops Services" must match a real category name).
- Add a `kind` field so one `chatJson` call both routes and builds the query:
  `{ kind: 'lookup' } | { kind: 'structured', query: {...} }`.

### 3.2 Executor (pure, unit-tested)

- New module, e.g. `server/src/agent/structured-retriever.ts`.
- Load the non-deprecated services once (with category/sector names resolved) into
  an in-memory array; the catalog is small (tens of records). Refresh when the
  embedding index is refreshed / a service changes.
- `executeQuery(query, services, scenarios)` → `{ groups?: {key, services}[],
value?: number|string, services: ServiceSummary[] }`. Pure function over plain
  objects so it can be unit-tested without Mongo.
- Format the result for the prompt: state the query in words, then the result
  (count / min / max / groups), then the matching services with the fields used.
  Keep the existing source-citation style of `formatContextForPrompt`.

### 3.3 Routing

- New env var `RAG_RETRIEVAL_MODE`: `vector` (default, current behaviour) |
  `structured` (always structured, for evaluation) | `auto` (route).
- `auto`: when the intent classifier says "service query", call the router
  (`chatJson`, the `kind` schema above). `lookup` → current vector path;
  `structured` → executor.
- Fallback: invalid query, execution error or empty result → vector path, and log
  the reason (needed for the evaluation).
- Optional, only after the above works: the "answer-sufficiency" fallback from the
  research note (§3.4) — skip unless time allows.
- For evaluation, allow a per-request override of the mode. Gate it behind an env
  flag so normal servers cannot change it from the client (follow the
  `AGENT_EVAL_OPTIONS` / `promptMode` pattern on branch `viet-model-comparison` if
  you bring it over).

### 3.4 Tests

Unit tests in `server/src/agent/__tests__/` for: each operator, `not`, group-by on
a list field, count/min/max, the scenario join, deprecated exclusion, and the
fallback paths of the router (mock `chatJson`).

## 4. Evaluation

### 4.1 Harness

The evaluation harness lives on `origin/viet-model-comparison` in
`server/scripts/evaluation-phase-1/` (`run-eval.ts`, `hardgrade.py`, `stats.py`,
`questions-hard.json`, `questions-secassured.json`). Bring over only what you
need and check its dependencies (it may rely on server options that exist only on
that branch). Record what you brought over in the report.

### 4.2 Question sets

1. **Pilot** — the 6 failing questions in `questions-hard.json` (categories
   `constraint` and `multi-hop`). Their stored ground truths may be stale (the
   attack-detect-respond scenario now uses CI-SIM, not HTTP-SIM):
   **recompute every ground truth from the current database** and note changes.
2. **New aggregate/constraint set — already written, do not rewrite it:**
   `server/scripts/evaluation-dynamic-rag/` holds 30 structured questions (filter,
   negation, comparison, count, min/max, group-by, multi-constraint, scenario
   join) + 6 single-service lookup controls (`expectedRoute: "lookup"`), in
   `questions-dynamic-rag.json` (review copy: `QUESTIONS.md`).
   - Ground truth is computed by `ground_truth.py` (Python, independent of the
     executor) from `catalog-snapshot.json`, dumped by `dump-catalog.mjs`. Before
     the evaluation, **re-dump and recompute** against the database you evaluate
     on, and diff the answers against the committed ones.
   - "Partner infrastructure" = `license === 'N/A (Partner Infrastructure)'`
     (not `repositoryTable === 'OTHER_SERVICES'`, which also contains KAFKA).
     The router/query prompt must be told this mapping.
   - **Do not re-seed the database for this round.** Use it as it is, so the run
     matches the reviewed snapshot. Known, accepted drift: the database has MAG
     `uiType: 'web'` while the seed says `'terminal'` (DR27 depends on it), and
     KAFKA's provider/interface may be outdated (DR19, DR27, DR28). These are
     updated in a later round by re-dumping and recomputing the ground truth.
   - Before running, re-dump and recompute anyway as a check: the answers must be
     identical to the committed ones. If they differ, stop and report.
3. **Regression** — the main set `questions-secassured.json` (factual,
   comparative, adversarial, casual), to check that `auto` does not degrade what
   already works.

### 4.3 Conditions and controls

| Condition      | Retrieval                   |
| -------------- | --------------------------- |
| A — baseline   | `vector`, top-k = 4 (today) |
| B — structured | `structured` (forced)       |
| C — routed     | `auto`                      |

- Same generator, embeddings, prompts and temperature across conditions; only the
  retrieval mode changes. Generator: local `qwen3:14b` (comparable with the
  earlier 0/9 result). If on the office network, optionally repeat C with the DGX
  model (`montimage-dgx-spark`, `CHAT_DISABLE_THINKING=true`).
- 3 repetitions per question. Disable LLM conversation titles
  (`AGENT_LLM_TITLES=false`) if available, so latency is not inflated.

### 4.4 Metrics

- Answer correctness vs ground truth (auto-graded where the answer is a set or a
  number; otherwise graded by rubric and flagged for human check).
- Retrieved-set precision / recall vs the ground-truth service set.
- Router accuracy (C): `structured` chosen for aggregate questions, `lookup` for
  factual ones.
- Query validity: share of generated queries that parse, execute and use only real
  vocabulary values; and the fallback rate with reasons.
- Latency (median), and regression on the main set.
- 95% Wilson intervals (`stats.py`) and run-to-run agreement.

### 4.5 Deliverables

- Code + tests on `viet-dynamic-rag`.
- Question sets and the ground-truth script in
  `server/scripts/evaluation-phase-1/` (or a new `evaluation-dynamic-rag/`).
- Raw results (JSON/CSV) and `REPORT-<date>-dynamic-rag.md` with: what was built,
  conditions table, results per question category with CIs, router accuracy,
  failure analysis (which query types fail, wrong vocabulary, wrong operator,
  fallback), threats to validity, and anything in this brief that turned out wrong.

## 5. Suggested order and stopping points

1. Query schema + executor + unit tests.
2. Pilot with `structured` on the 6 questions (recomputed ground truths).
   **Stop and report** the pilot result before building the full set — if it does
   not clearly beat the baseline, the design needs discussion first.
3. Router (`auto`) + fallback + tests.
4. New question set + ground-truth script; full evaluation A/B/C + regression.
5. Report.
