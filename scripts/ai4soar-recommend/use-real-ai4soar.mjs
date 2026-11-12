#!/usr/bin/env node
/**
 * Switch the AI4SOAR service in `intact_m1` between the reaction stub and the
 * real AI4SOAR decision engine in recommendation-only mode:
 *
 *   node scripts/ai4soar-recommend/use-real-ai4soar.mjs
 *       set the service image to ai4soar-recommend:local and remove STUB_ROLE
 *       from its deployment env
 *   node scripts/ai4soar-recommend/use-real-ai4soar.mjs --revert
 *       restore secsim-e2e-stub:local with STUB_ROLE=reaction
 *
 * `copy-db.sh` resets `intact_m1` to the stub, so run this again after every
 * copy (see EVALUATION-PROTOCOL.md step 2 and the folder README).
 *
 * SAFETY: writes only to `intact_m1` — the guard below refuses any other
 * database. The M1 evaluation never writes to `intact`.
 */
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI ?? '';
if (new URL(uri).pathname.replace('/', '') !== 'intact_m1') {
  throw new Error('refusing to write: MONGODB_URI must point to the intact_m1 database');
}

const REAL_IMAGE = 'ai4soar-recommend:local';
const STUB_IMAGE = 'secsim-e2e-stub:local';
const STUB_ENV = { name: 'STUB_ROLE', value: 'reaction' };
const revert = process.argv.includes('--revert');

const client = await MongoClient.connect(uri);
try {
  const services = client.db().collection('services');
  const svc = await services.findOne(
    { shortName: 'AI4SOAR' },
    { projection: { versions: 1, currentVersion: 1, 'deployment.env': 1 } }
  );
  if (!svc) throw new Error('AI4SOAR service not found in intact_m1');

  // The deploy engine resolves the image from the version the topology node
  // references, falling back to currentVersion and then the last version
  // (server/src/services/kubernetesDeploy.ts resolveTopologyNodes). Update
  // every version, so the switch holds whatever the nodes reference.
  const versions = (svc.versions ?? []).map((v) => ({
    ...v,
    dockerImage: revert ? STUB_IMAGE : REAL_IMAGE,
  }));

  // deployment.env: drop STUB_ROLE for the real engine, keep it for the stub.
  const env = (svc.deployment?.env ?? []).filter((e) => e.name !== 'STUB_ROLE');
  if (!revert) {
    // The recommendation-only engine reads KAFKA_BOOTSTRAP_SERVERS and
    // KAFKA_TOPIC from the deployment env — make sure they survive the edit.
    for (const name of ['KAFKA_BOOTSTRAP_SERVERS', 'KAFKA_TOPIC']) {
      if (!env.some((e) => e.name === name)) {
        throw new Error(`AI4SOAR deployment env has no ${name} — refusing to switch blindly`);
      }
    }
  } else {
    if (!env.some((e) => e.name === STUB_ENV.name)) env.push(STUB_ENV);
  }

  const image = revert ? STUB_IMAGE : REAL_IMAGE;
  await services.updateOne(
    { _id: svc._id },
    { $set: { versions, 'deployment.env': env } }
  );
  console.log(
    `AI4SOAR: image=${image} STUB_ROLE=${revert ? 'reaction' : 'removed'} ` +
      `(versions: ${versions.map((v) => v.version).join(', ')})`
  );
} finally {
  await client.close();
}
