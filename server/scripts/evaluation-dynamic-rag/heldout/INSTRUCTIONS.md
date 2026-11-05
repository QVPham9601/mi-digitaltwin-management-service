# Held-out question set: instructions for the question author

## Purpose

These questions test whether the dynamic retrieval results (v3: about 90% on
aggregate and constraint questions) hold on **new questions written after the
code was frozen**. The earlier set was used to design the fixes, so it can no
longer tell us how the system generalises.

## Protocol (do this in order)

1. **Freeze the code.** Write the commit hash here before writing any
   question: `frozen at: ce280bc` (git tag `heldout-freeze`).
   After this point, do not change `server/src/agent/` until the held-out run
   is graded.
2. **Do not open** `questions-dynamic-rag.json`, `QUESTIONS.md` or any results
   file while writing.
3. **Do not try** any question on the platform or the agent before the
   official run.
4. Write the questions in `questions-heldout.json`, using the template next to
   this file.
5. Record when you wrote them in the `meta` block of the template (date, how
   long it took).
6. Hand over the file. Ground truth is computed afterwards from the catalog
   snapshot, independently of the system.

## Source of information

Use only the SecSim platform itself: the service catalog pages (services,
providers, categories, sectors, TRL, use cases, standards, type, UI type,
license) and the scenario pages. Every question must be answerable from what
the catalog shows, or have "none" as its correct answer.

## What to write (about 30–35 questions)

Write in your own words, the way an operator or a project partner would ask.
Informal names, abbreviations and partner nicknames are welcome. Do not copy
database field names.

| Type (`category` in the template) | How many | What it means                                                                      |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `filter`                          | 3        | services matching one condition                                                    |
| `negation`                        | 3        | services that do **not** match a condition                                         |
| `comparison`                      | 3        | a numeric threshold (TRL above / below / at least)                                 |
| `count`                           | 3        | "how many …"                                                                       |
| `min-max`                         | 3        | the lowest / highest value, or which service holds it                              |
| `group-by`                        | 3        | per provider / category / sector / use case, or "which … has the most"             |
| `multi-constraint`                | 3        | two or more conditions together                                                    |
| `scenario-join`                   | 3        | services used / not used in a deployment scenario, or a property of them           |
| `new-or`                          | 1–2      | "X or Y" conditions                                                                |
| `new-at-least`                    | 1–2      | "at least two …", "more than one …"                                                |
| `new-ranking`                     | 1–2      | "top 3 …", "rank by …"                                                             |
| `new-cross-scenario`              | 1        | involving two scenarios                                                            |
| `no-answer`                       | 2–3      | plausible questions whose correct answer is "none" (a condition nothing satisfies) |
| `lookup`                          | 4        | one fact about one named service                                                   |

Spread the questions over different fields and providers. Don't let them all
be about TRL or about Montimage.

## Fields of the template

- `id`: H01, H02, …
- `category`: one of the types above.
- `question`: the question exactly as you would ask it.
- `expectedRoute`: `lookup` for single-service facts, `structured` for
  everything else.
- `myAnswer` (optional): what you believe the answer is, from the catalog. It
  is used only to cross-check the computed ground truth, never by the system.
- `note` (optional): anything ambiguous, e.g. "partner infrastructure = the
  hardware testbeds".

## After handing over

1. Compute the ground truth for each question: express it as a query over
   `catalog-snapshot.json` in `ground_truth.py`, then compare with `myAnswer`
   and resolve any disagreement by reading the catalog.
2. Run the evaluation:
   - conditions A and C, 3 repetitions, on the DGX 35B;
   - condition C, 3 repetitions, on the local 14B (optional).
3. Grade with `grade.py` (plus a manual check of rows that are complete but
   not strictly correct). Report:
   - per-type results;
   - paired McNemar A vs C;
   - the comparison with the old set.
4. Report the result whatever it is. A drop on the held-out set is a finding,
   not a failure.
