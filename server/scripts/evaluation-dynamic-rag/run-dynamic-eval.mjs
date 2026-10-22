#!/usr/bin/env node
/**
 * Dynamic-RAG evaluation runner: asks each question through POST /api/agent/chat
 * under a retrieval condition and records answer, retrieval route and latency.
 *
 *   ADMIN_PASSWORD=… node server/scripts/evaluation-dynamic-rag/run-dynamic-eval.mjs \
 *     --out=results/dgx-pilot.jsonl [--conditions=A,B,C] [--reps=1] \
 *     [--questions=questions-dynamic-rag.json] [--ids=DR01,DR02]
 *
 * Conditions: A = vector (top-k 4, today), B = structured (forced), C = auto (routed).
 * B is not run on lookup-control questions (forcing a single-service fact through
 * the structured branch is not a meaningful condition).
 * The server must run with AGENT_EVAL_OPTIONS=true (per-request retrievalMode)
 * and AGENT_LLM_TITLES=false. Re-running with the same --out resumes: rows
 * already recorded are skipped. Env: BASE_URL (default http://127.0.0.1:3100).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const at = (p) => (isAbsolute(p) ? p : join(HERE, p));
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const OUT = at(arg('out', 'results/run.jsonl'));
const CONDITIONS = arg('conditions', 'A,B,C').split(',');
const REPS = Number(arg('reps', '1'));
const IDS = arg('ids', '') ? new Set(arg('ids', '').split(',')) : null;
const MODE = { A: 'vector', B: 'structured', C: 'auto' };

const questions = JSON.parse(readFileSync(at(arg('questions', 'questions-dynamic-rag.json')), 'utf8'))
  .filter((q) => !IDS || IDS.has(q.id));
mkdirSync(dirname(OUT), { recursive: true });
const done = new Set(
  existsSync(OUT)
    ? readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)).filter((r) => !r.error).map((r) => `${r.id}|${r.condition}|${r.rep}`)
    : []
);

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.ADMIN_USERNAME ?? 'admin', password: process.env.ADMIN_PASSWORD }),
});
const { token } = await login.json();
if (!token) throw new Error(`login failed (${login.status})`);

/** One chat turn in a new conversation; parses the SSE stream. */
async function ask(question, retrievalMode) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: question, useRag: true, retrievalMode }),
  });
  if (!res.ok || !res.body) throw new Error(`chat ${res.status}: ${await res.text()}`);
  let buffer = '';
  let answer = '';
  let retrieval = null;
  let sources = [];
  let firstTokenMs = null;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const type = /^event: (.+)$/m.exec(frame)?.[1];
      const raw = /^data: (.+)$/m.exec(frame)?.[1];
      if (!type || !raw) continue;
      const data = JSON.parse(raw);
      if (type === 'token') {
        firstTokenMs ??= Date.now() - t0;
        answer += data.content;
      } else if (type === 'retrieval') retrieval = data;
      else if (type === 'sources') sources = (data ?? []).map((s) => s.shortName ?? s.title ?? s);
      else if (type === 'error') throw new Error(data.message);
    }
  }
  return { answer, retrieval, sources, latencyMs: Date.now() - t0, firstTokenMs };
}

let n = 0;
for (let rep = 1; rep <= REPS; rep++) {
  for (const condition of CONDITIONS) {
    for (const q of questions) {
      if (condition === 'B' && q.expectedRoute === 'lookup') continue;
      if (done.has(`${q.id}|${condition}|${rep}`)) continue;
      const row = { id: q.id, category: q.category, condition, mode: MODE[condition], rep };
      try {
        Object.assign(row, await ask(q.question, MODE[condition]));
      } catch (error) {
        row.error = String(error);
      }
      appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      n++;
      process.stdout.write(row.error ? 'x' : '.');
    }
  }
}
console.log(`\n${n} answers → ${OUT}`);
