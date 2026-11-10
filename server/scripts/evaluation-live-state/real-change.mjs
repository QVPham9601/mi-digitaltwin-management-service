#!/usr/bin/env node
/**
 * Real state changes for the M1 live-state evaluation (the "real incident"
 * variant of apply-change.mjs). Drives the demo scenario on the kind cluster
 * through the platform's REST API, so the twin records genuine runs:
 *
 *   node scripts/evaluation-live-state/real-change.mjs --incident [--attack-seconds=120]
 *       deploy, run MAG's first attack profile, wait, tear down → a closed run
 *       (real alerts, real CI-SIM health, its report)
 *   node scripts/evaluation-live-state/real-change.mjs --start-live
 *       deploy and leave it running (a genuinely live run during t1);
 *       the execution id is saved to live-run.json
 *   node scripts/evaluation-live-state/real-change.mjs --stop-live
 *       tear down the run saved in live-run.json (after the t1 answers)
 *
 * Run from server/. Env: BASE_URL (default http://localhost:3101), MONGODB_URI
 * (must name intact_m1). ADMIN_PASSWORD is read from .env when not exported.
 *
 * SAFETY: the API server must be the one on intact_m1. Before any change the
 * script compares the demo scenario's run count seen through the API with the
 * count in intact_m1 and refuses on a mismatch. No LLM is called.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_FILE = join(HERE, 'live-run.json');
const BASE = (process.env.BASE_URL ?? 'http://localhost:3101').replace(/\/+$/, '');
const uri = process.env.MONGODB_URI ?? '';
if (new URL(uri).pathname.replace('/', '') !== 'intact_m1') {
  throw new Error('refusing to run: MONGODB_URI must point to the intact_m1 database');
}
const args = new Set(process.argv.slice(2).filter((a) => !a.includes('=')));
const opt = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const ATTACK_S = Number(opt('attack-seconds', '120'));
const password =
  process.env.ADMIN_PASSWORD ?? readFileSync('.env', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)?.[1];

let token = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

const client = await MongoClient.connect(uri);
const scenarioDoc = await client
  .db()
  .collection('scenarios')
  .findOne({ title: /MMT detection/ }, { projection: { executions: 1, title: 1 } });
if (!scenarioDoc) throw new Error('demo scenario not found in intact_m1');
const scenarioId = scenarioDoc._id.toString();

token = (await api('POST', '/auth/login', { username: 'admin', password })).token;
const viaApi = await api('GET', `/scenarios/${scenarioId}`);
if ((viaApi.executions ?? []).length !== scenarioDoc.executions.length) {
  await client.close();
  throw new Error('refusing to run: the API server is not using intact_m1 (run counts differ)');
}

async function deploy() {
  const { executionId } = await api('POST', `/scenarios/${scenarioId}/execute`);
  console.log(stamp(), `deploying execution ${executionId}`);
  for (let i = 0; i < 120; i++) {
    const s = await api('GET', `/scenarios/${scenarioId}`);
    const e = s.executions.find((x) => x._id === executionId);
    if (e?.status === 'failed') throw new Error('deploy failed');
    if (e?.status === 'running') {
      console.log(stamp(), 'running');
      return executionId;
    }
    await sleep(5000);
  }
  throw new Error('timeout waiting for the deployment');
}

async function teardown(executionId) {
  const r = await api('DELETE', `/scenarios/${scenarioId}/executions/${executionId}`);
  console.log(stamp(), `torn down: status ${r.status}, outcome ${r.outcome}, ${r.durationMs} ms`);
}

try {
  if (args.has('--incident')) {
    const executionId = await deploy();
    await sleep(20_000); // let the probe and Kafka settle before the attack
    const { profiles } = await api(
      'GET',
      `/scenarios/${scenarioId}/executions/${executionId}/profiles`
    );
    const profile = profiles[0];
    await api('POST', `/scenarios/${scenarioId}/executions/${executionId}/profiles/run`, {
      nodeId: profile.nodeId,
      name: profile.name,
    });
    console.log(stamp(), `attack "${profile.name}" started; waiting ${ATTACK_S}s`);
    await sleep(ATTACK_S * 1000);
    await teardown(executionId);
  } else if (args.has('--start-live')) {
    const executionId = await deploy();
    writeFileSync(LIVE_FILE, JSON.stringify({ scenarioId, executionId }, null, 2) + '\n');
    console.log(stamp(), `left running; saved to ${LIVE_FILE}`);
  } else if (args.has('--stop-live')) {
    const { executionId } = JSON.parse(readFileSync(LIVE_FILE, 'utf8'));
    await teardown(executionId);
  } else {
    console.log('usage: --incident [--attack-seconds=120] | --start-live | --stop-live');
  }
} finally {
  await client.close();
}
