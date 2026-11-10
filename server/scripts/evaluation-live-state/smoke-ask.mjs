import { readFileSync } from 'node:fs';
// Usage (from server/): BASE_URL=http://localhost:3101 node scripts/evaluation-live-state/smoke-ask.mjs < questions.json
// questions.json: [{ "title", "message", "mode" }]; mode = auto | state-static | ...
const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const password = readFileSync('.env', 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)[1];
const login = await (
  await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  })
).json();
for (const q of JSON.parse(readFileSync(0, 'utf8'))) {
  const response = await fetch(`${BASE}/api/agent/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: q.message, ...(q.mode ? { retrievalMode: q.mode } : {}) }),
  });
  const text = await response.text();
  const events = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
  const answer = events
    .filter((e) => typeof e.content === 'string')
    .map((e) => e.content)
    .join('');
  const meta = events.filter((e) => e.mode).at(-1) ?? {};
  console.log(`### ${q.title}`);
  console.log(`Q: ${q.message}  [retrievalMode ${q.mode}]`);
  console.log(
    `MODE: ${meta.mode} route=${meta.route} router=${meta.routerKind ?? ''} readAt=${meta.stateReadAt ?? ''} match=${meta.stateMatchCount ?? ''} stale=${meta.suspectStaleCount ?? ''}`
  );
  if (meta.stateQuery) console.log(`STATE_QUERY: ${JSON.stringify(meta.stateQuery)}`);
  if (meta.fallbackReason) console.log(`FALLBACK: ${meta.fallbackReason}`);
  console.log(`A: ${answer}`);
  console.log('');
}
