# Dynamic retrieval over the digital twin's catalog — evaluation, 2026-10-22

## Question

Can the Boss Agent answer **aggregate and multi-constraint questions about the
digital twin** — "which provider has the most…", "how many…", "which … are not …",
"services of this scenario" — by querying the twin's **structure** instead of
reading the 4 most similar catalog entries, without degrading the questions that
already work? Design and prior art: `docs/architecture/dynamic-retrieval-research-note.md`.

## Method

- **Only the retrieval strategy changes**; generator, embeddings
  (`mxbai-embed-large`, same 32-service index), prompts and temperature are fixed.

| Condition      | Retrieval                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| A — baseline   | vector, top-k = 4 (current behaviour)                                                                             |
| B — structured | the model writes a structured query over the catalog fields; the executor runs it on the whole catalog (forced)   |
| C — routed     | the router chooses lookup (A's path) or structured per question; invalid / failing / empty queries fall back to A |

- **Questions.** 30 aggregate / constraint questions (filter, negation, numeric
  comparison, count, min/max, group-by, multi-constraint, scenario join) + 6
  single-service lookup controls (`questions-dynamic-rag.json`). Ground truth is
  computed by `ground_truth.py` from a catalog dump, independently of the code
  under test; it was re-computed before the run and unchanged. Regression set: the
  30-question main set (factual, comparative, adversarial, casual).
- **Models.** `montimage-dgx-spark` (Qwen3.6-35B-A3B, company GPU server, reasoning
  off), 3 repetitions; local `qwen3:14b`, 1 repetition.
- **Grading.** Automatic (`grade.py`): _correct_ = every expected item present and
  no wrong service named; numbers must appear in the answer. One question with an
  empty expected answer (DR11) is checked by hand (all answers correctly said
  "none"). Main set: `main_check.py`.
- **Two versions of the code.** v1 = as implemented. Error analysis of v1 found two
  executor bugs and two prompt rules **copied from test questions** (DR20, DR27).
  v2 fixes the bugs and replaces the copied rules by generic ones; v2 was re-run on
  the DGX only (B and C; A's vector path is unchanged).

## Results

### Aggregate / constraint questions (30 questions)

| Model                     | A — baseline           | B — structured             | C — routed                 |
| ------------------------- | ---------------------- | -------------------------- | -------------------------- |
| qwen3:14b, v1, 1 rep      | 8/29 (28%, CI 15–46%)  | 20/29 (69%, CI 51–83%)     | 20/29 (69%, CI 51–83%)     |
| 35B (DGX), v1, 3 reps     | 18/87 (21%, CI 14–30%) | 67/87 (77%, CI 67–85%)     | 66/87 (76%, CI 66–84%)     |
| **35B (DGX), v2, 3 reps** | (same as v1: 18/87)    | **73/87 (84%, CI 75–90%)** | **72/87 (83%, CI 73–89%)** |

_n excludes DR11 (manual, correct in all conditions). 95% Wilson intervals._

Per operation, 35B: baseline (A) vs routed v2 (C):

| Operation        | A     | C (v2) |
| ---------------- | ----- | ------ |
| filter           | 12/15 | 15/15  |
| negation         | 0/9   | 6/9    |
| comparison       | 0/6   | 6/6    |
| count            | 0/9   | 9/9    |
| min / max        | 0/9   | 9/9    |
| group-by         | 0/12  | 9/12   |
| multi-constraint | 6/15  | 15/15  |
| scenario join    | 0/12  | 3/12   |

The baseline answers simple filters (the matching services fit in the 4 retrieved
entries) but none of the counts, extrema, group-bys or negations: these need the
whole catalog, which similarity search never returns. The effect has the same
size at 14B and 35B.

### Routing and regression

- **Router** (35B, v2): right branch for 102/108 decisions (94%); the 6 lookup
  controls stay correct in all repetitions (18/18 in A and in C).
- **Main set** (35B): factual questions are all routed to lookup (30/30), i.e.
  they take A's path and cannot regress; casual messages trigger no retrieval.
  Comparative questions are mostly routed to structured (v1: 18/24): list
  questions improve (all 8 Montimage services instead of 4; complete Tecnalia,
  5G-testbed and Energy lists), but a **comparison of two services** regresses —
  the structured context carries field values, not descriptions, so the model says
  it cannot compare.
- **Latency** (35B, median): 1.5 s (A) vs 2.6 s (C): one extra model call to route
  and write the query. The GPU server is shared, so latencies are indicative.

### Remaining failures (35B, v2)

1. **Scenario membership (3/12).** The catalog's use-case text describes services
   as part of "the Montimage attack→detect→respond scenario", while the scenario
   object is titled "CI attack → MMT detection → AI4SOAR block". The model follows
   the catalog text, not the scenario object — even with a generic rule. The twin
   names the same thing two ways; grounding should link them (scenario
   descriptions / aliases in the vocabulary), i.e. reach the twin's live structure.
2. **Group-by over a list field (DR20).** Without the copied rule, the model
   filters on one use case instead of grouping by use case.
3. **Negation residue (DR06, DR08).** Correct query shape, occasional missing items
   or wrong phrasing.

## Interpretation

Querying the twin's structure turns a class of questions from almost always wrong
(21–28%) into mostly right (69–84%), at two model sizes, without hurting the
questions that already worked. As in the earlier experiments, the gain comes from
**how the twin is used, not from model size**. The remaining errors are not model
capacity either: they come from how the twin's knowledge is named (catalog text vs
scenario objects) and from what the structured context leaves out (descriptions).

## Threats to validity

- **Iteration on the test set.** v2 was obtained after error analysis on the same
  questions. Only bug fixes and generic rules were applied, and two rules copied
  from test questions were _removed_ (lowering DR20); still, v2 numbers should be
  confirmed on new, held-out questions.
- **Automatic grading.** Set/number matching on the answer text; two grader bugs
  were found and fixed (numbers before a full stop; lower-case service names), and
  all numbers above use the fixed grader. No inter-annotator check yet.
- **Small, single-author set**; 14B run with 1 repetition and v1 code only.
- **Snapshot data.** The database is not re-seeded (MAG `uiType`, KAFKA provider
  are known to be outdated); ground truth comes from the same database.

## Next steps

1. Add the matched services' descriptions to the structured context (fixes the
   comparison regression).
2. Give scenarios descriptions / aliases in the router vocabulary, linking catalog
   text to scenario objects — and test on the scenario questions.
3. A held-out question set (new phrasing, new operators) to confirm v2.
4. Re-run the 14B with v2; repeat after the KAFKA / MAG catalog update.

## Files

- Runner `run-dynamic-eval.mjs`, grader `grade.py`, main-set check `main_check.py`.
- Raw results in `results/`: `dgx-dynamic.jsonl` / `dgx-main.jsonl` (v1),
  `dgx-dynamic-v2.jsonl` / `dgx-main-v2.jsonl` (v2), `qwen3-14b-dynamic.jsonl` /
  `qwen3-14b-main.jsonl` (v1).
- Code: `server/src/agent/structured-retriever.ts`, `query-router.ts`
  (`RAG_RETRIEVAL_MODE`, default `vector`).
