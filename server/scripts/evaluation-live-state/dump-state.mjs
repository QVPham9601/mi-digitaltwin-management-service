#!/usr/bin/env node
/**
 * Dump the twin's run state (M1 live state, §4.5): the raw fields of the
 * implementation instructions §3, with no derived values — for the ground
 * truth (ground_truth_state.py).
 *
 *   cd server && node scripts/evaluation-live-state/dump-state.mjs [--label=t0]
 *   → scripts/evaluation-live-state/state-snapshot-<label>.json
 *
 * Env: MONGODB_URI (default mongodb://127.0.0.1:27017/intact_m1).
 * Read-only: dumps the scenarios' executions and the execution reports exactly
 * as stored (dates in ISO, ObjectIds as plain strings, no joins applied).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABEL = (process.argv.find((a) => a.startsWith('--label='))?.split('=')[1] ?? 'run').replace(
  /[^A-Za-z0-9_-]/g,
  ''
);
const OUT = join(HERE, `state-snapshot-${LABEL}.json`);
const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/intact_m1';

await mongoose.connect(URI);
const db = mongoose.connection.db;

const includeIf = (value) => (value === undefined ? undefined : value);
const scenarios = (await db.collection('scenarios').find().toArray()).map((scenario) => ({
  _id: String(scenario._id),
  title: scenario.title,
  executions: (scenario.executions ?? []).map((execution) => ({
    executionId: String(execution._id),
    executedAt: execution.executedAt,
    executedBy: execution.executedBy ?? '',
    status: execution.status ?? 'pending',
    namespace: includeIf(execution.namespace),
    completedAt: includeIf(execution.completedAt),
    durationMs: includeIf(execution.durationMs),
    outcome: includeIf(execution.outcome),
    observability: includeIf(execution.observability),
    deployedServices: (execution.deployedServices ?? []).map((deployed) => ({
      name: deployed.name ?? undefined,
      status: deployed.status ?? undefined,
      uiType: deployed.uiType ?? undefined,
    })),
  })),
}));

const reports = (await db.collection('executionreports').find().toArray()).map((report) => ({
  scenarioId: String(report.scenarioId),
  executionId: String(report.executionId),
  scenarioTitle: report.scenarioTitle ?? '',
  outcome: report.outcome,
  startedAt: report.startedAt,
  completedAt: report.completedAt,
  durationMs: report.durationMs,
  services: report.services ?? [],
  metrics: report.metrics ?? {},
  alerts: report.alerts ?? [],
  traffic: report.traffic ?? undefined,
  partial: report.partial ?? false,
  captureErrors: report.captureErrors ?? [],
}));

const counts = {
  scenarios: scenarios.length,
  executions: scenarios.reduce((n, s) => n + s.executions.length, 0),
  reports: reports.length,
};

writeFileSync(
  OUT,
  `${JSON.stringify({ dumpedAt: new Date().toISOString(), ...counts, scenarios, reports }, null, 2)}\n`
);
console.log(
  `${counts.scenarios} scenarios, ${counts.executions} executions, ${counts.reports} reports → ${OUT}`
);
await mongoose.disconnect();
