# AI4SOAR in recommendation-only mode

For the demo scenario "CI attack → MMT detection → AI4SOAR block" (kind cluster
`secsim`) this replaces the reaction stub (`secsim-e2e-stub:local`,
`STUB_ROLE=reaction`) with the **real AI4SOAR decision engine** — consuming the
MMT security alerts SECANOD publishes on Kafka and selecting a CACAO playbook
with AI4SOAR's own enrichment + orchestrator — while **executing nothing**:

- consumed: `KAFKA_TOPIC` from `KAFKA_BOOTSTRAP_SERVERS` (the deployment env
  already carries `kafka:9092` / `mmt-security-alerts`);
- recommended: the orchestrator's top playbook for the incident;
- **executed: nothing** — no Shuffle, no OpenSearch, no call to CI-SIM
  `/admin/block`, no iptables, no Kubernetes action. Kafka is the only
  outbound traffic. Blocking comes back later, with the mitigator (out of
  scope).

The platform copies container logs into each run's execution report, so the
recommendation JSON line the wrapper prints on stdout is how the twin records
the decision. Real output from this folder's offline test
(`samples/alerts.json`, rule 56, one attacker), with the rule→technique map
on (default):

```json
{
  "ai4soar": "recommendation",
  "ruleId": "56",
  "attacker": "10.244.0.15",
  "alertCount": 76,
  "technique": "T1499.001",
  "techniqueSource": "rule-map",
  "playbookId": "pb-t1499-block-dos-source",
  "playbookName": "Block DoS from 10.244.0.15",
  "score": 1.0,
  "path": ["A"],
  "steps": [
    "Block 10.244.0.15 at firewall for 24h",
    "Throttle OUTPUT from 10.244.0.15 toward victim",
    "Rate-limit port {{dst_port}} on mmt-probe-3",
    "Create DoS incident ticket"
  ],
  "executed": false
}
```

and the demo run of 2026-11-12 (203 real alerts, attacker `10.244.0.22`,
which predates the rule map — no technique, no playbook):

```json
{
  "ai4soar": "recommendation",
  "ruleId": "56",
  "attacker": "10.244.0.22",
  "alertCount": 203,
  "technique": null,
  "techniqueSource": "none",
  "playbookId": null,
  "playbookName": null,
  "score": 0.0,
  "path": [],
  "steps": [],
  "executed": false
}
```

The empty result is honest: MMT alerts carry no ATT&CK tags, so Stage 1 /
Path A has no technique to look up, and Path C's MLP predicted T1053.005
(0.60), which has no library template. The rule→technique map below exists
to give Path A a justified technique instead of forcing the ML one.

## Build

From the repository root (`ai4soar/` at the root is the untracked clone the
image copies its sources from — the build does not modify it):

```bash
docker build -f scripts/ai4soar-recommend/Dockerfile -t ai4soar-recommend:local .
kind load docker-image ai4soar-recommend:local --name secsim
```

The image is 611 MB (`docker image ls ai4soar-recommend:local`, 2026-11-12)
and the recommendation workload runs in ~70 MiB of memory.

## Switching on and off

`copy-db.sh` resets `intact_m1` to the stub, so switch on again after every
copy (see `../server/scripts/evaluation-live-state/EVALUATION-PROTOCOL.md`,
procedure step 2):

```bash
# needs MONGODB_URI pointing at intact_m1 (the script refuses any other db)
node scripts/ai4soar-recommend/use-real-ai4soar.mjs          # real engine
node scripts/ai4soar-recommend/use-real-ai4soar.mjs --revert # back to the stub
```

Both flip `versions[].dockerImage` (to `ai4soar-recommend:local` /
`secsim-e2e-stub:local`) and remove / restore `STUB_ROLE` from the
deployment env. Deploy as usual (e.g. `real-change.mjs --incident`).

## What is real, what is left out

Real (unmodified `ai4soar/` sources):

- alert ingestion (mapped, see below) and AI4SOAR's MMT enrichment adapter;
- the 3-stage playbook orchestrator — **path A** (STIX knowledge base) and
  **path C** (trained ML similarity, the committed
  `mlp_recommender.joblib` / `feature_engineer.joblib` under
  `scikit-learn==1.3.2`);
- the CACAO playbook library, including `pb-t1499-block-dos-source`
  (`t1499_dos.yaml`) with the attacker IP filled in as `src_ip`.

Left out (and why):

- **Execution** — the wrapper prints the recommendation and returns; the
  orchestrator never imports Shuffle/`PlaybookService`, which is AI4SOAR's
  execution engine.
- **OpenSearch / MongoDB / the Flask API** — not part of the decision path.
- **LLM paths B (LLM attribution) and D (LLM CACAO generation)** — off by
  default: no `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is set, so
  `utils/llm/client.py` raises `LLMUnavailableError` and both paths return
  `None`. To experiment locally (never on a paid API), the OpenAI SDK reads
  `OPENAI_BASE_URL` (verified against Ollama
  `http://host.docker.internal:11434/v1`), so enabling it is env-only:
  `-e OPENAI_API_KEY=dummy -e OPENAI_BASE_URL=http://host.docker.internal:11434/v1`
  (with `-e LLM_MODEL=<model>`). Ollama caveats measured on this machine:
  the qwen3 reasoning models either blow the 30 s LLM timeout (`qwen3:14b`)
  or return an empty `content` field (`qwen3:4b`) — Path B then logs a call
  failure — while `phi:latest` works end-to-end (it attributed T1110.001 to
  the SYN-flood sample, i.e. the wrong technique: the path works, the small
  local model does not). Path C is also automatic: `MITRE` attribution is
  empty in MMT alerts, so the orchestrator routes to Stage 2 and classifies
  with the MLP.

Adaptations (all in the wrapper, `recommend.py` — the clone is not patched):

- **Alert mapping.** SECANOD publishes raw MMT JSON report _arrays_
  (`[10, probe, iface, ts, rule, verdict, type, description, events]` with
  `ip.src` inside `event_1.attributes`), while AI4SOAR's MMT adapter expects
  a `{"type", "payload": {probeId, timestamp, code, status, category,
description, srcIp, dstIp}}` envelope. `mmt_report_to_alert` maps between
  the two (event_1's `ip.src`/`ip.dst` → `payload.srcIp`/`dstIp`, which the
  adapter routes into `_source.data.srcip` — the path the playbook
  parameterizer fills `src_ip` from).
- **Incident grouping.** The clone has no aggregation; MMT reports every
  matching packet, so a flood means hundreds of reports. The wrapper keeps
  one open incident per (rule, attacker) and recommends ~30 s after the last
  report of that incident (`RECOMMEND_QUIET_GAP_S`), so a flood of hundreds
  of alerts gives a single recommendation (`alertCount` records how many).
- **Rule→technique map** (`rule-techniques.json`, `RECOMMEND_RULE_MAP=on|off`,
  default on): MMT alerts carry no ATT&CK tags, so the orchestrator's
  Stage 1 / Path A (direct library lookup) is skipped and the ML Stage 2
  (Path C) decides — and its MLP predicted T1053.005 for the SYN flood,
  which has no playbook. The map gives a _justified_ technique for a known
  rule: entry `56 → T1499.001` (Endpoint DoS: OS Exhaustion Flood — ATT&CK
  lists SYN floods under it; see the entry's `reason`/`source`). The
  wrapper writes it into `EnrichedAlert.technique_ids`, where the
  orchestrator's Stage 1 gate reads it, and Path A then returns
  `pb-t1499-block-dos-source` with confidence 1.0 (`"techniqueSource":
"rule-map"` in the JSON line). Unmapped rules, or `RECOMMEND_RULE_MAP=off`,
  keep the default Path-C behaviour (`"techniqueSource": "none"`). Only
  rules that can be justified belong in the file.
- **Health endpoint.** A tiny stdlib server answers the readiness gate's
  `GET /health` on :5000; AI4SOAR's own Flask app is not part of the image.
- No patch file is needed.

## Effect on the demo

With the real engine in place **nothing blocks the attacker any more**:
CI-SIM keeps serving (until its own rate-limit crash-restart loop, which it
recovers from unblocked) and stays down only while the flood lasts; the
second attack profile (`attack-2-already-blocked`) is **no longer answered
with 403** — the blocklist never gains the attacker address. The run's
execution report still records the recommendation, which is the point of the
recommendation-only mode.

## Offline test

Without Kafka, feed the wrapper the sample alerts recorded in
`intact_m1`'s execution reports (`executionreports[].alerts[].line`, rule 56
"Probable SYN flooding attack"; sampled from the 2026-10-02 real run, one
attacker — see IMPLEMENTATION.md §3; note that the §3 reference to a run of
2026-11-10 did not exist yet when this was built):

```bash
docker run --rm -e RECOMMEND_OFFLINE=/samples/alerts.json \
  -v "$PWD/samples:/samples:ro" ai4soar-recommend:local
```

(`samples/alerts.json` — a JSON array of the raw report `line` values — is
committed next to this README; see IMPLEMENTATION.md §5.)
