#!/bin/bash
# Second held-out run on the DGX 35B (server on :3100): A and C x3. Waits while the DGX is
# unreachable and re-runs rows that failed because of the network, up to 30 passes.
# Dropped rows are kept in heldout2-dgx-35b.dropped.jsonl so retries can be reported.
cd /Users/vietpham/Documents/thesis/code/mi-digitaltwin-management-service/server
R=$PWD/scripts/evaluation-dynamic-rag/results
OUT=$R/heldout2-dgx-35b.jsonl
PW=$(grep -E '^ADMIN_PASSWORD=' .env | cut -d= -f2-)
for pass in $(seq 1 30); do
  until curl -s -m 5 -o /dev/null -f "${DGX_URL:-http://192.168.0.132:8001/v1}/models"; do
    echo "$(date +%H:%M) DGX unreachable, waiting"; sleep 60
  done
  echo "$(date +%H:%M) pass $pass"
  BASE_URL=http://localhost:3100 ADMIN_PASSWORD=$PW node scripts/evaluation-dynamic-rag/run-dynamic-eval.mjs \
    --questions=heldout2/questions-heldout2-eval.json --out=$OUT --conditions=A,C --reps=3 > /dev/null
  CLEAN=$(python3 - "$OUT" "$R/heldout2-dgx-35b.dropped.jsonl" <<'PY'
import json, sys
p, d = sys.argv[1], sys.argv[2]
rows = [json.loads(l) for l in open(p) if l.strip()]
bad = lambda r: r.get("error") or "router call failed" in str((r.get("retrieval") or {}).get("fallbackReason", ""))
open(d, "a").write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows if bad(r)))
keep = [r for r in rows if not bad(r)]
open(p, "w").write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in keep))
print(len(keep), len(rows) - len(keep))
PY
)
  echo "$(date +%H:%M) pass $pass: clean ${CLEAN% *}/90, dropped ${CLEAN#* }"
  [ "${CLEAN% *}" -ge 90 ] && { echo DONE; exit 0; }
done
echo "FINISHED with missing rows"
