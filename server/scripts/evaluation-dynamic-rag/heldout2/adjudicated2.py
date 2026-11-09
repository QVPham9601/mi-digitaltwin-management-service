#!/usr/bin/env python3
"""Per-answer correctness of the second held-out runs after manual adjudication
(decisions in heldout2/adjudication-*.json, applied here as code)."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.argv = [sys.argv[0], "--questions=heldout2/questions-heldout2-eval.json"]
sys.path.insert(0, str(HERE.parent))
import grade as g  # noqa: E402

# manual: {id: {condition: [rep1, rep2, rep3]}}; complete_ok / complete_wrong: complete-but-not-strict rows
RUNS = {
    "35b": ("heldout2-dgx-35b.jsonl",
            {"N11": {"A": [1, 1, 1], "C": [1, 1, 1]}, "N12": {"A": [1, 1, 1], "C": [1, 1, 1]},
             "N13": {"A": [1, 1, 1], "C": [1, 0, 1]}},
            {"complete_wrong": {("N15", "A", 1), ("N15", "A", 2), ("N15", "A", 3)}}),
    "opus": ("heldout2-claude-opus.jsonl",
             {"N11": {"C": [1, 1, 1]}, "N12": {"C": [1, 1, 1]}, "N13": {"C": [1, 1, 1]}},
             # N04: concludes HTTP-SIM and MMT-PROBE are "likely wired in" (stale descriptions)
             {"complete_wrong": {("N04", "C", 1), ("N04", "C", 2), ("N04", "C", 3)}}),
    "14b": ("heldout2-qwen3-14b.jsonl",
            {"N11": {"C": [1, 1, 1]}, "N12": {"C": [1, 1, 1]}, "N13": {"C": [1, 1, 1]}},
            {"complete_wrong": set()}),
}


def load(run):
    path, manual, ovr = RUNS[run]
    out = {}
    for line in (HERE.parent / "results" / path).read_text().splitlines():
        r = json.loads(line)
        k = (r["id"], r["condition"], r["rep"])
        gr = g.grade(g.QS[r["id"]], r["answer"])
        c = gr["correct"]
        if c is None:
            c = manual[r["id"]][r["condition"]][r["rep"] - 1]
        elif gr["complete"] and not c:
            c = k not in ovr["complete_wrong"]
        out[k] = (bool(c), r)
    return out


QS = g.QS
