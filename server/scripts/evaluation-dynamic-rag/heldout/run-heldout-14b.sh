#!/bin/bash
# Held-out run on the local 14B: A and C x3, retrying timed-out answers up to 4 passes.
# Dropped rows are kept in heldout-qwen3-14b.dropped.jsonl so retries can be reported.
cd /Users/vietpham/Documents/thesis/code/mi-digitaltwin-management-service/server
R=$PWD/scripts/evaluation-dynamic-rag/results
OUT=$R/heldout-qwen3-14b.jsonl
PW=$(grep -E '^ADMIN_PASSWORD=' .env | cut -d= -f2-)
for pass in 1 2 3 4; do
  echo "$(date +%H:%M) pass $pass"
  BASE_URL=http://localhost:3101 ADMIN_PASSWORD=$PW node scripts/evaluation-dynamic-rag/run-dynamic-eval.mjs \
    --questions=heldout/questions-heldout-eval.json --out=$OUT --conditions=A,C --reps=3 > /dev/null
  CLEAN=$(python3 - "$OUT" "$R/heldout-qwen3-14b.dropped.jsonl" <<'PY'
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
  echo "$(date +%H:%M) pass $pass: clean ${CLEAN% *}/210, dropped ${CLEAN#* }"
  [ "${CLEAN% *}" -ge 210 ] && { echo DONE; exit 0; }
done
echo "FINISHED with missing rows"
