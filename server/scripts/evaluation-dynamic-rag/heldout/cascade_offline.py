#!/usr/bin/env python3
"""Offline simulation of a model cascade (D2) on the held-out runs.

The cascade stays local: the small local model (default qwen3:14b on the laptop)
answers in condition C; when a signal observable at answer time fires on its answer,
the question is escalated and the recorded answer of the larger local model (default
the 35B on the DGX) to the same question and rep is used instead. No new model calls:
both answers already exist. Opus is printed as a reference row only (an upper bound
for comparison), never as a cascade stage.

    python3 heldout/cascade_offline.py [--set=heldout|heldout2] [--small=14b] [--large=35b]
"""
import importlib
import math
import re
import sys
from pathlib import Path

ARGS = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
SET, SMALL, LARGE = ARGS.get("set", "heldout"), ARGS.get("small", "14b"), ARGS.get("large", "35b")
sys.path.insert(0, str(Path(__file__).parent.parent / SET))
adj = importlib.import_module("adjudicated" if SET == "heldout" else "adjudicated2")
QS, load = adj.QS, adj.load

local, large, opus = load(SMALL), load(LARGE), load("opus")
keys = sorted(k for k in local if k[1] == "C" and k in large)
N = len(keys)


def preds(q):
    q = q or {}
    return len(q.get("where", [])) + sum(len(x) for x in q.get("whereAny", [])) + bool(q.get("scenario")) + bool(q.get("notInScenario"))


STOP = {"services", "service", "the", "and", "with", "for", "from", "infrastructure", "software", "hardware", "category"}


def toks(s):
    return {t for t in re.findall(r"[a-z0-9]+", str(s).lower()) if len(t) >= 3}


def unanchored(r):
    """Filter values that share no word with the question (invented filters).
    POST-HOC: designed after reading the 35B failures on the first held-out set; validate on new questions."""
    q = r["retrieval"].get("query") or {}
    words = toks(QS[r["id"]]["question"])
    preds_ = q.get("where", []) + [p for grp in q.get("whereAny", []) for p in grp]
    return [f"{p['field']}={v}" for p in preds_ if p.get("field") not in ("trl.current", "trl.expected", "shortName")
            for v in (p["value"] if isinstance(p["value"], list) else [p["value"]])
            if isinstance(v, str) and not (toks(v) - STOP) & words]


SIGNALS = {
    f"never ({SMALL} only)": lambda r: False,
    "empty result": lambda r: bool(r["retrieval"].get("emptyResult")),
    "router fallback (not lookup)": lambda r: bool(r["retrieval"].get("fallbackReason")) and r["retrieval"].get("routerKind") != "lookup",
    "empty OR fallback": lambda r: bool(r["retrieval"].get("emptyResult")) or (bool(r["retrieval"].get("fallbackReason")) and r["retrieval"].get("routerKind") != "lookup"),
    "empty OR fallback OR >=3 predicates": lambda r: bool(r["retrieval"].get("emptyResult")) or bool(r["retrieval"].get("fallbackReason")) or preds(r["retrieval"].get("query")) >= 3,
    "empty OR fallback OR unanchored filter (post-hoc)": lambda r: bool(r["retrieval"].get("emptyResult")) or (bool(r["retrieval"].get("fallbackReason")) and r["retrieval"].get("routerKind") != "lookup") or bool(unanchored(r)),
    f"always ({LARGE} only)": lambda r: True,
}


def wilson(k, n, z=1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return f"{p:.0%} ({max(0, c - h):.0%}–{min(1, c + h):.0%})"


def main():
    print(f"Cascade {SMALL} -> {LARGE} on {SET} (condition C, {N} answers)\n")
    print(f"| escalate when | escalated | accuracy, all {N} | structured | false 'none' kept |")
    print("|---|---|---|---|---|")
    st = [k for k in keys if QS[k[0]]["expectedRoute"] == "structured"]
    for name, fire in SIGNALS.items():
        esc = [k for k in keys if fire(local[k][1])]
        ok = {k: (large[k][0] if k in esc else local[k][0]) for k in keys}
        # wrong small-model answers that claim nothing matches and are not escalated
        fn = sum(1 for k in keys if k not in esc and not local[k][0] and local[k][1]["retrieval"].get("emptyResult")
                 and QS[k[0]]["expected"].get("value"))
        print(f"| {name} | {len(esc)}/{N} ({len(esc) / N:.0%}) | {wilson(sum(ok.values()), N)} "
              f"| {wilson(sum(ok[k] for k in st), len(st))} | {fn} |")
    ref = [k for k in keys if k in opus]
    print(f"| reference only: Opus alone (not a cascade stage) | - | {wilson(sum(opus[k][0] for k in ref), len(ref))} "
          f"| {wilson(sum(opus[k][0] for k in st if k in opus), len([k for k in st if k in opus]))} | - |")

    fire = SIGNALS["empty OR fallback"]
    miss = sorted({k[0] for k in keys if not local[k][0] and not fire(local[k][1])})
    caught = sorted({k[0] for k in keys if not local[k][0] and fire(local[k][1])})
    print(f"\n{SMALL} wrong and escalated (empty OR fallback): {caught}")
    print(f"{SMALL} wrong and NOT escalated: {miss}")


if __name__ == "__main__":
    main()
