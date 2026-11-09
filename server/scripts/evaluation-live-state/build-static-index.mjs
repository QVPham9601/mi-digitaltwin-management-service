#!/usr/bin/env node
/**
 * Build the static run-state baseline index (M1 live state, §4.4).
 *
 * Reads the twin state once from MongoDB, writes one plain-text summary per
 * run (same facts as a RunRow plus its services, with executedAt but NO
 * "as of now" information — no age, no staleness) with its embedding to
 * `static-index.json`, plus `builtAt`. The `state-static` retrieval mode
 * answers from this snapshot: it stands for the common practice of indexing
 * operational data periodically.
 *
 * Read-only toward MongoDB — no intact_m1 safeguard needed, but it reads the
 * database that MONGODB_URI points at (for the evaluation, that is intact_m1).
 *
 *   AGENT_STALE_RUN_MS is NOT applied here: the snapshot contains no staleness
 *   judgements, that is a live-read property.
 *
 * Embeddings go to the Ollama embedding endpoint the vector branch uses
 * (OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL, default nomic-embed-text), embedded
 * with the 'search_document' task prefix the catalog index uses.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'static-index.json');
const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/intact_m1';
const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';

/** One Ollama embed call — the same endpoint and task prefix the TS gateway uses. */
async function embed(text) {
  const response = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: `search_document: ${text}` }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  const vector = body.embeddings?.[0];
  if (!vector) throw new Error('Ollama embed returned no vector');
  return vector;
}

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function ageWords(ageMs) {
  if (ageMs < 2 * MS_PER_MIN) return 'under 2 minutes before the index was built';
  if (ageMs < MS_PER_HOUR) return `about ${Math.round(ageMs / MS_PER_MIN)} minutes before the index was built`;
  if (ageMs < MS_PER_DAY) return `about ${Math.round(ageMs / MS_PER_HOUR)} hours before the index was built`;
  if (ageMs < 45 * MS_PER_DAY) {
    const n = Math.round(ageMs / MS_PER_DAY);
    return n === 1 ? '1 day before the index was built' : `about ${n} days before the index was built`;
  }
  const months = Math.round(ageMs / (30 * MS_PER_DAY));
  return `about ${months} months before the index was built`;
}

await mongoose.connect(URI);
const db = mongoose.connection.db;

const scenarios = await db
  .collection('scenarios')
  .find({ deprecated: { $ne: true } })
  .toArray();
const reports = await db.collection('executionreports').find().toArray();
const reportByRun = new Map(
  reports.map((r) => [`${String(r.scenarioId)}:${String(r.executionId)}`, r])
);

const now = Date.now();
const entries = [];
for (const scenario of scenarios) {
  const runs = [...(scenario.executions ?? [])].sort(
    (a, b) => new Date(a.executedAt) - new Date(b.executedAt)
  );
  for (const [index, execution] of runs.entries()) {
    const report = reportByRun.get(`${String(scenario._id)}:${String(execution._id)}`);
    const executedAt = new Date(execution.executedAt);
    const lines = [
      `Run #${index + 1} of the scenario "${scenario.title}".`,
      `Executed at ${executedAt.toISOString()} by ${execution.executedBy ?? 'unknown'}, ${ageWords(now - executedAt.getTime())}.`,
      `Status at index time: ${execution.status ?? 'pending'} (status values: pending, running, completed, failed).`,
    ];
    if (execution.completedAt) lines.push(`Completed at ${new Date(execution.completedAt).toISOString()}.`);
    const outcome = execution.outcome ?? report?.outcome;
    if (outcome) lines.push(`Outcome: ${outcome}.`);
    if (report?.durationMs !== undefined || execution.durationMs) {
      const ms = report?.durationMs ?? execution.durationMs;
      if (typeof ms === 'number') lines.push(`Duration: ${(ms / 1000).toFixed(0)} seconds (${ms} ms).`);
    }
    const services = (report?.services ?? execution.deployedServices ?? [])
      .map((s) => (typeof s === 'string' ? { name: s, status: undefined } : s));
    const traffic = new Map((report?.traffic ?? []).map((t) => [t.service, t]));
    if (services.length > 0) {
      lines.push('Deployed services:');
      for (const service of services) {
        if (!service?.name) continue;
        const t = traffic.get(service.name);
        const bits = [`- ${service.name}: ${service.status ?? 'unknown'}`];
        if (t) {
          if (typeof t.up === 'boolean') bits.push(`last probe up=${t.up}`);
          if (typeof t.availability === 'number') bits.push(`availability ${t.availability}`);
          if (typeof t.errorRate === 'number') bits.push(`errorRate ${t.errorRate}`);
          if (typeof t.requestRate === 'number') bits.push(`requestRate ${t.requestRate}`);
          if (typeof t.latencyP95Ms === 'number') bits.push(`latencyP95Ms ${t.latencyP95Ms}`);
        }
        lines.push(bits.join(', '));
      }
    }
    const metrics = report?.metrics;
    if (metrics) {
      if (metrics.logs?.errorLines !== undefined) lines.push(`Error log lines: ${metrics.logs.errorLines}.`);
      if (metrics.events?.warnings !== undefined) lines.push(`Warnings: ${metrics.events.warnings}.`);
      if (metrics.containers?.restarts !== undefined) {
        lines.push(`Container restarts: ${metrics.containers.restarts}.`);
      }
      if (metrics.alerts) {
        lines.push(
          `Alerts: ${metrics.alerts.total ?? 0} from ${metrics.alerts.uniqueAttackers ?? 0} attackers.`
        );
      }
      const attackers = [...new Set((report?.alerts ?? []).map((a) => a.attacker).filter(Boolean))];
      if (attackers.length > 0) lines.push(`Attacker addresses: ${attackers.join(', ')}.`);
    }
    lines.push(report ? 'A closed-run report exists for this run.' : 'No closed-run report for this run.');
    entries.push({ summary: lines.join('\n'), embedding: await embed(lines.join('\n')) });
  }
}

writeFileSync(
  OUT,
  `${JSON.stringify({ builtAt: new Date().toISOString(), runs: entries }, null, 2)}\n`
);
console.log(
  `${entries.length} run summaries → ${OUT} (embedding model ${EMBED_MODEL} on ${OLLAMA})`
);
await mongoose.disconnect();
