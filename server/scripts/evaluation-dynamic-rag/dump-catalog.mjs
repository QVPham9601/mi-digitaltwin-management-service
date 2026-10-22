#!/usr/bin/env node
/**
 * Dump the active (non-deprecated) catalog and the scenarios' service lists to
 * JSON, for the dynamic-RAG ground truth (ground_truth.py).
 *
 *   cd server && node scripts/evaluation-dynamic-rag/dump-catalog.mjs [--out=catalog-snapshot.json]
 * Env: MONGODB_URI (default mongodb://127.0.0.1:27017/intact).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT =
  process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ??
  join(HERE, 'catalog-snapshot.json');
const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/intact';

await mongoose.connect(URI);
const db = mongoose.connection.db;
const names = async (collection) =>
  new Map((await db.collection(collection).find().toArray()).map((d) => [String(d._id), d.name]));
const categories = await names('categories');
const sectors = await names('sectors');

const active = await db.collection('services').find({ deprecated: { $ne: true } }).toArray();
const shortNameById = new Map(active.map((s) => [String(s._id), s.shortName]));
const services = active.map((s) => ({
  shortName: s.shortName,
  provider: s.provider,
  category: categories.get(String(s.categoryId)) ?? null,
  sector: s.sectorId ? (sectors.get(String(s.sectorId)) ?? null) : null,
  type: s.type,
  uiType: s.uiType,
  trlCurrent: s.trl?.current ?? null,
  trlExpected: s.trl?.expected ?? null,
  potentialUseCases: s.potentialUseCases ?? [],
  repositoryTable: s.repositoryTable,
  standards: s.standards ?? [],
  license: s.license ?? null,
}));
const scenarios = (await db.collection('scenarios').find().toArray()).map((sc) => ({
  title: sc.title,
  services: (sc.topology?.nodes ?? [])
    .map((n) => shortNameById.get(String(n.serviceId ?? n.data?.serviceId)))
    .filter(Boolean),
}));

writeFileSync(
  OUT,
  `${JSON.stringify({ dumpedAt: new Date().toISOString(), services, scenarios }, null, 2)}\n`
);
console.log(`${services.length} active services, ${scenarios.length} scenarios → ${OUT}`);
await mongoose.disconnect();
