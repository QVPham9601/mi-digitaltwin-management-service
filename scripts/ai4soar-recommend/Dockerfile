# AI4SOAR decision engine, recommendation-only mode (see README.md).
#
# Consumes SECANOD's MMT security alerts from Kafka, enriches them through
# AI4SOAR's own adapters and selects a CACAO playbook with the orchestrator
# (paths A and C) — and logs the recommendation without executing it: no
# Shuffle, no OpenSearch, no call to CI-SIM. Build from the repository root
# (ai4soar/ is the untracked clone the image copies its sources from):
#
#   docker build -f scripts/ai4soar-recommend/Dockerfile -t ai4soar-recommend:local .
#
FROM python:3.10-slim

# Dependencies the decision path actually imports (ai4soar/requirements.txt
# trimmed: no Flask, pymongo, networkx, requests, openai, anthropic,
# confluent-kafka — the API, verifier, Shuffle/Caldera and LLM clients are
# not part of the recommendation-only runtime). numpy/scikit-learn/joblib
# stay at the exact pins the committed .joblib models were trained with, or
# Path C fails to unpickle them.
RUN pip install --no-cache-dir \
      numpy==1.24.3 \
      scikit-learn==1.3.2 \
      joblib==1.3.2 \
      kafka-python==2.0.2 \
      python-dotenv==1.0.1 \
      'pyyaml>=6.0'

# AI4SOAR sources under /app/ai4soar — deliberately NOT /opt/ai4soar, where
# the platform mounts the stub's playbook config into
# /opt/ai4soar/playbooks/block-attacker.yaml and would shadow the library.
WORKDIR /app/ai4soar
COPY ai4soar/core core/
COPY ai4soar/utils utils/
COPY ai4soar/playbooks playbooks/
# Path C model artifacts (SIMILARITY_MODEL=mlp loads these two at inference;
# the other joblibs are alternative classifiers the image does not need).
COPY ai4soar/models/mlp_recommender.joblib ai4soar/models/feature_engineer.joblib models/

COPY scripts/ai4soar-recommend/recommend.py /app/recommend.py

# Paths A and C only: with no OPENAI_API_KEY/ANTHROPIC_API_KEY set, the LLM
# paths B and D disable themselves (utils/llm/client.py raises
# LLMUnavailableError and each path returns None).
ENV PLAYBOOK_LIBRARY_PATH=/app/ai4soar/playbooks \
    PYTHONPATH=/app/ai4soar \
    PYTHONUNBUFFERED=1

EXPOSE 5000
ENTRYPOINT ["python", "/app/recommend.py"]
