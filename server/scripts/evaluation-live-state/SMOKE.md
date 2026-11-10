# M1 live state: smoke checks (IMPLEMENTATION.md §5)

Run on 2026-11-09/10 against a fresh `intact_m1` copy (`copy-db.sh --drop`, then
`build-static-index.mjs`, 25 run summaries). Checks 1–2 ran before any change;
check 3 ran after `apply-change.mjs --step=1`. Helper: `smoke-ask.mjs`.

Models:

- the local `qwen3:14b` (Ollama, port 3101), the model the checks are specified for;
- Claude Opus 5.5 (port 3100), a reference run only to tell model errors from pipeline
  errors. It is not part of the system. About 6 questions, under $0.50 in total.
- The DGX 35B was not reachable (out of office).

## Results

| #   | question (mode)                                                     | 14B                                      | Opus (reference)                         |
| --- | ------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| 1   | "What was the outcome of the last run of the demo scenario?" (auto) | **fail**: router query invalid, fallback | pass: run #25, passed, 2026-10-05        |
| 2   | "Is the demo scenario running right now?" (auto)                    | pass: run #17 "may be stale"             | pass: run #17 "probably not, stale"      |
| 3   | question 1 after step 1, `state-static`                             | pass: old run #4 (passed), snapshot note | pass: old run #4 (passed), snapshot note |
| 3   | question 1 after step 1, `auto`                                     | **fail**: same router error as check 1   | pass: new run #26, failed, 2026-11-10    |

### Diagnostics

- **1, 14B** (3 of 3 tries): `route=fallback router=invalid`,
  `field runNumber needs a numeric value`. Raw router output: `kind: "state"`,
  `select: "latest"` (correct), plus a predicate `runNumber eq "latest"` and an
  unrequested OR filter (`status = completed` or `outcome = passed`). The 14B also fills
  the catalog fields (`where`, `groupBy`, `aggregate`) of a state question. Even
  without the `runNumber` error, the OR filter would drop a failed latest run. This is
  a model limitation (the router prompt states `select: "latest"` for "last run"), so
  it was recorded and not patched around.
- **1, Opus**: `route=state`, query
  `{scenario: "CI attack → MMT detection → AI4SOAR block", select: "latest", aggregate: list outcome}`,
  `stateMatchCount=1`, `suspectStaleCount=1`.
- **2, 14B**: `route=state`, `select: "running"`, `stateMatchCount=1`, `suspectStaleCount=1`.
  Answer: "The last recorded run (#17) was marked as "running" 35 days ago … This record
  may be stale, and there is no indication of current activity."
- **2, Opus**: `route=state`, `select: "running"`. Answer: "Probably not. The twin state
  shows the scenario's last run as "running," but that record is likely stale."
- **3 static** (both): `route=state-static`, snapshot `builtAt 2026-11-09T19:31:09Z`. The
  top-k retrieval returns run #4 (2026-10-02), not even the latest pre-change run (#25).
  Both answers add that the snapshot may be out of date.
- **3 auto, Opus**: `route=state`, same query as check 1. Answer: "run #26 … completed
  but failed … Executed 2026-11-10 09:00 UTC … Attacker: 10.244.0.99".

## Bugs found and fixed during the checks

1. **Router schema rejected by Anthropic (numeric bounds).** `runNumber`
   (`z.number().int().positive()`) put `exclusiveMinimum`/`maximum` in the JSON schema.
   The API answered 400, so with Anthropic every `auto` question (catalog questions
   included) fell back to the vector branch. Ollama ignores these keywords, so the 14B
   did not show it. Fix: `stripJsonSchemaMeta` drops numeric and length bounds
   recursively; `routerSchema` still enforces them when parsing.
2. **Router schema "too complex" for Anthropic.** With the state sub-object the schema
   exceeds Anthropic's structured-output limit. Probes showed that removing the state
   query's `whereAny` (OR groups) is enough. Fix: `ROUTER_JSON_SCHEMA` no longer offers
   state `whereAny`; the prompt maps a one-field "or" to op `in`. The executor and the
   parser still accept `whereAny`. Cost: a run-state OR across two different fields
   cannot be expressed by the router.
3. **`apply-change.mjs` skipped a step after a re-copy.** `once()` trusted the marker
   first, and `copy-db.sh --drop` keeps the uncopied marker collection, so step 1
   printed "already applied" on a fresh copy without the change. Fix: the database
   content (`present()`) decides; the marker is only a record.

## Open points for the evaluation

- The 14B fails the main "latest run" question in `auto`. Measure it as is. The DGX
  35B has not been smoke-tested yet; run checks 1–3 on it before the freeze if possible.
- Static retrieval returns an arbitrary old run rather than the latest snapshot run.
  That is the baseline's expected weakness (top-k over run summaries), not a bug.
- `apply-change.mjs` steps 1–3 use dates of 2026-11-10. Step 2's "fresh" running run
  is only fresh within `AGENT_STALE_RUN_MS` (6 h) of 10:00Z that day, so its ground
  truth depends on when the evaluation runs. Re-date the steps relative to the run day
  before t1.
