#!/usr/bin/env python3
"""M1 live-state ground truth: computes each question's expected answer from a
state snapshot, in Python, independently of the TypeScript state executor
under test (otherwise the evaluation would be circular).

    cd server
    node scripts/evaluation-live-state/dump-state.mjs --label=t0      [or t1]
    python3 scripts/evaluation-dynamic-rag/../evaluation-live-state/ground_truth_state.py

Usage:
    python3 scripts/evaluation-live-state/ground_truth_state.py [snapshot.json]

With no argument it looks for state-snapshot-t1.json, then t0, then any
state-snapshot-*.json in its folder. It computes the answers for the specs in
QUESTIONS (the evaluating agent replaces the two EXAMPLE specs with real specs
from the user's questions) and prints one line per question:

    <id>\t<category>\t<answer>
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent

# Same staleness threshold as the TypeScript state route (env AGENT_STALE_RUN_MS).
STALE_RUN_MS = float(__import__("os").environ.get("AGENT_STALE_RUN_MS", 6 * 60 * 60 * 1000))

DEMO = "CI attack → MMT detection → AI4SOAR block"


# ---------------------------------------------------------------------------
# Spec machinery
#
# Spec keys:
#   table:     "runs" (default) or "runServices"
#   scenario:  scenario title the rows must belong to
#   select:    "latest" (newest runNumber per scenario in scope) |
#              "running" (status pending/running) | "all" (default)
#   runNumber: exact 1-based run number (1 = oldest)
#   where:     AND of (field, op, value[, negate])
#   whereAny:  OR of AND-groups (each a list of (field, op, value[, negate]))
#   group:     field to group by  (list fields group by each element)
#   agg:       list | count | min:<field> | max:<field> | rank:<field>
# ---------------------------------------------------------------------------
def load(snapshot: dict):
    """Flatten the snapshot into runs / runServices rows (the state tables)."""
    runs = []
    services = []
    reports = {
        (r["scenarioId"], r["executionId"]): r
        for r in snapshot.get("reports", [])
    }
    for scenario in snapshot.get("scenarios", []):
        title = scenario["title"]
        ordered = sorted(scenario.get("executions", []), key=lambda e: e["executedAt"])
        for index, execution in enumerate(ordered, start=1):
            report = reports.get((scenario["_id"], execution["executionId"]))
            executed_at = parse_date(execution["executedAt"])
            completed_at = execution.get("completedAt") or (report or {}).get("completedAt")
            metrics = (report or {}).get("metrics", {})
            alerts = (report or {}).get("alerts", [])
            attackers = sorted({a["attacker"] for a in alerts if a.get("attacker")})
            status = execution.get("status", "pending")
            age_ms = snapshot_time(snapshot) - executed_at.timestamp() * 1000
            runs.append(
                {
                    "scenario": title,
                    "runNumber": index,
                    "status": status,
                    "outcome": execution.get("outcome") or (report or {}).get("outcome"),
                    "executedBy": execution.get("executedBy", ""),
                    "executedAt": execution["executedAt"],
                    "completedAt": completed_at,
                    "durationMs": first_number(execution.get("durationMs"), (report or {}).get("durationMs")),
                    "alertsTotal": (metrics.get("alerts") or {}).get("total"),
                    "uniqueAttackers": (metrics.get("alerts") or {}).get("uniqueAttackers"),
                    "attackers": attackers,
                    "errorLines": (metrics.get("logs") or {}).get("errorLines"),
                    "warnings": (metrics.get("events") or {}).get("warnings"),
                    "restarts": (metrics.get("containers") or {}).get("restarts"),
                    "hasReport": report is not None,
                    "partial": bool((report or {}).get("partial")),
                    "suspectStale": (
                        status in ("pending", "running")
                        and not completed_at
                        and age_ms > STALE_RUN_MS
                    ),
                    # passthrough of raw values for the group-by keys
                    "service": None,
                }
            )
            report_services = {s["name"]: s for s in (report or {}).get("services", [])}
            traffic = {t["service"]: t for t in (report or {}).get("traffic", []) or []}
            for deployed in execution.get("deployedServices", []):
                name = deployed.get("name")
                if not name:
                    continue
                row_traffic = traffic.get(name, {})
                container_restarts = None
                services.append(
                    {
                        "scenario": title,
                        "runNumber": index,
                        "service": name,
                        "status": deployed.get("status") or (report_services.get(name) or {}).get("status"),
                        "up": row_traffic.get("up"),
                        "availability": row_traffic.get("availability"),
                        "errorRate": row_traffic.get("errorRate"),
                        "requestRate": row_traffic.get("requestRate"),
                        "latencyP95Ms": row_traffic.get("latencyP95Ms"),
                        # practical alias for questions on container restarts
                        "restarts": container_restarts,
                    }
                )
    return runs, services


def parse_date(value):
    return __import__("datetime").datetime.fromisoformat(value.replace("Z", "+00:00"))


def snapshot_time(snapshot: dict) -> float:
    """The "now" of the snapshot: its dump time (the live route reads at
    answer time; the ground truth reads at dump time)."""
    if "dumpedAt" in snapshot:
        return parse_date(snapshot["dumpedAt"]).timestamp() * 1000
    # A snapshot without a dump time: use the newest timestamp present.
    stamps = [parse_date(r["startedAt"]).timestamp() * 1000 for r in snapshot.get("reports", [])]
    return max(stamps) if stamps else 0.0


def first_number(*values):
    for value in values:
        if isinstance(value, (int, float)):
            return value
    return None


def match(row, pred):
    field, op, value, *neg = pred
    actual = row.get(field)
    if op == "eq":
        ok = actual == value if isinstance(actual, (str, type(None))) else actual == value
        if isinstance(actual, bool) or isinstance(value, bool):
            ok = actual is value if isinstance(actual, bool) and isinstance(value, bool) else str(actual).lower() == str(value).lower()
    elif op == "ne":
        ok = not match(row, (field, "eq", value))
    elif op == "in":
        ok = actual in value
    elif op == "contains":
        actual_text = actual if isinstance(actual, str) else ""
        ok = value in actual or value.lower() in str(actual).lower()
        if actual is None:
            ok = False
        del actual_text
    elif op in ("lt", "lte", "gt", "gte"):
        ok = actual is not None and {
            "lt": actual < value,
            "lte": actual <= value,
            "gt": actual > value,
            "gte": actual >= value,
        }[op]
    elif op in ("sizeEq", "sizeGte", "sizeLte"):
        size = len(actual) if isinstance(actual, list) else 0
        ok = {"sizeEq": size == value, "sizeGte": size >= value, "sizeLte": size <= value}[op]
    else:
        raise ValueError(op)
    return ok if not (neg and neg[0]) else not ok


def label(run):
    return f"run #{run['runNumber']} of \"{run['scenario']}\""


def service_row_label(row):
    return f"{row['service']} (run #{row['runNumber']} of \"{row['scenario']}\")"


def select_rows(spec, runs, services):
    """Apply the scope part of the spec: table, scenario, runNumber, select."""
    table = spec.get("table", "runs")
    rows = list(services) if table == "runServices" else list(runs)
    if spec.get("scenario"):
        rows = [r for r in rows if r["scenario"] == spec["scenario"]]
    if spec.get("runNumber"):
        rows = [r for r in rows if r["runNumber"] == spec["runNumber"]]
    select = spec.get("select", "all")
    if select == "running":
        rows = [r for r in rows if r.get("status") in ("pending", "running")]
    elif select == "latest":
        if spec.get("scenario"):
            top = max((r["runNumber"] for r in rows), default=None)
            rows = [r for r in rows if top is None or r["runNumber"] == top]
        else:
            top_by_scenario = {}
            for r in rows:
                top_by_scenario[r["scenario"]] = max(
                    top_by_scenario.get(r["scenario"], 0), r["runNumber"]
                )
            rows = [r for r in rows if top_by_scenario[r["scenario"]] == r["runNumber"]]
    return rows


def where_rows(rows, spec):
    def keep(row):
        for pred in spec.get("where", []):
            if not match(row, pred):
                return False
        groups = spec.get("whereAny", [])
        if groups:
            if not any(all(match(row, p) for p in group) for group in groups):
                return False
        return True

    return [r for r in rows if keep(r)]


def compute(spec, runs, services):
    rows = where_rows(select_rows(spec, runs, services), spec)
    numeric_run_fields = {
        "runNumber", "durationMs", "alertsTotal", "uniqueAttackers",
        "errorLines", "warnings", "restarts", "availability",
        "errorRate", "requestRate", "latencyP95Ms",
    }
    agg = spec.get("agg", "list")
    if agg == "count":
        return len(rows)
    if agg == "outcome":
        field_rows = rows
        if not field_rows:
            return "none"
        if len(field_rows) == 1:
            return field_rows[0].get("outcome") or "none"
        return {label(r): r.get("outcome") or "none" for r in field_rows}
    if agg in ("min", "max") or agg.startswith("min:") or agg.startswith("max:"):
        field = agg.split(":", 1)[1] if ":" in agg else spec.get("field")
        values = [r.get(field) for r in rows if isinstance(r.get(field), (int, float))]
        if not values:
            return None
        best = min(values) if agg.startswith("min") else max(values)
        winners = [
            (service_row_label(r) if spec.get("table") == "runServices" else label(r))
            for r in rows
            if r.get(field) == best
        ]
        return {"value": best, "runs": sorted(set(winners))}
    if agg.startswith("rank"):
        field = agg.split(":", 1)[1]
        def rank_value(r):
            v = r.get(field)
            return len(v) if isinstance(v, list) else v if isinstance(v, (int, float)) else 0
        return sorted(
            (
                {"run": service_row_label(r) if spec.get("table") == "runServices" else label(r),
                 "value": rank_value(r)}
                for r in rows
            ),
            key=lambda entry: (-entry["value"], entry["run"]),
        )
    if spec.get("group"):
        field = spec["group"]
        groups = defaultdict(list)
        for r in rows:
            value = r.get(field)
            keys = value if isinstance(value, list) else [value]
            for key in [k for k in keys if k is not None]:
                groups[key].append(
                    service_row_label(r) if spec.get("table") == "runServices" else label(r)
                )
        ordered = sorted(groups.items())
        result = {key: sorted(set(members)) for key, members in ordered}
        if agg == "argmaxCount":
            top = max(len(v) for v in groups.values())
            return {"keys": sorted(k for k, v in groups.items() if len(v) == top), "count": top}
        return result
    return sorted(
        service_row_label(r) if spec.get("table") == "runServices" else label(r) for r in rows
    )


# ---------------------------------------------------------------------------
# Questions: the evaluating agent writes the real specs from the user's
# questions. Below are two EXAMPLE specs only.
# ---------------------------------------------------------------------------
QUESTIONS = [
    {
        "id": "EXAMPLE-1",
        "category": "latest",
        "question": "What was the outcome of the last run of the demo scenario?",
        "spec": {
            "table": "runs",
            "scenario": DEMO,
            "select": "latest",
            "agg": "outcome",
        },
        # agg:"outcome" is sugar: the field to read off the selected rows.
        "aggField": "outcome",
    },
    {
        "id": "EXAMPLE-2",
        "category": "now",
        "question": "Is the demo scenario running right now?",
        "spec": {
            "table": "runs",
            "scenario": DEMO,
            "select": "running",
            "agg": "list",
        },
    },
]


def outcome_of(rows):
    if not rows:
        return "none"
    if len(rows) == 1:
        return rows[0].get("outcome") or "none"
    return {label(r): r.get("outcome") or "none" for r in rows}


def main():
    snapshot_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if snapshot_path is None:
        for pattern in ("state-snapshot-t1.json", "state-snapshot-t0.json"):
            candidates = sorted(HERE.glob(pattern))
            if candidates:
                snapshot_path = candidates[0]
                break
    if snapshot_path is None:
        candidates = sorted(HERE.glob("state-snapshot-*.json"))
        if not candidates:
            raise SystemExit(
                "no state snapshot: run dump-state.mjs --label=t0 (or t1) first"
            )
        snapshot_path = candidates[0]

    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    runs, services = load(snapshot)
    print(f"# ground truth from {snapshot_path.name}"
          f" ({len(runs)} runs, {len(services)} run-service rows)")
    for question in QUESTIONS:
        spec = question["spec"]
        answer = compute(spec, runs, services)
        print(f"{question['id']}\t{question['category']}\t{json.dumps(answer, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
