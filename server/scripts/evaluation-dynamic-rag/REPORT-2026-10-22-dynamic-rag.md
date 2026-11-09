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

## Addendum 2026-11-02: frontier model (Claude Opus 5.5)

**Question.** Is the baseline's failure structural, i.e. does a frontier model
with the same 4-entry vector retrieval still fail aggregate questions? And
what remains of the routed condition's errors with a stronger generator?

**Setup.** Same 36 questions, index, prompts and router; only the chat model
changes: `claude-opus-5-5`, effort `medium`, no server-side fallback. It is
used for both the answer and the router's structured query. Conditions A and C,
3 repetitions (B omitted, since C routes to the same executor). The runner's
budget guard capped the run at $10. **Actual cost: $4.55** for 216 answers,
plus $0.08 for a smoke test. Raw: `results/claude-opus-dynamic.jsonl`.

**Grader change.** Scenario titles are now removed before detecting service
names, because "CI attack → MMT detection → AI4SOAR block" contains AI4SOAR.
The DGX numbers above are unchanged by this fix.

| Model                    | A — read 4 entries                    | C — routed                                                  |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------- |
| qwen3:14b (v1)           | 8/29 (28%)                            | 20/29 (69%)                                                 |
| Qwen3.6-35B, DGX (v2)    | 18/87 (21%); 24/87 complete           | 72/87 (83%)                                                 |
| **Claude Opus 5.5 (v2)** | **4/87 strict; 26/87 complete (30%)** | **87/87 after adjudication** (75/87 strict, 87/87 complete) |

- **Strict vs complete.** Opus adds context, such as "the next lowest is
  AI4SOAR, at TRL 5" or the full table of a scenario's services. The strict
  grader counts that as naming a wrong service. Under C, the 12 rows that were
  complete but not strictly correct (9 min/max, 3 DR29) were read by hand: all
  are correct, so C = 87/87 (95% CI 96–100%). Under A, the complete count
  (26/87) is an upper bound. Many of those answers explicitly say "in the
  retrieved context…" and are partial.
- **Baseline failure is structural.** With 4 retrieved entries, Opus answers
  no count, min/max, group-by, negation or comparison question (0/45), the same
  as the 35B. It correctly hedges ("in the retrieved context, Montimage
  provides 4 services") but cannot know what it was not given.
- **The routed residue is closed by the stronger model.** Opus resolves the
  scenario questions (12/12 complete vs 3/12 for the 35B) and the group-by over
  a list field (DR20). The router picked the right branch 108/108 times, with
  no fallbacks (the 35B: 102/108). So the remaining 35B errors were partly
  _model_ errors: linking two names of the same scenario and planning a
  group-by.
- **Cost of the frontier model.** Median latency 5.5 s (A) / 6.7 s (C) vs
  1.5 s / 2.6 s on the DGX. About $0.02 per answer, and catalog data leaves
  the premises.

**Interpretation.** Grounding in the twin's structure is _necessary_. No model
size or quality makes the 4-entry baseline answer aggregate questions. Once
grounded, a frontier model is _better_ than the local 35B on the residue
(entity linking, query planning): 100% vs 83%. Two consequences:

- the claim is "grounding first, then scale helps on the hard residue", not
  "scale never matters";
- it supports a cascade (D2): the local model by default, a larger model only
  for the steps where the twin shows the local one is wrong.

**Threats.** One frontier model, effort `medium`. Same questions as v2 (not
held out). A-condition adjudication is not done.

## Addendum 2026-11-02 (2): v3 fixes, 35B and 14B re-runs

**Changes (v3), all generic: no question text is used.**

1. **Scenario aliases.** Each scenario's other names are taken from the
   catalog itself: phrases such as "the Montimage attack→detect→respond
   scenario" in its services' use cases. They are used to resolve scenario
   references.
2. **Scenarios in the router vocabulary.** The router sees each scenario as
   its title, its other names and its member services.
3. **Repair rule.** A use-case predicate that names a scenario becomes a
   scenario filter: use-case text never decides membership.
4. **Descriptions in small results.** Structured results with 8 services or
   fewer, grouped or not, carry each service's description (up to 300
   characters).

Conditions B and C were re-run on the DGX (3 repetitions), plus the main set
under C. The local qwen3:14b was run under C (3 repetitions). Raw results:

- `dgx-dynamic-v3.jsonl` and `dgx-main-v3.jsonl`;
- `qwen3-14b-dynamic-v3.jsonl`;
- `dgx-*-v3a.jsonl`: an intermediate run without change 4 for grouped results.

The 14B run used the intermediate code (v3a). Its group-by output is
therefore names-only, which affects comparison-style answers, not this set's
grading.

| Model, condition C | v1                 | v2                        | **v3**                                                 |
| ------------------ | ------------------ | ------------------------- | ------------------------------------------------------ |
| qwen3:14b (local)  | 20/29 (69%), 1 rep | —                         | **78/87 (90%, CI 81–94%)**, 3 reps                     |
| Qwen3.6-35B (DGX)  | 66/87 (76%)        | 72/87 (83%)               | **80/87 (92%, CI 84–96%)**, adjudicated (74/87 strict) |
| Claude Opus 5.5    | —                  | 87/87 (100%), adjudicated | —                                                      |

**By operation, v3:**

- **Scenario join:** 14B 6/12, 35B 8/12, against 3/12 for the 35B in v2.
- **Negation:** 9/9 for both models.
- **Group-by:** still 9/12, the list-field case DR20.

**Router and main set.**

- The router picked the right branch 108/108 times for the 35B and 99/108 for
  the 14B.
- The 14B's remaining fallbacks are scenario names written as use-case values
  without the word "scenario" (6), and a service name used as a provider (3).
  A next repair would resolve those values against scenario titles and aliases
  directly.
- **Main set (35B):** the two-service comparison (C5) is now answered in 3/3
  runs, against "cannot compare" in 2 of 3 for v2. That removes the
  regression.

**Adjudication (35B).** Six rows were complete but not strictly correct
(DR15, DR29, DR30). They were read by hand: all are correct, and the extra
service names come from context or from quoted descriptions.

**Interpretation.**

- Making the twin's own naming explicit (scenario aliases, scenario members)
  and giving its descriptions raised both local models to about 90%.
- The 14B with v3 grounding (90%) now does better than the 35B did with v2
  grounding (83%): again, how the twin is exposed matters more than model
  size.
- The remaining gap to the frontier model (92% against 100%) sits in query
  planning: ignoring the scenario filter, and group-by over a list field.

**Threats.** The v3 changes were designed after error analysis on these
questions. They contain no question text, but a held-out set is still needed.
The 14B and 35B ran slightly different code (v3a / v3). One run, three
repetitions each.

## Files

- Runner `run-dynamic-eval.mjs`, grader `grade.py`, main-set check `main_check.py`.
- Raw results in `results/`: `claude-opus-dynamic.jsonl` (Opus, A/C × 3), `claude-smoke.jsonl`; `dgx-dynamic.jsonl` / `dgx-main.jsonl` (v1),
  `dgx-dynamic-v2.jsonl` / `dgx-main-v2.jsonl` (v2), `qwen3-14b-dynamic.jsonl` /
  `qwen3-14b-main.jsonl` (v1).
- Code: `server/src/agent/structured-retriever.ts`, `query-router.ts`
  (`RAG_RETRIEVAL_MODE`, default `vector`).

## Addendum (2026-11-05): held-out question set, local qwen3:14b

**Protocol.** 35 questions written by the author on 2026-11-05 (45 min) after the
code freeze at `ce280bc` (tag `heldout-freeze`), without opening the old set.
Ground truth computed from the catalog by `heldout/ground_truth_heldout.py`; it agrees
with the author's own answers on all 35 (after fixing 4 author slips; H05, H09 and H20
were reworded or replaced before any run because they were ambiguous). Catalog
unchanged since the 2026-10-22 snapshot (re-dumped and compared). Run: A (vector top-4)
and C (routed) x 3 on the local qwen3:14b, 210 answers, no errors or timeouts. The DGX
35B run is pending (DGX unreachable on 2026-11-05). Manual decisions are recorded in
`heldout/adjudication-qwen3-14b.json`.

| subset                                                       | A vector               | C routed               |
| ------------------------------------------------------------ | ---------------------- | ---------------------- |
| structured questions (30 x 3)                                | 42/90 (47%, CI 37–57%) | 56/90 (62%, CI 52–72%) |
| — without the 3 paraphrases of old questions (H03, H10, H17) | 36/81 (44%)            | 47/81 (58%)            |
| lookup questions (5 x 3)                                     | 11/15 (73%)            | 12/15 (80%)            |
| all 105                                                      | 53/105 (50%)           | 68/105 (65%)           |

McNemar on structured (question x rep pairs): C-only correct 26, A-only 12, exact p = 0.034.
Majority-correct structured questions: A 14/30, C 19/30. Router: right branch 93/105.

**Generalisation gap.** C drops from 90% on the old set (same model) to 62% on the
held-out set: part of the old-set gain came from fixes tuned on those questions. The
gap is in query planning, not in retrieval or generation:

- _OR written as AND_ (H09, H25, H33, H23): the router puts one alternative in
  `where` and the other in `whereAny`, so the query is empty.
- _Invented filters_ (H15, H18, H22): an extra `repositoryTable = INTACT_TOOLBOX`
  or sector predicate silently drops the right service (e.g. KAFKA).
- _Operations the query language lacks_ (H26, H27: number of standards): the
  router improvises and gets a wrong or empty result; A answers these better from text.
- _Semantic questions routed to structured_ (H01, H33): capability lives in the
  descriptions, not in fields.
- _Scenario facts_ (H28): neither condition knows the scenario list; both fail.

**Safety-relevant failure.** About 15 C answers (H09, H18, H23, H25, H26, H33) state
confidently that _no_ service matches when several do, because the generator trusts
an empty structured result. For an operator this is worse than a vague answer. An
empty result from a multi-predicate query should trigger a check (relax one
predicate, or fall back to vector) before answering "none".

**Threats.** Single author for questions and adjudication; 3 reps of the same
model are not independent samples (question-level majority reported too); the
14B only; the A and C prompts differ in context format.
