#!/usr/bin/env python3
"""Per-answer correctness of the held-out runs after manual adjudication.

Applies the decisions recorded in heldout/adjudication-*.json to grade.py's
automatic grading, so later analyses (e.g. cascade_offline.py) reuse one source.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.argv = [sys.argv[0], "--questions=heldout/questions-heldout-eval.json"]
sys.path.insert(0, str(HERE.parent))
import grade as g  # noqa: E402

MANUAL = {"H28": False, "H29": True, "H30": True, "H31": True}
RUNS = {
    "14b": ("heldout-qwen3-14b.jsonl", MANUAL,
            {("H06", "A"): True, ("H14", "A"): True, ("H19", "A", 1): True, ("H19", "A", 2): True,
             ("H26", "A", 1): True, ("H26", "A", 2): True}),
    "35b": ("heldout-dgx-35b.jsonl", MANUAL,
            {("H09", "C"): True, ("H14", "A"): True, ("H15", "C"): True, ("H19", "A"): True,
             ("H26", "A"): True, ("H33", "A", 1): True, ("H33", "A", 2): True}),
    # Opus: every complete-but-not-strict answer is correct except the listed ones.
    "opus": ("heldout-claude-opus.jsonl", {**MANUAL, "H28": {"A": False, "C": True}},
             {"complete_ok_except": {("H26", "C", 3), ("H27", "C", 3), ("H27", "A", 1), ("H27", "A", 2), ("H27", "A", 3)}}),
}


def load(run):
    """{(id, condition, rep): (correct: bool, row)} for one run."""
    path, manual, ovr = RUNS[run]
    out = {}
    for line in (HERE.parent / "results" / path).read_text().splitlines():
        r = json.loads(line)
        k = (r["id"], r["condition"], r["rep"])
        gr = g.grade(g.QS[r["id"]], r["answer"])
        c = gr["correct"]
        if c is None:
            m = manual[r["id"]]
            c = m[r["condition"]] if isinstance(m, dict) else m
        elif "complete_ok_except" in ovr:
            if gr["complete"] and not c:
                c = k not in ovr["complete_ok_except"]
        else:
            c = ovr.get(k, ovr.get(k[:2], c))
        out[k] = (bool(c), r)
    return out


QS = g.QS
