#!/usr/bin/env python3
"""Regression check on the main question set (factual / comparative / adversarial / casual).

    python3 main_check.py results/<run>-main.jsonl [results/<run>-main-v2.jsonl]

For condition C, a "lookup" router decision uses exactly the same vector path as
condition A, so only questions the router sends to the structured branch can
regress. The script reports the router decisions per category, auto-grades the
factual questions (short ground truths: case-insensitive containment), and lists
the questions routed to the structured branch for a manual A-vs-C check.
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent
QS = {q["id"]: q for q in json.loads((HERE / "questions-main-secassured.json").read_text())}


def core(gt):
    """First clause of a short ground truth, e.g. 'CERTH.' -> 'certh'."""
    return re.split(r"[.;(]", gt)[0].strip().lower()


rows = [json.loads(l) for p in sys.argv[1:] for l in Path(p).read_text().splitlines() if l.strip()]
rows = [r for r in rows if not r.get("error")]

factual = defaultdict(lambda: [0, 0])
decisions = defaultdict(Counter)
structured_hits = defaultdict(list)
for r in rows:
    q = QS[r["id"]]
    if q["category"] == "factual":
        f = factual[r["condition"]]
        f[0] += core(q["groundTruth"]) in r.get("answer", "").lower()
        f[1] += 1
    if r["condition"] == "C":
        rt = r.get("retrieval") or {}
        kind = rt.get("routerKind") or rt.get("route") or "none"
        decisions[q["category"]][kind] += 1
        if rt.get("route") == "structured":
            structured_hits[r["id"]].append(r)

print("Factual (auto, containment):", {c: f"{k}/{n}" for c, (k, n) in sorted(factual.items())})
print("Router decisions in C, per category:")
for cat, cnt in sorted(decisions.items()):
    print(f"  {cat}: {dict(cnt)}")
print(f"Questions routed to the structured branch in C (manual A-vs-C check): {len(structured_hits)}")
for qid, rs in sorted(structured_hits.items()):
    a = next((r for r in rows if r["id"] == qid and r["condition"] == "A"), None)
    print(f"- {qid} [{QS[qid]['category']}] {QS[qid]['question']}")
    print(f"    GT: {QS[qid]['groundTruth'][:160]}")
    if a:
        print(f"    A : {a['answer'][:200]!r}")
    print(f"    C : {rs[0]['answer'][:200]!r}")
