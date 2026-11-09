# Live-state questions: instructions for the question author

Write these **after** the code is frozen (git tag `live-state-freeze`), and before any run.

## What to write (15–20 questions)

Questions an operator would ask about the **runs of the scenarios** on the platform, in
your own words, without field names or project names. Look only at the platform's
scenario pages and run reports (what the UI shows). Do not open
`apply-change.mjs` or any results file: the questions must not be written around the
planned changes.

| `category` | How many | Examples of the kind (do not copy)                                                 |
| ---------- | -------- | ---------------------------------------------------------------------------------- |
| `latest`   | 3–4      | the last run's outcome, duration, number of alerts                                 |
| `now`      | 2–3      | is something running now, what is deployed                                         |
| `history`  | 3–4      | how many runs passed, the longest run, runs by a person                            |
| `health`   | 2–3      | which service was down or unhealthy in a run, availability                         |
| `attack`   | 2–3      | attackers seen, the run with the most alerts                                       |
| `mixed`    | 2        | combine run state with a catalog fact (e.g. a property of the service that failed) |
| `control`  | 2        | run-state questions you expect to stay true whatever happens later                 |

## Fields

- `id`: L01, L02, …
- `category`: one of the above.
- `question`: exactly as you would ask it.
- `myAnswer`: what you believe the answer is **today**, from the platform.
- `note` (optional): ambiguity, e.g. what "last run" means if runs overlap.

Fill in the `meta` block and hand over the file.
