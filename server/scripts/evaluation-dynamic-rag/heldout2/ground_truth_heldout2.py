#!/usr/bin/env python3
"""Second held-out set: ground truth computed from the catalog snapshot.

    python3 scripts/evaluation-dynamic-rag/heldout2/ground_truth_heldout2.py
    # -> heldout2/questions-heldout2-eval.json (runner/grader format) + a diff against myAnswer
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from ground_truth import NOT, MTI, TEC, DEMO, evaluate, render  # noqa: E402

SNAP = json.loads((HERE.parent / "catalog-snapshot.json").read_text())
SERVICES, SCENARIOS = SNAP["services"], SNAP["scenarios"]


def where(fn):
    return {"type": "set", "value": sorted(s["shortName"] for s in SERVICES if fn(s))}


def ranked(rows, key):
    rows = sorted(rows, key=lambda s: -key(s))
    return rows


one_standard = [s["shortName"] for s in SERVICES if len(s["standards"]) == 1]
mti = [s for s in SERVICES if s["provider"] == "Montimage (MTI)"]
top_trl = max(s["trlCurrent"] for s in mti)

SPECS = {
    "N01": {"type": "value", "value": next(s["provider"] for s in SERVICES if s["shortName"] == "SECINTERP")},
    "N02": where(lambda s: s["provider"] in ("ORO (Orange Romania)", "AALTO")),
    "N03": where(lambda s: s["sector"] in ("Energy", "Health") and s["type"] == "Software"),
    "N04": {"notInScenario": DEMO, "where": [MTI], "agg": "list"},
    "N05": {"where": [("standards", "contains", "3GPP"), NOT(("provider", "eq", "ORO (Orange Romania)"))], "agg": "list"},
    "N06": where(lambda s: len(s["standards"]) >= 2),
    "N07": {"where": [("repositoryTable", "eq", "INTACT_TOOLBOX"), ("trlCurrent", "gte", 7)], "agg": "list"},
    "N08": where(lambda s: len(s["standards"]) == 1),
    # Ranking: the top service must come first; every Montimage entry may be named.
    # The order is checked on one service per distinct TRL (7, 5, 4); the TRL-6 tie must be named too.
    "N09": {"type": "ranking", "value": ["MMT-PROBE", "AI4SOAR", "SECSIM"],
            "alsoRequired": sorted(s["shortName"] for s in mti if s["trlCurrent"] == 6),
            "optional": sorted(s["shortName"] for s in mti if s["trlCurrent"] == 6)},
    "N10": {"type": "ranking", "value": [s["shortName"] for s in ranked([s for s in SERVICES if len(s["standards"]) >= 2], lambda s: len(s["standards"]))],
            "optional": one_standard},
    "N11": where(lambda s: s["provider"] == "Tecnalia (TEC)" and s["trlCurrent"] >= 6),
    "N12": where(lambda s: s["provider"] in ("SINTEF (STF)", "TELLU AS") and s["type"] == "Hardware"),
    "N13": where(lambda s: s["category"] == "5G Testbeds" and s["trlCurrent"] < 9),
    "N14": where(lambda s: s["sector"] == "Manufacturing" and s["type"] == "Hardware" and s["provider"] == "ITP Aero"),
    "N15": where(lambda s: s["type"] == "Software/Hardware" and s["provider"] in ("ITP Aero", "IDEKO", "SAVVY (Savvy Data Systems)")
                 and s["sector"] == "Manufacturing"),
}


def main():
    src = json.loads((HERE / "questions-heldout2.json").read_text())
    out = []
    for q in src["questions"]:
        spec = SPECS[q["id"]]
        exp = spec if "type" in spec else evaluate(spec, SERVICES, SCENARIOS)
        gt = render(exp) if exp["type"] in ("set", "number", "extremum", "argmax", "value") else str(exp["value"])
        if exp.get("optional"):
            gt += f" (may also name: {', '.join(exp['optional'])})"
        out.append({"id": q["id"], "category": q["category"], "expectedIntent": "service",
                    "expectedRoute": q["expectedRoute"], "question": q["question"],
                    "groundTruth": gt, "expected": exp, "authorAnswer": q["myAnswer"]})
        print(f"{q['id']} | computed: {gt}\n    | author:   {q['myAnswer']}")
    (HERE / "questions-heldout2-eval.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
