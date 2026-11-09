#!/usr/bin/env python3
"""Held-out set: ground truth computed from the catalog snapshot, like ground_truth.py.

    python3 scripts/evaluation-dynamic-rag/heldout/ground_truth_heldout.py
    # -> heldout/questions-heldout-eval.json (runner/grader format) + a diff against myAnswer

Extra expected types (graded by grade.py): "set" may carry `optional` (extras that
are not wrong), "ranking" (ordered head + optional tie), "labels" (all labels
named), "manual" (yes/no or free-text answers, adjudicated by hand).
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from ground_truth import NOT, PARTNER, MTI, TEC, DEMO, evaluate, render  # noqa: E402

SNAP = json.loads((HERE.parent / "catalog-snapshot.json").read_text())
SERVICES, SCENARIOS = SNAP["services"], SNAP["scenarios"]


def where(fn):
    return {"type": "set", "value": sorted(s["shortName"] for s in SERVICES if fn(s))}


def by_standards(n):
    return sorted((s for s in SERVICES if len(s["standards"]) >= n), key=lambda s: -len(s["standards"]))


SPECS = {
    "H01": {"type": "set", "value": ["CI-SIM"], "optional": ["SECSIM"]},
    "H02": {"where": [TEC], "agg": "list"},
    "H03": {"where": [("sector", "eq", "Energy")], "agg": "list"},
    "H04": {"where": [NOT(("type", "eq", "Software"))], "agg": "list"},
    "H05": {"where": [NOT(("license", "eq", "TBD"))], "agg": "list"},
    "H06": {"where": [("category", "eq", "5G Testbeds"), NOT(("provider", "eq", "ORO (Orange Romania)"))], "agg": "list"},
    "H07": {"where": [("trlCurrent", "lt", 4)], "agg": "list"},
    "H08": {"where": [("trlCurrent", "eq", 9)], "agg": "list"},
    "H09": where(lambda s: s["category"] in ("Dev Services", "Ops Services") and s["shortName"] != "KAFKA"
                 and s["trlCurrent"] >= 5),
    "H10": {"where": [MTI], "agg": "count"},
    "H11": {"where": [("type", "eq", "Software")], "agg": "count"},
    "H12": {"where": [("potentialUseCases", "contains", "UC5 - Smart Charging Stations")], "agg": "count"},
    "H13": {"where": [], "agg": "min:trlCurrent"},
    "H14": {"where": [MTI], "agg": "max:trlCurrent"},
    "H15": {"scenario": DEMO, "where": [], "agg": "max:trlCurrent"},
    "H16": {"where": [], "group": "provider", "agg": "argmaxCount"},
    "H17": {"where": [PARTNER], "group": "sector", "agg": "argmaxCount"},
    "H18": {"where": [PARTNER], "group": "potentialUseCases", "agg": "argmaxCount"},
    "H19": {"where": [("sector", "eq", "Energy"), ("type", "eq", "Hardware")], "agg": "list"},
    "H20": {"where": [MTI, ("trlExpected", "eq", 8), ("trlCurrent", "lte", 6)], "agg": "list"},
    "H21": {"where": [("category", "eq", "Ops Services"), ("provider", "eq", "SINTEF (STF)")], "agg": "list"},
    "H22": {"scenario": DEMO, "where": [], "agg": "list"},
    "H23": {"notInScenario": DEMO, "where": [], "agg": "list"},
    "H24": {"type": "value", "value": next(s["provider"] for s in SERVICES if s["shortName"] == "KAFKA")},
    "H25": where(lambda s: s["provider"] in ("Fraunhofer Fokus (FF)", "CERTH")),
    "H26": where(lambda s: len(s["standards"]) >= 2),
    "H27": {"type": "ranking", "value": [s["shortName"] for s in by_standards(2)],
            "optional": [s["shortName"] for s in SERVICES if len(s["standards"]) == 1]},
    "H28": {"type": "manual", "value": "No service is in every scenario (the DDoS attack scenario is empty)"
            if any(not sc["services"] for sc in SCENARIOS) else "intersection"},
    "H29": where(lambda s: "ISO/IEC 27001" in s["standards"]),
    "H30": where(lambda s: s["type"] == "Hardware" and s["uiType"] == "terminal"),
    "H31": {"type": "manual", "value": "SECATTSIM: adversarial AI attack simulation (white/black-box, RL-guided and LLM-generated) for operations"},
    "H32": {"type": "value", "value": next(s["license"] for s in SERVICES if s["shortName"] == "MMT-PROBE")},
    "H33": {"type": "set", "value": ["MMT-PROBE", "SECANOD"], "optional": ["SECOPSTWIN"]},
    "H34": {"type": "labels", "value": next(s["standards"] for s in SERVICES if s["shortName"] == "CSAM")},
    "H35": {"type": "value", "value": next(s["trlExpected"] for s in SERVICES if s["shortName"] == "SECNCD")},
}


def main():
    src = json.loads((HERE / "questions-heldout.json").read_text())
    out = []
    for q in src["questions"]:
        spec = SPECS[q["id"]]
        exp = spec if "type" in spec else evaluate(spec, SERVICES, SCENARIOS)
        gt = render(exp) if exp["type"] in ("set", "number", "extremum", "argmax", "value") else str(exp["value"])
        if exp.get("optional"):
            gt += f" (also acceptable: {', '.join(exp['optional'])})"
        out.append({"id": q["id"], "category": q["category"], "expectedIntent": "service",
                    "expectedRoute": q["expectedRoute"], "question": q["question"],
                    "groundTruth": gt, "expected": exp, "authorAnswer": q["myAnswer"]})
        print(f"{q['id']} | computed: {gt}\n    | author:   {q['myAnswer']}")
    (HERE / "questions-heldout-eval.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
