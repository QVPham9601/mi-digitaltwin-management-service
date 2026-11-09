#!/usr/bin/env python3
"""Offline simulation of a model cascade (D2) on the held-out runs.

The local 35B answers in condition C; when a signal observable at answer time fires
on its answer, the question is escalated and the recorded Opus C answer to the same
question and rep is used instead. No new model calls: both answers already exist.

    python3 heldout/cascade_offline.py
"""
import math
import re
from adjudicated import QS, load

OPUS_USD = 5.29 / 210  # measured mean cost per Opus answer on this set

local, opus = load("35b"), load("opus")
keys = sorted(k for k in local if k[1] == "C")


def preds(q):
    q = q or {}
    return len(q.get("where", [])) + sum(len(x) for x in q.get("whereAny", [])) + bool(q.get("scenario")) + bool(q.get("notInScenario"))


STOP = {"services", "service", "the", "and", "with", "for", "from", "infrastructure", "software", "hardware", "category"}


def toks(s):
    return {t for t in re.findall(r"[a-z0-9]+", str(s).lower()) if len(t) >= 3}


def unanchored(r):
    """Filter values that share no word with the question (invented filters).
    POST-HOC: designed after reading the 35B failures on this set; validate on new questions."""
    q = r["retrieval"].get("query") or {}
    words = toks(QS[r["id"]]["question"])
    preds_ = q.get("where", []) + [p for grp in q.get("whereAny", []) for p in grp]
    return [f"{p['field']}={v}" for p in preds_ if p.get("field") not in ("trl.current", "trl.expected", "shortName")
            for v in (p["value"] if isinstance(p["value"], list) else [p["value"]])
            if isinstance(v, str) and not (toks(v) - STOP) & words]


SIGNALS = {
    "never (35B only)": lambda r: False,
    "empty result": lambda r: bool(r["retrieval"].get("emptyResult")),
    "router fallback (not lookup)": lambda r: bool(r["retrieval"].get("fallbackReason")) and r["retrieval"].get("routerKind") != "lookup",
    "empty OR fallback": lambda r: bool(r["retrieval"].get("emptyResult")) or (bool(r["retrieval"].get("fallbackReason")) and r["retrieval"].get("routerKind") != "lookup"),
    "empty OR fallback OR >=3 predicates": lambda r: bool(r["retrieval"].get("emptyResult")) or bool(r["retrieval"].get("fallbackReason")) or preds(r["retrieval"].get("query")) >= 3,
    "empty OR fallback OR unanchored filter (post-hoc)": lambda r: bool(r["retrieval"].get("emptyResult")) or (bool(r["retrieval"].get("fallbackReason")) and r["retrieval"].get("routerKind") != "lookup") or bool(unanchored(r)),
    "always (Opus only)": lambda r: True,
}


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return f"{p:.0%} ({max(0, c - h):.0%}–{min(1, c + h):.0%})"


def main():
    print("| escalate when | escalated | accuracy, all 105 | structured 90 | false 'none' kept | Opus cost |")
    print("|---|---|---|---|---|---|")
    for name, fire in SIGNALS.items():
        esc = [k for k in keys if fire(local[k][1])]
        ok = {k: (opus[k][0] if k in esc else local[k][0]) for k in keys}
        st = [k for k in keys if QS[k[0]]["expectedRoute"] == "structured"]
        # wrong 35B answers that claim nothing matches and are not escalated
        fn = sum(1 for k in keys if k not in esc and not local[k][0] and local[k][1]["retrieval"].get("emptyResult")
                 and QS[k[0]]["expected"].get("value"))
        print(f"| {name} | {len(esc)}/105 | {wilson(sum(ok.values()), len(keys))} | {wilson(sum(ok[k] for k in st), len(st))} "
              f"| {fn} | ${len(esc) * OPUS_USD:.2f} |")

    # what the best cheap signal misses
    fire = SIGNALS["empty OR fallback"]
    miss = sorted({k[0] for k in keys if not local[k][0] and not fire(local[k][1])})
    caught = sorted({k[0] for k in keys if not local[k][0] and fire(local[k][1])})
    print(f"\n35B wrong and escalated (empty OR fallback): {caught}")
    print(f"35B wrong and NOT escalated: {miss}")


if __name__ == "__main__":
    main()
