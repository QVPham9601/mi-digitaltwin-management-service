# M1 live state — evaluation protocol

For the evaluating agent, after the user has frozen the code (tag `live-state-freeze`)
and handed over `questions/questions-live-state.json`.

## Research questions

- **RQ-F (freshness).** After the twin's state changes, does querying it at answer time
  (T) keep answers correct where a static index of the same facts (S) goes stale?
- **RQ-D (fidelity).** When a twin record is doubtful (the October "running" run), does
  T flag it instead of reporting it as live? Does S or V?

## Conditions

|     | mode           | knows run state?                     |
| --- | -------------- | ------------------------------------ |
| V   | `vector`       | no (catalog embeddings only) — floor |
| S   | `state-static` | yes, as indexed at t0                |
| T   | `auto`         | yes, read live at answer time        |

Generators: DGX 35B (`CHAT_BASE_URL=http://192.168.0.132:8001/v1`, may change — ask the
user) and local `qwen3:14b`. Claude only as a comparison reference, never as part of the system, and only if the user approves a budget.

## Procedure

1. Check `git diff live-state-freeze -- server/src` is empty.
2. `copy-db.sh` (fresh `intact_m1`). Server with `MONGODB_URI=…/intact_m1`,
   `AGENT_EVAL_OPTIONS=true AGENT_LLM_TITLES=false RAG_RETRIEVAL_MODE=vector`.
3. **t0:** `dump-state.mjs --label=t0`, `build-static-index.mjs`. Run V, S, T × 3 reps.
4. **Change**, one of two variants (record which one):
   - **Real incident (preferred).** `real-change.mjs --incident` (deploys the demo on
     kind, runs MAG's first attack profile, tears down: a closed run with real alerts
     and CI-SIM health), then `real-change.mjs --start-live` (a genuinely running run),
     then `apply-change.mjs --step=3` (the SECANOD failure stays scripted).
   - **Scripted replay (reproducible).** `apply-change.mjs --step=1`, then 2, then 3.
     Re-date steps 1–2 to the evaluation day first (step 2 is only "fresh" within
     `AGENT_STALE_RUN_MS` of its start).

   Then `dump-state.mjs --label=t1`.

5. **t1:** run V, S, T × 3 reps (S still uses the t0 index — that is the point). In the
   real variant, `real-change.mjs --stop-live` only after the t1 answers.
   Real runs differ between sessions (alert counts, timing), so the ground truth is
   always computed from the t1 snapshot of that session, and all models compared in one
   table should be asked in the same session or about the same t1 snapshot.
6. Ground truth for every question at t0 and t1 with `ground_truth_state.py`; cross-check
   with the author's answers; resolve disagreements from the snapshots.
7. Grade (strict automatic grading plus a recorded manual adjudication, as in
   `../evaluation-dynamic-rag/heldout/adjudication-*.json`).

## Metrics

- Accuracy per condition × phase (t0, t1), with Wilson CIs; McNemar T vs S at t1.
- **Stale-answer rate:** at t1, among questions whose truth changed, the share of
  answers that match the t0 truth.
- **Control questions:** those whose truth does not change; S and T should both hold.
- **Fidelity:** on questions touching the October run, the share of answers that flag it
  as possibly stale (manual grading with a written rule).
- Latency per condition; router branch accuracy.

## Threats to record

Single author for questions and adjudication; one scenario with run history; changes are
synthetic in the scripted variant; in the real variant AI4SOAR is a stub (it blocks
through CI-SIM's real `/admin/block`, not through AI4SOAR's playbook engine); 3 reps of
one model are not independent.

Report whatever the result is.
