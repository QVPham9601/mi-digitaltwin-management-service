#!/usr/bin/env python3
"""AI4SOAR decision engine in recommendation-only mode (IMPLEMENTATION.md §4.2).

Stands in for the secsim stub's reaction role with the real AI4SOAR decision
engine:

  - serve GET /health on :5000 so the platform readiness gate passes;
  - consume the MMT security reports SECANOD publishes on Kafka
    (KAFKA_TOPIC from KAFKA_BOOTSTRAP_SERVERS, with retries while Kafka
    starts);
  - group the alert flood into one incident per (rule, attacker) with a
    quiet gap of ~30 s, so hundreds of reports give one recommendation;
  - for each incident: map the raw MMT report to the envelope AI4SOAR's MMT
    adapter expects, enrich, run the orchestrator (paths A and C — the LLM
    paths B and D stay off without an API key), and print ONE JSON line
    with the recommended mitigation — and execute nothing: no Shuffle, no
    OpenSearch, no call to CI-SIM. Kafka is the only outbound traffic.

The platform copies container logs into each run's execution report, so the
JSON line on stdout is how the twin records the recommendation.

Offline mode (the §5 offline test, no Kafka, no HTTP server):
    RECOMMEND_OFFLINE=<file> python recommend.py
where <file> is a JSON array of raw MMT report lines (or JSONL); the
incidents built from it are recommended and printed, then the process exits.

Wrapping, not patching: the ai4soar/ sources run unmodified. The only
adaptation is the report→envelope map in `mmt_report_to_alert`, which lives
here because AI4SOAR's MMT adapter expects {"type", "payload": {...}} while
SECANOD publishes the raw MMT JSON report array.
"""

import json
import os
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from kafka import KafkaConsumer
from kafka.errors import KafkaError

from core.config import config
from core.intelligent_orchestration.enrichment.pipeline import EnrichmentPipeline
from core.intelligent_orchestration.orchestrator import PlaybookOrchestrator

log = logging.getLogger('recommend')

HEALTH_PORT = int(os.environ.get('PORT', '5000'))
TOPIC = os.environ.get('KAFKA_TOPIC', 'mmt-security-alerts')
BOOTSTRAP = os.environ.get('KAFKA_BOOTSTRAP_SERVERS')
QUIET_GAP_S = float(os.environ.get('RECOMMEND_QUIET_GAP_S', '30'))
FLUSH_CHECK_S = float(os.environ.get('RECOMMEND_FLUSH_CHECK_S', '5'))
K = int(os.environ.get('RECOMMEND_K', '3'))
OFFLINE_FILE = os.environ.get('RECOMMEND_OFFLINE')

logging.basicConfig(level=logging.INFO, format='[ai4soar] %(message)s')


# ---------------------------------------------------------------------------
# MMT report → AI4SOAR MMT adapter envelope
# ---------------------------------------------------------------------------

def mmt_report_attacker(report):
    """Attacker source address of a raw MMT JSON report — the array
    [10, probe, iface, ts, rule, verdict, type, description, events] whose
    event_1.attributes carries ["ip.src", <addr>] (the same parse the stub
    uses; event_1 is the attacker→target packet of the rule's signature)."""
    if not (isinstance(report, list) and len(report) >= 9 and report[0] == 10):
        return None
    events = report[8] if isinstance(report[8], dict) else {}
    first = events.get('event_1') if isinstance(events.get('event_1'), dict) else {}
    for pair in first.get('attributes', []) or []:
        if isinstance(pair, list) and len(pair) == 2 and pair[0] in ('ip.src', 'ipv6.src'):
            return str(pair[1]).strip() or None
    return None


def mmt_report_dst(report):
    """Destination address from event_1 — the attack's target."""
    events = report[8] if isinstance(report[8], dict) else {}
    first = events.get('event_1') if isinstance(events.get('event_1'), dict) else {}
    for pair in first.get('attributes', []) or []:
        if isinstance(pair, list) and len(pair) == 2 and pair[0] in ('ip.dst', 'ipv6.dst'):
            return str(pair[1]).strip() or None
    return None


def mmt_report_to_alert(report):
    """Map a raw MMT JSON report array to the envelope AI4SOAR's MMT adapter
    expects (core/intelligent_orchestration/enrichment/adapters/mmt.py):
    {"type": "security", "payload": {probeId, timestamp, code, status,
    category, description, srcIp, dstIp, details}}. Returns None for reports
    that are not security detections."""
    if not (isinstance(report, list) and len(report) >= 9 and report[0] == 10):
        return None
    if report[5] not in ('detected', 'not_respected'):
        return None
    attacker = mmt_report_attacker(report)
    if not attacker:
        return None
    return {
        'type': 'security',
        'payload': {
            'probeId': report[1],
            'timestamp': report[3],
            'code': report[4],
            'status': report[5],
            'category': report[6],
            'description': report[7],
            'srcIp': attacker,
            'dstIp': mmt_report_dst(report),
            'details': {'iface': report[2], 'events': report[8]},
        },
    }


# ---------------------------------------------------------------------------
# Incident grouping — one recommendation per (rule, attacker) flood
# ---------------------------------------------------------------------------

class IncidentStore:
    """Open incidents keyed by (rule code, attacker), flushed as one
    recommendation after a quiet gap of QUIET_GAP_S without a new report."""

    def __init__(self):
        self.lock = threading.Lock()
        self.open = {}  # (rule, attacker) -> incident dict

    def add(self, report):
        attacker = mmt_report_attacker(report)
        rule = report[4] if len(report) > 4 else None
        key = (rule, attacker)
        with self.lock:
            incident = self.open.get(key)
            if incident is None:
                incident = {
                    'rule': rule,
                    'attacker': attacker,
                    'alerts': [],
                    'first_ts': time.time(),
                    'last_ts': time.time(),
                }
                self.open[key] = incident
            incident['alerts'].append(report)
            incident['last_ts'] = time.time()
            # Keep the memory bounded on a long flood: the first report feeds
            # the enrichment, the rest only count.
            if len(incident['alerts']) > 1000:
                del incident['alerts'][500:-1]

    def flush(self, now=None):
        """Close and return every incident whose last report is older than
        the quiet gap (all of them when now is None — shutdown / offline)."""
        with self.lock:
            if now is None:
                closed = list(self.open.values())
                self.open.clear()
                return closed
            closed = [
                incident for key, incident in self.open.items()
                if now - incident['last_ts'] >= QUIET_GAP_S
            ]
            for incident in closed:
                self.open.pop(
                    (incident['rule'], incident['attacker']), None
                )
            return closed


# ---------------------------------------------------------------------------
# Recommendation — the decision path, and nothing else
# ---------------------------------------------------------------------------

PIPELINE = EnrichmentPipeline()
ORCHESTRATOR = PlaybookOrchestrator()


def recommend(incident):
    """Enrich the incident's first alert, run the orchestrator, and print the
    recommendation as one JSON line plus a readable summary. Never executes
    a step — execution (Shuffle) is not even imported."""
    rule, attacker, alerts = incident['rule'], incident['attacker'], incident['alerts']
    alert = mmt_report_to_alert(alerts[0])
    if alert is None:
        log.warning('incident rule=%s attacker=%s has no usable report', rule, attacker)
        return
    enriched = PIPELINE.enrich(alert)
    result = ORCHESTRATOR.orchestrate(enriched, k=K)

    playbook = result.playbooks[0] if result.playbooks else None
    cacao = (playbook or {}).get('cacao', {})
    steps = [
        step.get('name', '?')
        for step in (cacao.get('workflow', {}) or {}).values()
        if isinstance(step, dict) and step.get('type') != 'end'
    ]
    line = {
        'ai4soar': 'recommendation',
        'ruleId': str(rule) if rule is not None else None,
        'attacker': attacker,
        'alertCount': len(alerts),
        'technique': (result.technique_ids or [None])[0],
        'playbookId': (playbook or {}).get('id'),
        'playbookName': cacao.get('name') or (playbook or {}).get('name'),
        'score': round(result.confidence, 4),
        'path': result.paths_used,
        'steps': steps,
        'executed': False,
    }
    # stdout is what the platform copies into the run's execution report.
    print(json.dumps(line), flush=True)

    params = ' '.join(
        f'{k}={v}' for k, v in (playbook or {}).get('parameters_filled', {}).items()
    ) or '(no parameters filled)'
    missing = (playbook or {}).get('parameters_missing', [])
    log.info(
        'recommendation for rule=%s attacker=%s (%d alerts): technique=%s '
        'playbook=%s score=%.3f paths=%s — NOT executed%s',
        rule, attacker, len(alerts), line['technique'], line['playbookId'],
        result.confidence, result.paths_used,
        f' (missing parameters: {", ".join(missing)})' if missing else '',
    )
    if playbook:
        log.info('summary: %s — %s (%s)', line['playbookName'], params, ', '.join(steps) or 'no steps')


# ---------------------------------------------------------------------------
# Health endpoint — the platform readiness gate hits GET /health on :5000
# ---------------------------------------------------------------------------

def serve_health():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — stdlib hook name
            body = (
                json.dumps({
                    'status': 'healthy',
                    'service': 'AI4SOAR',
                    'mode': 'recommendation-only',
                }) + '\n'
            ).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            log.info(fmt % args)

    server = ThreadingHTTPServer(('0.0.0.0', HEALTH_PORT), Handler)
    log.info('health on :%d', HEALTH_PORT)
    server.serve_forever()


# ---------------------------------------------------------------------------
# Kafka consumption with retries while the broker starts
# ---------------------------------------------------------------------------

def consume_forever(store):
    while True:
        try:
            # earliest + a short metadata refresh: the topic is auto-created
            # by the first report, possibly before this consumer is assigned
            # it — those early reports must not be skipped.
            consumer = KafkaConsumer(
                TOPIC,
                bootstrap_servers=BOOTSTRAP,
                auto_offset_reset='earliest',
                group_id='ai4soar',
                metadata_max_age_ms=5000,
                value_deserializer=lambda raw: json.loads(raw.decode('utf-8')),
            )
            break
        except (KafkaError, OSError) as exc:
            log.warning('kafka %s not ready: %s', BOOTSTRAP, exc)
            time.sleep(3)

    log.info('consuming kafka %s topic %s (quiet gap %.0fs)', BOOTSTRAP, TOPIC, QUIET_GAP_S)
    try:
        for message in consumer:
            report = message.value
            if isinstance(report, list):
                store.add(report)
    finally:
        for incident in store.flush():
            recommend(incident)


def flusher(store):
    """Close incidents that went quiet while no new report arrives — without
    this the last incident of a run would never be recommended."""
    while True:
        time.sleep(FLUSH_CHECK_S)
        try:
            for incident in store.flush(now=time.time()):
                recommend(incident)
        except Exception as exc:  # keep flushing after one bad incident
            log.exception('flush failed: %s', exc)


def offline(path):
    """RECOMMEND_OFFLINE: recommend incidents from a file of raw MMT report
    lines (JSON array or JSONL) without Kafka or the health server."""
    with open(path, 'r', encoding='utf-8') as handle:
        text = handle.read().strip()
    try:
        reports = json.loads(text)
        if not isinstance(reports, list):
            raise ValueError('not a JSON array')
    except ValueError:
        reports = [json.loads(line) for line in text.splitlines() if line.strip()]
    log.info('offline mode: %d reports from %s', len(reports), path)
    store = IncidentStore()
    for report in reports:
        if isinstance(report, list):
            store.add(report)
    for incident in store.flush():
        recommend(incident)


def main():
    if OFFLINE_FILE:
        offline(OFFLINE_FILE)
        return
    store = IncidentStore()
    threading.Thread(target=flusher, args=(store,), daemon=True).start()
    threading.Thread(target=serve_health, daemon=True).start()
    if not BOOTSTRAP:
        raise SystemExit('KAFKA_BOOTSTRAP_SERVERS is not set')
    consume_forever(store)


if __name__ == '__main__':
    main()
