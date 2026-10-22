#!/usr/bin/env python3
"""Auto-grade dynamic-RAG answers against the computed ground truth.

    python3 grade.py results/<run>.jsonl [more.jsonl ...]

Service mentions are detected by catalog shortName (case-sensitive, so the
platform name "SecSim" is not read as the SECSIM service). Grades:
  correct  — every expected item present and no wrong service named
  complete — every expected item present (extra services allowed)
Empty-set answers (no expected service) are flagged for a manual check.
"""
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
QS = {q["id"]: q for q in json.loads((HERE / "questions-dynamic-rag.json").read_text())}
SNAP = json.loads((HERE / "catalog-snapshot.json").read_text())
NAMES = sorted({s["shortName"] for s in SNAP["services"]}, key=len, reverse=True)


def mentioned(text):
    """Catalog services named in the text (case-insensitive: answers often write
    service titles like "secSAC"). The platform name "SecSim" is not the SECSIM service."""
    found = set()
    for n in NAMES:
        for m in re.finditer(rf"(?<![A-Za-z0-9-]){re.escape(n)}(?![A-Za-z0-9-])", text, re.I):
            if not (n == "SECSIM" and m.group(0) == "SecSim"):
                found.add(n)
                break
    return found


def has_label(text, label):
    """Provider / sector / use-case labels: match the part before any parenthesis."""
    core = re.sub(r"\s*\(.*?\)", "", str(label)).strip()
    core = core.split(" - ")[0] if core.startswith("UC") else core
    return core.lower() in text.lower()


def has_number(text, value):
    return re.search(rf"(?<![\d.]){value}(?!\d|\.\d)", text) is not None  # "is 7." counts


def grade(q, answer):
    exp, m = q["expected"], mentioned(answer)
    t = exp["type"]
    if t == "set":
        want = set(exp["value"])
        if not want:
            return {"correct": None, "complete": None, "manual": True}
        return {"complete": want <= m, "correct": want <= m and not (m - want)}
    if t in ("number", "extremum"):
        want = set(exp.get("services", [])) if t == "extremum" else set()
        ok = has_number(answer, exp["value"]) and want <= m
        return {"complete": ok, "correct": ok and (t == "number" or not (m - want))}
    if t == "argmax":
        ok = all(has_label(answer, k) for k in exp["value"])
        return {"complete": ok, "correct": ok}
    if t == "counts":
        ok = all(has_label(answer, k) for k in exp["value"])
        return {"complete": ok, "correct": ok}
    if t == "groups":
        want = {s for v in exp["value"].values() for s in v}
        ok = want <= m and all(has_label(answer, k) for k in exp["value"])
        return {"complete": ok, "correct": ok and not (m - want)}
    if t == "value":
        v = exp["value"]
        ok = any(has_label(answer, x) for x in v) if isinstance(v, list) else (
            has_number(answer, v) if isinstance(v, (int, float)) else has_label(answer, v))
        return {"complete": ok, "correct": ok}
    raise ValueError(t)


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0, c - h), min(1, c + h))


def main(paths):
    rows = [json.loads(l) for p in paths for l in Path(p).read_text().splitlines() if l.strip()]
    by = defaultdict(list)
    manual = []
    for r in rows:
        if r.get("error"):
            by[(r["condition"], "_errors")].append(r)
            continue
        g = grade(QS[r["id"]], r.get("answer", ""))
        r.update(g)
        if g.get("manual"):
            manual.append(r)
            continue
        if QS[r["id"]]["expectedRoute"] == "structured":
            by[(r["condition"], "ALL structured")].append(r)
        by[(r["condition"], r["category"])].append(r)

    print("| condition | questions | n | correct | 95% CI | complete | median latency |")
    print("|---|---|---|---|---|---|---|")
    for key in sorted(by):
        rs = by[key]
        if key[1] == "_errors":
            print(f"| {key[0]} | errors | {len(rs)} | | | | |")
            continue
        k = sum(bool(r["correct"]) for r in rs)
        c = sum(bool(r["complete"]) for r in rs)
        lo, hi = wilson(k, len(rs))
        lat = sorted(r["latencyMs"] for r in rs)[len(rs) // 2] / 1000
        print(f"| {key[0]} | {key[1]} | {len(rs)} | {k}/{len(rs)} | {lo:.0%}–{hi:.0%} | {c}/{len(rs)} | {lat:.1f} s |")

    routed = [r for r in rows if r["condition"] == "C" and r.get("retrieval")]
    if routed:
        # The router's decision (routerKind); a "lookup" decision is reported by the
        # server as route=fallback, so only non-lookup fallbacks are real failures.
        ok = sum(
            (r["retrieval"].get("routerKind") == "structured") == (QS[r["id"]]["expectedRoute"] == "structured")
            for r in routed)
        fb = defaultdict(int)
        for r in routed:
            if r["retrieval"].get("route") == "fallback" and r["retrieval"].get("routerKind") != "lookup":
                fb[r["retrieval"].get("fallbackReason", "?")] += 1
        print(f"\nRouter (C): right branch {ok}/{len(routed)}; fallbacks: {dict(fb) or 'none'}")
    if manual:
        print("\nManual check (empty expected set):")
        for r in manual:
            print(f"- {r['condition']} {r['id']} rep{r['rep']}: {r['answer'][:220]!r}")


if __name__ == "__main__":
    main(sys.argv[1:])
