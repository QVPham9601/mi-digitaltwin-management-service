# M1 — grounding the agent in the twin's live state

Thesis method M1 ("the twin as the agents' trusted reference"), second half. The first
half (structured retrieval over the service catalog) is evaluated in
`../evaluation-dynamic-rag/REPORT-2026-10-22-dynamic-rag.md`. This part adds the
twin's **run state** (executions, run reports, alerts, service health) and tests two claims:

1. **Freshness.** Querying the twin at answer time keeps answers correct after the
   infrastructure changes; a static index of the same facts goes stale.
2. **Fidelity.** When a twin record is itself doubtful (a run marked "running" for weeks),
   the agent says so instead of reporting it as live.

## Who does what, in order

| Step                                                                                   | Who                | Document                    |
| -------------------------------------------------------------------------------------- | ------------------ | --------------------------- |
| 1. Implement the state route, the static baseline, the change and ground-truth scripts | implementing agent | `IMPLEMENTATION.md`         |
| 2. Review, then freeze the code (git tag `live-state-freeze`)                          | user               | —                           |
| 3. Write 15–20 questions without seeing the change script's effects                    | user               | `questions/INSTRUCTIONS.md` |
| 4. Compute ground truth, run the experiment, grade, report                             | evaluating agent   | `EVALUATION-PROTOCOL.md`    |

The implementing agent must **not** write evaluation questions or run the evaluation:
questions written by the people who built the system are the weakness the held-out
sets were created to remove.
