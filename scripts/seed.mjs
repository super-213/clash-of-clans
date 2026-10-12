import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const snapshot = JSON.parse(
  await readFile(process.argv[2] || 'data/catalog.json', 'utf8'),
);
const quote = (value) =>
  value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = new Date().toISOString();
const sql = [];
for (const entry of snapshot.entries) {
  const payload = entry.game_link
    ? new URL(entry.game_link).searchParams.get(
        entry.kind === 'base' ? 'id' : 'army',
      )
    : null;
  const id = hash(
    `${entry.kind}:${entry.village}:${entry.town_hall}:${payload ?? `source:${entry.source_url}`}`,
  );
  const contentHash = hash(
    JSON.stringify({
      title: entry.title,
      purpose: entry.purpose,
      tags: entry.tags,
      image_url: entry.image_url,
      units: entry.units,
      hero_loadouts: entry.hero_loadouts ?? [],
    }),
  );
  sql.push(
    `INSERT INTO sources(id,name,home_url) VALUES(${[entry.source_id, entry.source_name, new URL(entry.source_url).origin].map(quote)}) ON CONFLICT(id) DO NOTHING;`,
  );
  const fields = [
    'id',
    'kind',
    'village',
    'town_hall',
    'title',
    'purpose',
    'tags',
    'game_link',
    'image_url',
    'units',
    'hero_loadouts',
    'source_id',
    'source_url',
    'source_name',
    'content_hash',
    'created_at',
    'updated_at',
    'last_seen_at',
    'link_status',
  ];
  const values = [
    id,
    entry.kind,
    entry.village,
    entry.town_hall,
    entry.title,
    entry.purpose,
    JSON.stringify(entry.tags),
    entry.game_link,
    entry.image_url,
    JSON.stringify(entry.units),
    JSON.stringify(entry.hero_loadouts ?? []),
    entry.source_id,
    entry.source_url,
    entry.source_name,
    contentHash,
    now,
    now,
    now,
    entry.game_link ? 'unverified' : 'unavailable',
  ];
  sql.push(
    `INSERT INTO entries(${fields}) VALUES(${values.map(quote)}) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,purpose=excluded.purpose,tags=excluded.tags,
      image_url=excluded.image_url,units=excluded.units,hero_loadouts=excluded.hero_loadouts,
      source_id=excluded.source_id,source_url=excluded.source_url,source_name=excluded.source_name,
      updated_at=CASE WHEN entries.content_hash<>excluded.content_hash THEN excluded.updated_at ELSE entries.updated_at END,
      content_hash=excluded.content_hash,last_seen_at=excluded.last_seen_at;`,
  );
  sql.push(
    `INSERT INTO provenance(entry_id,source_id,source_url,first_seen_at,last_seen_at) VALUES(${[id, entry.source_id, entry.source_url, now, now].map(quote)}) ON CONFLICT(entry_id,source_id,source_url) DO UPDATE SET last_seen_at=excluded.last_seen_at;`,
  );
}
for (const run of snapshot.runs || []) {
  sql.push(
    `INSERT INTO sources(id,name,home_url) VALUES(${[run.source_id, run.source_name, run.home_url].map(quote)}) ON CONFLICT(id) DO NOTHING;`,
  );
  sql.push(
    `INSERT INTO crawl_runs(id,source_id,started_at,finished_at,status,discovered,ingested,error) VALUES(${[run.id, run.source_id, run.started_at, run.finished_at, run.status, run.discovered, run.ingested, run.error || ''].map(quote)}) ON CONFLICT(id) DO NOTHING;`,
  );
}
const path = join(tmpdir(), `atlas-seed-${randomUUID()}.sql`);
await writeFile(path, sql.join('\n'));
try {
  const result = spawnSync(
    'node_modules/.bin/wrangler',
    ['d1', 'execute', 'village-atlas', '--local', '--file', path],
    {
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  if (result.status !== 0) console.error(result.stderr || result.stdout);
  if (result.status !== 0) process.exitCode = result.status || 1;
  else
    console.log(
      `Imported ${snapshot.entries.length} records into local D1 only.`,
    );
} finally {
  await unlink(path);
}
