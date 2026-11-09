#!/usr/bin/env node
/**
 * Apply the deterministic state changes to `intact_m1` (M1 live state, §4.5).
 *
 *   node scripts/evaluation-live-state/apply-change.mjs --step=1
 *
 * Steps (each idempotent, each printing what it did):
 *   1. Add a closed run of the demo scenario with executedAt = 2026-11-10T09:00Z,
 *      outcome failed, CI-SIM up=false / availability 0.42, 37 alerts from one
 *      new attacker 10.244.0.99, and its report.
 *   2. Add a run started 2026-11-10T10:00Z, status running, no completedAt
 *      (a genuinely live run; fresh, so not suspect-stale when the clock is
 *      close).
 *   3. Mark the step-1 run's SECANOD service failed with 3 container restarts.
 *
 * The suspect-stale October run is never touched.
 *
 * SAFETY: refuses to run unless MONGODB_URI names the `intact_m1` database
 * (§6). mongosh/mongoose writes only there.
 */
import { fileURLToPath, URL } from 'node:url';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI ?? '';
if (!uri || new URL(uri).pathname.replace('/', '') !== 'intact_m1') {
  throw new Error('refusing to write: MONGODB_URI must point to the intact_m1 database');
}

const step = Number(process.argv.find((a) => a.startsWith('--step='))?.split('=')[1]);
if (![1, 2, 3].includes(step)) {
  throw new Error('usage: apply-change.mjs --step=1|2|3');
}

const SCENARIO_TITLE = 'CI attack → MMT detection → AI4SOAR block';
const EXECUTED_BY = 'apply-change';
const STEP1_EXECUTED_AT = new Date('2026-11-10T09:00:00Z');
const STEP2_EXECUTED_AT = new Date('2026-11-10T10:00:00Z');

await mongoose.connect(uri);
const db = mongoose.connection.db;
const scenarios = db.collection('scenarios');
const reports = db.collection('executionreports');

const changes = db.collection('applychange_m1');
await changes.createIndex({ step: 1 }, { unique: true });

/**
 * Apply a step at most once. The marker collection makes this idempotent
 * across re-runs, but a fresh intact_m1 re-copy (copy-db.sh) keeps an
 * old marker, so a marker-less DB whose change is already present is
 * recognised by `present()` and just re-stamped — never applied twice.
 */
async function once(step, present, apply) {
  const marker = await changes.findOne({ step });
  if (marker) {
    console.log(`step ${step}: already applied (${marker.note}) — nothing to do`);
    return;
  }
  if (await present()) {
    await changes.insertOne({
      step,
      note: 'already present before this run (fresh copy with an old marker)',
      appliedAt: new Date(),
    });
    console.log(`step ${step}: change already present in the database — marker re-stamped`);
    return;
  }
  const note = await apply();
  await changes.insertOne({ step, note, appliedAt: new Date() });
  console.log(`step ${step}: ${note}`);
}

const APPLY = {
  1: {
    present: async () => {
      const scenario = await scenarios.findOne({ title: SCENARIO_TITLE });
      return Boolean(
        scenario?.executions?.some(
          (execution) =>
            new Date(execution.executedAt).getTime() === STEP1_EXECUTED_AT.getTime() &&
            execution.executedBy === EXECUTED_BY
        )
      );
    },
    apply: async () => {
    const scenario = await scenarios.findOne({ title: SCENARIO_TITLE });
    if (!scenario) throw new Error(`scenario "${SCENARIO_TITLE}" not found in intact_m1`);
    const executedAt = STEP1_EXECUTED_AT;
    const execution = {
      // Explicit _id: MongoDB does not auto-generate ids for subdocuments
      // pushed into an array, and the loader/report-join needs the id.
      _id: new mongoose.Types.ObjectId(),
      executedAt,
      executedBy: EXECUTED_BY,
      status: 'completed',
      namespace: 'step1-failed-run',
      deployedServices: [
        { name: 'mag', status: 'completed' },
        { name: 'ci-sim', status: 'completed' },
        { name: 'secanod', status: 'completed' },
        { name: 'kafka', status: 'completed' },
        { name: 'ai4soar', status: 'completed' },
      ],
      completedAt: new Date('2026-11-10T09:12:00Z'),
      durationMs: 12 * 60 * 1000,
      outcome: 'failed',
      observability: true,
    };
    await scenarios.updateOne({ _id: scenario._id }, { $push: { executions: execution } });
    const report = {
      scenarioId: scenario._id,
      executionId: execution._id,
      scenarioTitle: SCENARIO_TITLE,
      executedBy: EXECUTED_BY,
      namespace: 'step1-failed-run',
      outcome: 'failed',
      startedAt: executedAt,
      completedAt: new Date('2026-11-10T09:12:00Z'),
      durationMs: 12 * 60 * 1000,
      services: [
        { name: 'mag', status: 'completed', containers: [{ name: 'mag', status: 'completed' }] },
        { name: 'ci-sim', status: 'completed', containers: [{ name: 'ci-sim', status: 'completed' }] },
        { name: 'secanod', status: 'completed', containers: [{ name: 'secanod', status: 'completed' }] },
        { name: 'kafka', status: 'completed', containers: [{ name: 'kafka', status: 'completed' }] },
        { name: 'ai4soar', status: 'completed', containers: [{ name: 'ai4soar', status: 'completed' }] },
      ],
      metrics: {
        services: {
          total: 5,
          byStatus: { pending: 0, running: 0, completed: 5, failed: 0 },
        },
        containers: { total: 5, byStatus: { pending: 0, running: 0, completed: 5, failed: 0 }, restarts: 0 },
        logs: { lines: 0, errorLines: 0 },
        events: { total: 0, warnings: 0, byReason: [] },
        alerts: { total: 37, uniqueAttackers: 1, byVerdict: [] },
      },
      logs: [],
      errorLogs: [],
      events: [],
      alerts: Array.from({ length: 37 }, () => ({
        service: 'secanod',
        pod: 'ci-sim',
        timestamp: '2026-11-10T09:05:00Z',
        verdict: 'demo attack detected',
        attacker: '10.244.0.99',
        line: 'security report: http flood from 10.244.0.99',
      })),
      traffic: [
        { service: 'ci-sim', probe: 'http', up: false, availability: 0.42 },
        { service: 'mag', probe: 'tcp', up: true, availability: 1 },
        { service: 'secanod', probe: 'tcp', up: true, availability: 1 },
        { service: 'kafka', probe: 'tcp', up: true, availability: 1 },
        { service: 'ai4soar', probe: 'http', up: true, availability: 1 },
      ],
      omitted: { logs: 0, errorLogs: 0, events: 0, alerts: 0 },
      partial: false,
      captureErrors: [],
    };
    await reports.insertOne(report);
    return 'added closed failed run (CI-SIM up=false, availability 0.42, 37 alerts from 10.244.0.99) with its report';
    },
  },

  2: {
    present: async () => {
      const scenario = await scenarios.findOne({ title: SCENARIO_TITLE });
      return Boolean(
        scenario?.executions?.some(
          (execution) =>
            new Date(execution.executedAt).getTime() === STEP2_EXECUTED_AT.getTime() &&
            execution.executedBy === EXECUTED_BY
        )
      );
    },
    apply: async () => {
    const scenario = await scenarios.findOne({ title: SCENARIO_TITLE });
    if (!scenario) throw new Error(`scenario "${SCENARIO_TITLE}" not found in intact_m1`);
    const execution = {
      _id: new mongoose.Types.ObjectId(),
      executedAt: STEP2_EXECUTED_AT,
      executedBy: EXECUTED_BY,
      status: 'running',
      namespace: 'step2-live-run',
      deployedServices: [
        { name: 'mag', status: 'running' },
        { name: 'ci-sim', status: 'running' },
        { name: 'secanod', status: 'running' },
        { name: 'kafka', status: 'running' },
        { name: 'ai4soar', status: 'running' },
      ],
      observability: true,
      // No completedAt: a genuinely live run — fresh at t1, so the state
      // route must NOT flag it suspect-stale when the clock is close.
    };
    await scenarios.updateOne({ _id: scenario._id }, { $push: { executions: execution } });
    return 'added a running run started 2026-11-10T10:00Z with no completedAt';
    },
  },

  3: {
    present: async () => {
      const scenario = await scenarios.findOne({ title: SCENARIO_TITLE });
      const step1Run = scenario?.executions?.find(
        (execution) =>
          new Date(execution.executedAt).getTime() === STEP1_EXECUTED_AT.getTime() &&
          execution.executedBy === EXECUTED_BY
      );
      if (!step1Run) return false;
      const secanod = (step1Run.deployedServices ?? []).find((s) => s.name === 'secanod');
      if (secanod?.status === 'failed') return true;
      const report = await reports.findOne(
        { scenarioId: scenario._id, executionId: step1Run._id, 'services.name': 'secanod' },
        { projection: { 'services.$': 1 } }
      );
      return report?.services?.[0]?.status === 'failed';
    },
    apply: async () => {
    const scenario = await scenarios.findOne({ title: SCENARIO_TITLE });
    if (!scenario) throw new Error(`scenario "${SCENARIO_TITLE}" not found in intact_m1`);
    // The step-1 run: completed at 09:12 the same morning.
    const step1Run = scenario.executions
      .map((execution, index) => ({ execution, index }))
      .filter(
        ({ execution }) =>
          new Date(execution.executedAt).getTime() === STEP1_EXECUTED_AT.getTime()
      )
      .at(-1);
    if (!step1Run) {
      throw new Error('the step-1 run was not found — run --step=1 first');
    }
    await scenarios.updateOne(
      {
        _id: scenario._id,
        [`executions.${step1Run.index}.deployedServices.name`]: 'secanod',
      },
      { $set: { [`executions.${step1Run.index}.deployedServices.$.status`]: 'failed' } }
    );
    await reports.updateOne(
      { scenarioId: scenario._id, executionId: step1Run.execution._id, 'services.name': 'secanod' },
      {
        $set: {
          'services.$.status': 'failed',
          'services.$.containers': [{ name: 'secanod', status: 'failed' }],
          'metrics.containers.restarts': 3,
        },
      }
    );
    return 'marked SECANOD failed with 3 container restarts in the step-1 run (execution and report)';
    },
  },
};

await once(step, APPLY[step].present, APPLY[step].apply);

await mongoose.disconnect();
