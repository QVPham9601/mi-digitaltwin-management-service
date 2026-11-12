# AI4SOAR in recommendation-only mode: implementation instructions

You are the implementing agent. Read `CLAUDE.md` and `docs/AGENT_ENV.md` first, then this
whole file before changing anything. Stop and report when §6 is done.

## 1. Goal

In the demo scenario "CI attack → MMT detection → AI4SOAR block" (kind cluster `secsim`),
the reaction module is a stub (`secsim-e2e-stub:local`, `STUB_ROLE=reaction`) that blocks
the attacker through CI-SIM's `/admin/block`. Replace it with the **real AI4SOAR decision
engine, in recommendation-only mode**:

- consume the MMT security alerts that SECANOD publishes on Kafka;
- run AI4SOAR's own enrichment and playbook selection;
- **log the recommended mitigation and execute nothing**: no Shuffle, no OpenSearch, no
  call to CI-SIM, no iptables, no Kubernetes action.

The platform copies container logs into each run's execution report, so the twin records
the recommendation. Blocking comes back later, with the mitigator (out of scope).

## 2. Rules

- Branch `viet-ai4soar-recommend` from `viet-live-state`. Commit with Conventional
  Commits; never `--no-verify`; npm only. **Do not push, do not tag.**
- **No change under `server/src/`.** The live-state code is frozen
  (`git diff live-state-freeze -- server/src` must stay empty).
- Never modify `server/.env`. Use per-process env overrides.
- **Never write to the `intact` database.** Write only to `intact_m1`, and check the URI
  with the guard below before every write:

  ```js
  if (new URL(process.env.MONGODB_URI ?? '').pathname.replace('/', '') !== 'intact_m1') {
    throw new Error('refusing to write: MONGODB_URI must point to the intact_m1 database');
  }
  ```

- `ai4soar/` at the repo root is an untracked clone of Montimage's repository. **Do not
  edit it.** Put everything in `scripts/ai4soar-recommend/`: a Dockerfile that copies the
  needed AI4SOAR sources in, a wrapper entrypoint, and, only if unavoidable, a patch
  file applied at build time and listed in the README.
- Local-first: **no paid or external LLM API** (no OpenAI, no Anthropic). AI4SOAR's
  LLM-based paths (B: LLM attribution, D: LLM CACAO generation) are **off by default**.
  As an option, they may point at a local OpenAI-compatible endpoint (Ollama
  `http://host.docker.internal:11434/v1`, or the DGX vLLM when reachable). The `openai`
  Python SDK normally reads `OPENAI_BASE_URL`; verify that before relying on it.
- Don't pull models onto the shared DGX. Don't re-seed the database.

## 3. What exists (verified, but check again)

- **AI4SOAR** (`ai4soar/`):
  - Kafka consumer: `core/alerts_consumer/kafka_consumer.py`.
  - MMT enrichment adapter: `core/intelligent_orchestration/enrichment/adapters/mmt.py`.
  - Orchestrator: `core/intelligent_orchestration/orchestrator.py`, with paths A (STIX
    knowledge base), B (LLM), C (trained ML models in `models/*.joblib`) and D (LLM CACAO).
  - Playbook library of CACAO YAML templates: `core/playbook_library/loader.py`,
    `playbooks/`, including `t1499_dos.yaml` (id `pb-t1499-block-dos-source`).
  - Execution goes through Shuffle (`core/orchestration_engine/playbook_service.py`).
    That is the part to leave out.
  - LLM config: `core/config.py` (`LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY`) and
    `utils/llm/client.py`.
- **Platform wiring** of the AI4SOAR service (Mongo `services`, shortName `AI4SOAR`):
  - `versions[].dockerImage = secsim-e2e-stub:local`;
  - `deployment.containerPort 5000`, `readinessPath /health`;
  - env `KAFKA_BOOTSTRAP_SERVERS=kafka:9092`, `KAFKA_TOPIC=mmt-security-alerts`,
    `STUB_ROLE=reaction`;
  - a config file mounted at `/opt/ai4soar/playbooks/block-attacker.yaml` (the stub's
    playbook). Keep AI4SOAR's own library at another path so this mount does not shadow
    it.
- **Alert format:** SECANOD's Kafka output is MMT JSON reports carrying the attacker as
  `ip.src`. For a sample, look at the `alerts` of the latest execution report in
  `intact_m1` (a real run of 2026-11-10: rule 56 "Probable SYN flooding attack", one
  attacker). Check that AI4SOAR's MMT adapter accepts this format. If it does not, map
  it in the wrapper, not in AI4SOAR.
- **Stub, for reference:** `scripts/e2e-kind/stub/stub.py`; its Kafka consumer uses
  `group_id='ai4soar'`.
- **Real demo run:** `server/scripts/evaluation-live-state/real-change.mjs --incident`,
  with a platform server on `intact_m1` (port 3101).

## 4. Build

1. **Image `ai4soar-recommend:local`** (`scripts/ai4soar-recommend/Dockerfile`):
   - Python with AI4SOAR's `requirements.txt`, trimmed to what the decision path needs.
     Pin the scikit-learn version the `.joblib` models were saved with, or path C fails
     to load.
   - Size and memory matter: it runs in kind on a laptop.
2. **Wrapper entrypoint** (`scripts/ai4soar-recommend/recommend.py`):
   - `GET /health` on `:5000`, so the readiness gate passes.
   - Consume `KAFKA_TOPIC` from `KAFKA_BOOTSTRAP_SERVERS`, with retries while Kafka starts.
   - Group alerts into one incident per (rule, attacker) with a quiet gap of about 30 s,
     so a flood of hundreds of alerts gives a single recommendation.
   - For each incident: enrich with the MMT adapter, run the orchestrator (paths A and C
     by default), and print **one JSON line**:
     `{"ai4soar": "recommendation", "ruleId", "attacker", "alertCount", "technique", "playbookId", "playbookName", "score", "path", "steps": [step names], "executed": false}`.
   - Print a readable summary line as well. Never execute a step.
   - If the orchestrator cannot run without Shuffle or OpenSearch at import or start,
     stub out only that dependency in the wrapper and say so in the README.
3. **`scripts/ai4soar-recommend/use-real-ai4soar.mjs`** (writes `intact_m1` only, with the
   guard):
   - set the AI4SOAR service's image to `ai4soar-recommend:local`;
   - remove `STUB_ROLE` from its env;
   - `--revert` restores the stub.

   `copy-db.sh` resets `intact_m1` to the stub, so the M1 evaluation runs this script
   after each copy if it uses the real AI4SOAR. Add that line to
   `server/scripts/evaluation-live-state/EVALUATION-PROTOCOL.md` (procedure step 2), as
   optional.

4. **`scripts/ai4soar-recommend/README.md`**:
   - build, then `kind load docker-image ai4soar-recommend:local --name secsim`;
   - switching on and off;
   - what is real and what is left out (execution, Shuffle, the LLM paths);
   - effect on the demo: **nothing blocks the attacker any more**, so CI-SIM stays down
     until teardown, and the second attack profile ("attack-2-already-blocked") is no
     longer answered with 403.

## 5. Tests and acceptance

- **Offline:** feed the wrapper's incident function the sample alerts from §3, without
  Kafka. Record what it recommends (technique, playbook, path). **Do not force** a
  result; if it is not the DoS playbook, report what it chose and why.
- **Demo run:**
  1. fresh `intact_m1` (`copy-db.sh --drop`);
  2. `use-real-ai4soar.mjs`;
  3. server on 3101 against `intact_m1`;
  4. `real-change.mjs --incident --attack-seconds=120`;
  5. check that the new execution report's `logs` contain the recommendation JSON line
     from the `ai4soar` container, and that no container made an outbound HTTP call
     except to Kafka;
  6. record the recommendation and the pod's memory (`kubectl top` if available,
     otherwise `docker stats` on the kind node).
- `npm run typecheck && npm run lint && npm test` still pass, and the `server/src` diff
  against `live-state-freeze` is empty.

## 6. When done

Stop and report to the user:

- the commits (hashes);
- what AI4SOAR recommended on the real alerts, offline and in the demo run;
- what had to be adapted (alert mapping, stubbed dependencies, patches);
- image size and memory;
- anything in this file that was wrong or unclear, and open questions.

Do not start any evaluation.
