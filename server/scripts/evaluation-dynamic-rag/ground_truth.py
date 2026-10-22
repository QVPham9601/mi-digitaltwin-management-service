#!/usr/bin/env python3
"""Dynamic-RAG question set: computes every ground truth from a catalog dump.

The ground truth is computed here, in Python, independently of the TypeScript
structured executor under test (otherwise the evaluation would be circular).

    cd server
    node scripts/evaluation-dynamic-rag/dump-catalog.mjs      # -> catalog-snapshot.json
    python3 scripts/evaluation-dynamic-rag/ground_truth.py    # -> questions-dynamic-rag.json + QUESTIONS.md

Each question has a `spec` (a small query over the catalog fields) and the
answer computed from it. `expectedRoute` is what a correct router should choose:
"structured" (aggregate / constraint) or "lookup" (single-service fact, the
control questions).
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
SNAPSHOT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "catalog-snapshot.json"

PARTNER = ("license", "eq", "N/A (Partner Infrastructure)")
TOOLBOX = ("repositoryTable", "eq", "INTACT_TOOLBOX")
MTI = ("provider", "eq", "Montimage (MTI)")
TEC = ("provider", "eq", "Tecnalia (TEC)")
DEMO = "CI attack → MMT detection → AI4SOAR block"


def NOT(pred):
    return (*pred, True)


# category, question, spec. spec keys:
#   scenario: restrict to the services of that scenario (join)
#   where:    AND of (field, op, value[, negate])
#   group:    field to group by (list fields group by each element); groupPrefix filters keys
#   agg:      list | count | min:<field> | max:<field> | argmaxCount | countPerGroup | listPerGroup
QUESTIONS = [
    # --- filter -------------------------------------------------------------
    ("filter", "List all services provided by SINTEF.",
     {"where": [("provider", "eq", "SINTEF (STF)")], "agg": "list"}),
    ("filter", "Which services are in the Monitor category?",
     {"where": [("category", "eq", "Monitor")], "agg": "list"}),
    ("filter", "Which partner infrastructures belong to the Energy sector?",
     {"where": [PARTNER, ("sector", "eq", "Energy")], "agg": "list"}),
    ("filter", "Which services implement the 3GPP standard?",
     {"where": [("standards", "contains", "3GPP")], "agg": "list"}),
    ("filter", "Which services support the UC3 Renewable Prosumer Energy use case?",
     {"where": [("potentialUseCases", "contains", "UC3 - Renewable Prosumer Energy")], "agg": "list"}),
    # --- negation -----------------------------------------------------------
    ("negation", "Which Montimage services are not in the Ops Services category?",
     {"where": [MTI, NOT(("category", "eq", "Ops Services"))], "agg": "list"}),
    ("negation", "Which Dev Services tools are not provided by Tecnalia?",
     {"where": [("category", "eq", "Dev Services"), NOT(TEC)], "agg": "list"}),
    ("negation", "Which partner infrastructures are not hardware?",
     {"where": [PARTNER, NOT(("type", "eq", "Hardware"))], "agg": "list"}),
    # --- numeric comparison -------------------------------------------------
    ("comparison", "Which Tecnalia services have a current TRL below 4?",
     {"where": [TEC, ("trlCurrent", "lt", 4)], "agg": "list"}),
    ("comparison", "Which toolbox services have a current TRL of 6 or higher?",
     {"where": [TOOLBOX, ("trlCurrent", "gte", 6)], "agg": "list"}),
    ("comparison", "Which Dev Services tools are expected to reach a TRL above 7?",
     {"where": [("category", "eq", "Dev Services"), ("trlExpected", "gt", 7)], "agg": "list"}),
    # --- count --------------------------------------------------------------
    ("count", "How many services does Montimage provide?",
     {"where": [MTI], "agg": "count"}),
    ("count", "How many partner infrastructures are hardware?",
     {"where": [PARTNER, ("type", "eq", "Hardware")], "agg": "count"}),
    ("count", "How many services are in the Dev Services category?",
     {"where": [("category", "eq", "Dev Services")], "agg": "count"}),
    # --- min / max ----------------------------------------------------------
    ("min-max", "Among all Montimage services, which one has the lowest current TRL?",
     {"where": [MTI], "agg": "min:trlCurrent"}),
    ("min-max", "Which Dev Services tool has the highest current TRL?",
     {"where": [("category", "eq", "Dev Services")], "agg": "max:trlCurrent"}),
    ("min-max", "What is the lowest current TRL among Tecnalia's services?",
     {"where": [TEC], "agg": "min:trlCurrent"}),
    # --- group-by -----------------------------------------------------------
    ("group-by", "Which provider has the most services in the Dev Services category?",
     {"where": [("category", "eq", "Dev Services")], "group": "provider", "agg": "argmaxCount"}),
    ("group-by", "How many services does each provider have in the Ops Services category?",
     {"where": [("category", "eq", "Ops Services")], "group": "provider", "agg": "countPerGroup"}),
    ("group-by", "For each project use case UC1 to UC5, which partner infrastructure supports it?",
     {"where": [PARTNER], "group": "potentialUseCases", "groupPrefix": "UC", "agg": "listPerGroup"}),
    ("group-by", "Which sector has the most partner infrastructures?",
     {"where": [PARTNER], "group": "sector", "agg": "argmaxCount"}),
    # --- multi-constraint (AND of 2-3) --------------------------------------
    ("multi-constraint", "Which Montimage services in the Monitor category have a current TRL of at least 7?",
     {"where": [MTI, ("category", "eq", "Monitor"), ("trlCurrent", "gte", 7)], "agg": "list"}),
    ("multi-constraint", "Which partner infrastructures are in the Manufacturing sector and are hardware?",
     {"where": [PARTNER, ("sector", "eq", "Manufacturing"), ("type", "eq", "Hardware")], "agg": "list"}),
    ("multi-constraint", "Which Dev Services tools from Tecnalia have a current TRL of 4?",
     {"where": [("category", "eq", "Dev Services"), TEC, ("trlCurrent", "eq", 4)], "agg": "list"}),
    ("multi-constraint", "Which 5G testbeds are provided by Orange Romania?",
     {"where": [("category", "eq", "5G Testbeds"), ("provider", "eq", "ORO (Orange Romania)")], "agg": "list"}),
    ("multi-constraint", "Which Montimage services in the Target category have a current TRL of 6?",
     {"where": [MTI, ("category", "eq", "Target"), ("trlCurrent", "eq", 6)], "agg": "list"}),
    # --- scenario join ------------------------------------------------------
    ("scenario-join", f"Which services in the '{DEMO}' scenario are not software-only web tools?",
     {"scenario": DEMO, "where": [NOT(("type", "eq", "Software")), ], "agg": "list", "or_not_web": True}),
    ("scenario-join", "Which providers supply the services used in the attack-detect-respond scenario?",
     {"scenario": DEMO, "where": [], "group": "provider", "agg": "listPerGroup"}),
    ("scenario-join", "What is the lowest current TRL among the services of the attack-detect-respond scenario?",
     {"scenario": DEMO, "where": [], "agg": "min:trlCurrent"}),
    ("scenario-join", "Which services in the Target category are not used in the attack-detect-respond scenario?",
     {"where": [("category", "eq", "Target")], "notInScenario": DEMO, "agg": "list"}),
    # --- lookup controls (single-service facts; a router should pick "lookup") --
    ("lookup-control", "Who provides SECSAC?", {"service": "SECSAC", "field": "provider"}),
    ("lookup-control", "What is the current TRL of MMT-PROBE?", {"service": "MMT-PROBE", "field": "trlCurrent"}),
    ("lookup-control", "Which category is TELLU-CARE in?", {"service": "TELLU-CARE", "field": "category"}),
    ("lookup-control", "Is ITPAERO-CFAA a software or a hardware resource?", {"service": "ITPAERO-CFAA", "field": "type"}),
    ("lookup-control", "Which use case does TELLU-CARE support?", {"service": "TELLU-CARE", "field": "potentialUseCases"}),
    ("lookup-control", "Which sector is AST-DEDISRV in?", {"service": "AST-DEDISRV", "field": "sector"}),
]


def match(row, pred):
    field, op, value, *neg = pred
    v = row[field]
    if op == "eq":
        ok = v == value
    elif op == "contains":
        ok = value in v
    elif op in ("lt", "lte", "gt", "gte"):
        ok = v is not None and {"lt": v < value, "lte": v <= value, "gt": v > value, "gte": v >= value}[op]
    else:
        raise ValueError(op)
    return not ok if (neg and neg[0]) else ok


def evaluate(spec, services, scenarios):
    if "service" in spec:  # lookup control
        row = next(s for s in services if s["shortName"] == spec["service"])
        return {"type": "value", "value": row[spec["field"]]}
    rows = services
    if "scenario" in spec:
        members = next(sc["services"] for sc in scenarios if sc["title"] == spec["scenario"])
        rows = [r for r in rows if r["shortName"] in members]
    if "notInScenario" in spec:
        members = next(sc["services"] for sc in scenarios if sc["title"] == spec["notInScenario"])
        rows = [r for r in rows if r["shortName"] not in members]
    if spec.get("or_not_web"):  # "not software-only web" = NOT(type=Software AND uiType=web)
        rows = [r for r in rows if not (r["type"] == "Software" and r["uiType"] == "web")]
    else:
        rows = [r for r in rows if all(match(r, p) for p in spec["where"])]
    agg = spec["agg"]
    if "group" in spec:
        groups = defaultdict(list)
        for r in rows:
            keys = r[spec["group"]] if isinstance(r[spec["group"]], list) else [r[spec["group"]]]
            for k in keys:
                if k is not None and k.startswith(spec.get("groupPrefix", "")):
                    groups[k].append(r["shortName"])
        groups = {k: sorted(v) for k, v in sorted(groups.items())}
        if agg == "listPerGroup":
            return {"type": "groups", "value": groups}
        if agg == "countPerGroup":
            return {"type": "counts", "value": {k: len(v) for k, v in groups.items()}}
        if agg == "argmaxCount":
            top = max(len(v) for v in groups.values())
            return {"type": "argmax", "value": sorted(k for k, v in groups.items() if len(v) == top),
                    "count": top, "groups": groups}
    names = sorted(r["shortName"] for r in rows)
    if agg == "list":
        return {"type": "set", "value": names}
    if agg == "count":
        return {"type": "number", "value": len(names), "services": names}
    op, field = agg.split(":")
    vals = [r[field] for r in rows if r[field] is not None]
    best = min(vals) if op == "min" else max(vals)
    return {"type": "extremum", "value": best,
            "services": sorted(r["shortName"] for r in rows if r[field] == best)}


def render(ans):
    t, v = ans["type"], ans["value"]
    if t == "set":
        return ", ".join(v) if v else "none (empty set)"
    if t == "number":
        return f"{v} ({', '.join(ans['services'])})"
    if t == "extremum":
        return f"{v} ({', '.join(ans['services'])})"
    if t == "argmax":
        return f"{', '.join(v)} ({ans['count']})"
    if t == "counts":
        return "; ".join(f"{k}: {n}" for k, n in v.items())
    if t == "groups":
        return "; ".join(f"{k}: {', '.join(s)}" for k, s in v.items())
    return ", ".join(v) if isinstance(v, list) else str(v)


def main():
    snap = json.loads(SNAPSHOT.read_text())
    services, scenarios = snap["services"], snap["scenarios"]
    out, md = [], [
        "# Dynamic-RAG question set — for review",
        "",
        f"Ground truth computed by `ground_truth.py` from `{SNAPSHOT.name}` "
        f"(dumped {snap.get('dumpedAt', '?')}, {len(services)} active services).",
        "",
        "| id | operation | route | question | ground truth |",
        "|---|---|---|---|---|",
    ]
    for i, (cat, q, spec) in enumerate(QUESTIONS, 1):
        ans = evaluate(spec, services, scenarios)
        route = "lookup" if cat == "lookup-control" else "structured"
        qid = f"DR{i:02d}"
        out.append({"id": qid, "category": cat, "expectedIntent": "service", "expectedRoute": route,
                    "question": q, "groundTruth": render(ans), "expected": ans,
                    "spec": json.loads(json.dumps(spec, default=list))})
        md.append(f"| {qid} | {cat} | {route} | {q} | {render(ans)} |")
    (HERE / "questions-dynamic-rag.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    (HERE / "QUESTIONS.md").write_text("\n".join(md) + "\n")
    print(f"{len(out)} questions → questions-dynamic-rag.json, QUESTIONS.md")


if __name__ == "__main__":
    main()
