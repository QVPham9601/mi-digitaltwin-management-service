# Second held-out question set: instructions for the question author

## Purpose

These questions test the changes made after the first held-out set, on
**questions written after the code was frozen again**:

- an empty answer from a query with several conditions is relaxed instead of
  answered with a bare "none";
- filters on the number of entries of a list ("at least two standards") and
  ranking ("top 3 by …");
- the cascade signals (when the small local model should hand the question
  to a larger local one), which were designed on the first held-out set and must be
  checked on new questions.

The first held-out set has now been read and its failures studied, so it can
no longer measure these changes.

## Protocol (do this in order)

1. **The code is frozen** at `3b8ac59` (git tag `heldout2-freeze`). Do not
   change `server/src/agent/` until this set is graded.
2. **Do not reuse** questions from `heldout/questions-heldout.json`, and do not
   open any results file or `REPORT-*.md` while writing.
3. **Do not try** any question on the platform or the agent before the
   official run.
4. Write the questions in `questions-heldout2.json`, using the template next to
   this file.
5. Fill in the `meta` block (date, how long it took).
6. Hand over the file. The ground truth is computed afterwards from the
   catalog, independently of the system.

## Source of information

Use only the SecSim platform itself: the service catalog pages and the
scenario pages. Every question must be answerable from what the catalog shows,
or have "none" as its correct answer.

## What to write (12–15 questions)

Write in your own words, as an operator would ask. Do not use project names or
database field names.

| Type (`category`)  | How many | What it means                                                                  |
| ------------------ | -------- | ------------------------------------------------------------------------------ |
| `or`               | 2–3      | "X or Y" conditions (two providers, two categories, …)                         |
| `and-not`          | 2        | a condition combined with a negation ("… but not …")                           |
| `at-least`         | 2        | the number of entries of a list: "at least two use cases", "only one standard" |
| `ranking`          | 2        | "top N by …", "rank … by …" (TRL, or the number of standards / use cases)      |
| `no-answer`        | 2–3      | plausible questions with several conditions that nothing satisfies together    |
| `multi-constraint` | 2        | three or more conditions together                                              |

Spread the questions over different fields, providers and sectors.

## Lessons from the first set

- Say exactly what a group means when it could be read two ways. "Security
  services" was read as different category sets by different models; prefer
  "the services in the Dev Services category", "the partner testbeds", etc.
- A "no-answer" question should be one where each condition alone matches
  something, but nothing matches all of them (e.g. "hardware AND terminal UI").
- Avoid questions whose answer depends on reading the descriptions only; the
  first set already covers those.

## Fields of the template

- `id`: N01, N02, …
- `category`: one of the types above.
- `question`: the question exactly as you would ask it.
- `expectedRoute`: `structured` (all types above), or `lookup` if you add a
  single-service fact.
- `myAnswer`: what you believe the answer is, from the catalog. Used only to
  cross-check the computed ground truth.
- `note` (optional): anything ambiguous.

## After handing over

1. Ground truth computed from the catalog and cross-checked with `myAnswer`.
2. Runs, C condition on the frozen code: DGX 35B x3, local 14B x3, Claude Opus x3
   (about $1); A x3 on the DGX as the vector baseline.
3. Measured: accuracy per type; false "none" answers (should be 0); how often
   the relaxation fires and whether the answer then names the right services;
   the cascade with the signals fixed in `heldout/cascade_offline.py`
   before this set was written (as run: 35B + Opus on escalation; reframed
   2026-11-10 to the local 14B → 35B cascade, Opus as reference only).
4. Report the result whatever it is.
