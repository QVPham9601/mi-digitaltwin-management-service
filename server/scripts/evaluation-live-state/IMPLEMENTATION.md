# M1 live state — implementation instructions

You are implementing a feature in the SecSim digital-twin management platform (this
repository). Read `CLAUDE.md` and `docs/AGENT_ENV.md` first. Then read this whole file
before writing code. When something here conflicts with the code, the code wins: report
the conflict instead of guessing.

## 1. Goal

The chat agent (`server/src/agent/`) answers operator questions. Today it only sees the
**service catalog**, through two routes chosen by a router:

- `lookup` → vector retrieval over service embeddings;
- `structured` → a closed query language over the catalog
  (`structured-retriever.ts`, `query-router.ts`, wired in `agent-service.ts`
  `retrieveStructured`).

Add a third route, **`state`**, that answers questions about the twin's **run state**
from MongoDB **at answer time**, plus a **static baseline** that answers the same
questions from a snapshot index built once. Every state answer must carry **how old**
the information is and flag records that look **stale**.

## 2. Ground rules (non-negotiable)

- Work on a new branch `viet-live-state` created from `viet-dynamic-rag`. Commit with
  Conventional Commits (`feat(agent): …`). No AI attribution lines. Never
  `--no-verify`; fix hook failures. npm only, never bun.
- **Do not push** and **do not tag**. The user reviews, pushes and freezes.
- **Never modify `server/.env`.** Configure runs through per-process environment
  variables (Node `--env-file` lets the process env win).
- **Never write to the `intact` database.** Every script that writes must refuse to run
  unless the database name in `MONGODB_URI` is `intact_m1` (see §6). Reading `intact`
  is allowed. Do not re-seed any database.
- Do not pull models onto the shared DGX. Do not call paid APIs (Anthropic) at all.
- Do not write evaluation questions and do not run the evaluation (see `README.md`).
- Keep the existing behaviour of the `lookup` and `structured` routes unchanged: the
  existing 95 agent tests and the full `npm test` must still pass.

## 3. The data (already in MongoDB)

Read `server/src/models/Scenario.ts` and `server/src/models/ExecutionReport.ts`.

- `scenarios[].executions[]` (embedded, one per run): `executedAt`, `executedBy`,
  `status` (`pending | running | completed | failed`), `namespace`,
  `deployedServices[]` (`name`, `status`, `uiType`, …), `completedAt`, `durationMs`,
  `outcome` (`passed | failed | partial`), `observability`.
- `executionreports` (one per closed run, keyed by `scenarioId` + `executionId`):
  `outcome`, `startedAt`, `completedAt`, `durationMs`, `services[]` (`name`, `status`,
  `containers[]`), `metrics` (`services`, `containers.restarts`, `logs.errorLines`,
  `events.warnings`, `alerts.total`, `alerts.uniqueAttackers`, `alerts.byVerdict[]`),
  `alerts[]` (`service`, `timestamp`, `verdict`, `attacker`, `line`), `traffic[]`
  (`service`, `probe`, `up`, `availability`, `requestRate`, `errorRate`,
  `latencyP95Ms`), `partial`, `captureErrors`.

State of the local `intact` database on 2026-11-09: scenario "CI attack → MMT detection →
AI4SOAR block" has 25 executions and 24 reports; scenario "DDoS attack" has none. **One
execution has `status: running`, `executedAt` 2026-10-05T09:48Z, no `completedAt`** — its
namespace is almost certainly gone. That record is the fidelity test case: keep it.

## 4. What to build

### 4.1 `server/src/agent/state-retriever.ts` (pure core + a loader)

- `loadTwinState(now = new Date())` reads scenarios and reports **without caching**
  (contrast: the catalog has a 60 s cache in `structured-retriever.ts`; state must be
  read fresh on each question). Returns two flat tables plus `readAt`:
  - `RunRow`: `scenario`, `runId`, `runNumber` (1 = oldest per scenario), `executedAt`,
    `executedBy`, `status`, `outcome`, `completedAt`, `durationMs`, `ageMs`
    (`now - executedAt`), `alertsTotal`, `uniqueAttackers`, `attackers[]` (distinct),
    `errorLines`, `warnings`, `restarts`, `hasReport`, `partial`, `suspectStale`.
  - `RunServiceRow`: `scenario`, `runId`, `runNumber`, `service`, `status`, `up`,
    `availability`, `errorRate`, `requestRate`, `latencyP95Ms` (join of
    `deployedServices` / report `services` / report `traffic` by service name).
- `suspectStale = status in (pending, running) AND no completedAt AND ageMs >
AGENT_STALE_RUN_MS`. Add `AGENT_STALE_RUN_MS` to `config/env.ts` (Zod, default
  6 hours) and to `server/.env.example`.
- A pure `executeStateQuery(query, state)` over these rows. Reuse the **style** of the
  catalog query language: `where` (AND), `whereAny` (OR of AND-groups), `not`, the same
  operators, aggregates `list | count | min | max | rank`, `groupBy`. Add a `table`
  field (`runs | runServices`) and a `select` of the run: `latest | all | running` plus
  optional `runNumber`. Keep it closed and validated with Zod, like `structuredQuerySchema`.
- `formatStateResult(result, query, state)`: the first line is always
  `Twin state read live at <ISO readAt>.` Each run line shows `executedAt` and its age in
  words. A suspect-stale run gets the line
  `WARNING: status "<status>" recorded <N> days ago with no completion — this record may be
stale; say so in the answer and do not present the run as live.`
  Empty results: say so explicitly (reuse the near-miss idea of `formatRelaxations` only
  if it is cheap; it is not required).

### 4.2 Router (`query-router.ts`)

- `routerSchema.kind` gains `state`, with a `state` query object. Vocabulary for the
  prompt: scenario titles and aliases (already built), run statuses and outcomes, the
  service names that appear in runs, the state fields with one-line meanings.
- Prompt rules: questions about runs, executions, deployments, alerts, attackers,
  availability or health, "now / currently / last / latest / how many times" go to
  `state`; facts about a service's catalog entry stay `lookup` / `structured`.
- Resolve and validate values like `resolveQuery` does (unknown value → `invalid` with a
  reason, never silently accepted).

### 4.3 `agent-service.ts`

- In `auto` mode the `state` route builds the context from `formatStateResult`.
- Diagnostics: `routerKind: 'state'`, `stateQuery`, `stateRowCount`, `suspectStaleCount`,
  `stateReadAt`.
- New evaluation-only retrieval mode `state-static` (gated by `AGENT_EVAL_OPTIONS`, like
  the existing `retrievalMode` override in `agent.routes.ts`): retrieve the top-k run
  summaries from the static index (§4.4) by embedding similarity, using the embedding
  client the vector branch already uses. No live read.

### 4.4 Static baseline index

`server/scripts/evaluation-live-state/build-static-index.mjs`: reads the state once,
writes one plain-text summary per run (same facts as `RunRow` plus its services, with
`executedAt` but **no** "as of now" information) with its embedding to
`evaluation-live-state/static-index.json`, plus `builtAt`. The `state-static` mode reads
this file. It stands for the common practice of indexing operational data periodically.

### 4.5 Evaluation support scripts (no questions, no runs)

All under `server/scripts/evaluation-live-state/`:

- `copy-db.sh`: copies `intact` to `intact_m1` with
  `mongodump --uri mongodb://localhost:27017/intact --archive | mongorestore --archive
--nsFrom 'intact.*' --nsTo 'intact_m1.*' --drop`. Print the counts of scenarios,
  executions and reports in both databases afterwards.
- `apply-change.mjs --step=N`: deterministic changes to `intact_m1` only (refuse
  otherwise). Implement exactly these steps, each idempotent, each printing what it did:
  1. Add a closed run of the demo scenario with `executedAt` = 2026-11-10T09:00Z, outcome
     `failed`, CI-SIM `up: false`, availability 0.42, 37 alerts from one new attacker
     `10.244.0.99`, and its report.
  2. Add a run started 2026-11-10T10:00Z, `status: running`, no `completedAt` (a genuinely
     live run; fresh, so not suspect-stale when the clock is close).
  3. Mark the step-1 run's SECANOD service `failed` with 3 container restarts.
     The suspect-stale run from October is never touched.
- `dump-state.mjs`: writes `state-snapshot-<label>.json` with exactly the raw fields of §3
  (no derived values), for the ground truth.
- `ground_truth_state.py`: computes each question's expected answer from a state
  snapshot **in Python, independently of the TypeScript executor** (as
  `../evaluation-dynamic-rag/ground_truth.py` does for the catalog). Provide the spec
  machinery (filters, aggregates, latest run, suspect-stale rule with the same
  threshold) and two example specs; the evaluating agent writes the real specs from the
  user's questions.
- Extend `../evaluation-dynamic-rag/run-dynamic-eval.mjs` (or a copy) with conditions
  `V` (mode `vector`), `S` (mode `state-static`), `T` (mode `auto`).

## 5. Tests and acceptance

- Unit tests (vitest, next to the existing ones in `server/src/agent/__tests__/`):
  - state loader joins and `suspectStale` (fixed `now`; a run just under and just over
    the threshold);
  - `executeStateQuery`: latest, running, count, min/max, rank, group-by, OR, NOT,
    runServices table;
  - router: resolves a `state` output, rejects an unknown status / scenario / field;
  - `formatStateResult`: the read-live header, the stale warning, an empty result;
  - `agent-service`: `auto` routes a state question to the state context (stub the
    router with `chatJson`, as `query-router.test.ts` does).
- `npm run typecheck && npm run lint && npm test` pass from the repo root.
- Manual smoke test, local model only (`CHAT_PROVIDER=ollama CHAT_MODEL=qwen3:14b`, or the
  DGX with `CHAT_BASE_URL=http://192.168.0.132:8001/v1` if reachable), on `intact_m1`:
  1. "What was the outcome of the last run of the demo scenario?" in `auto` → the
     latest run's outcome, with its date.
  2. "Is the demo scenario running right now?" → mentions the October run as possibly
     stale, not as live.
  3. Build the static index, apply step 1, ask question 1 in `state-static` and in `auto`:
     static gives the old run, auto gives the new failed run.
     Record the three answers in `SMOKE.md` (question, mode, answer, diagnostics).

## 6. Safety check for every writing script

```js
const uri = process.env.MONGODB_URI ?? '';
if (new URL(uri).pathname.replace('/', '') !== 'intact_m1') {
  throw new Error('refusing to write: MONGODB_URI must point to the intact_m1 database');
}
```

## 7. When done

Stop and report to the user: the commits (hashes), test results, the `SMOKE.md` content,
anything in this document that turned out to be wrong or ambiguous, and open questions.
Do not start the evaluation.
