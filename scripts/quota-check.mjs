import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

// Exercise real local D1 accounting; never open a production database.
const state = await mkdtemp(join(tmpdir(), 'atlas-quota-'));
process.env.XDG_CONFIG_HOME = join(state, 'config');
process.env.WRANGLER_LOG_PATH = join(state, 'wrangler.log');
process.env.WRANGLER_SEND_METRICS = 'false';
const { getPlatformProxy } = await import('wrangler');
let proxy;
try {
  proxy = await getPlatformProxy({
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const db = proxy.env.DB;
  for (const file of ['0001_initial.sql', '0002_hero_loadouts.sql']) {
    const sql = (
      await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')
    ).replace(/^--.*$/gm, '');
    for (const statement of sql
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  await db
    .prepare(
      "INSERT INTO sources(id,name,home_url) VALUES('test','Test','https://example.com')",
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE numbers(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<500
  ) INSERT INTO entries (
    id,kind,village,town_hall,title,purpose,image_url,source_id,source_url,
    source_name,content_hash,created_at,updated_at,last_seen_at,visibility,link_status
  ) SELECT printf('%064x',n),CASE WHEN n%5=0 THEN 'army' ELSE 'base' END,
    'home',n%18+1,'Test','war','https://example.com/image.jpg','test',
    'https://example.com/base','Test','hash','2026-10-13','2026-10-13','2026-10-13',
    CASE WHEN n%13=0 THEN 'hidden' ELSE 'published' END,
    CASE WHEN n%17=0 THEN 'expired' ELSE 'unverified' END FROM numbers`,
    )
    .run();
  const js = ts.transpileModule(
    await readFile(new URL('../worker/store.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
  const { catalogLevelsSql } = await import(
    'data:text/javascript,' + encodeURIComponent(js)
  );
  const original = await db
    .prepare(
      `SELECT h.level,
    SUM(CASE WHEN e.kind='base' THEN 1 ELSE 0 END) AS bases,
    SUM(CASE WHEN e.kind='army' THEN 1 ELSE 0 END) AS armies
    FROM hall_levels h LEFT JOIN entries e ON e.village=h.village AND e.town_hall=h.level
      AND e.visibility='published' AND e.link_status<>'expired'
    WHERE h.village='home' GROUP BY h.level ORDER BY h.level DESC`,
    )
    .all();
  const optimized = await db.prepare(catalogLevelsSql).all();
  assert.deepEqual(optimized.results, original.results);
  assert.ok(
    optimized.meta.rows_read < original.meta.rows_read / 5,
    'Catalog aggregation must avoid scanning entries for every hall',
  );
  console.log(
    JSON.stringify({
      fixture_entries: 500,
      original_rows_read: original.meta.rows_read,
      optimized_rows_read: optimized.meta.rows_read,
      reduction_percent: Math.round(
        (1 - optimized.meta.rows_read / original.meta.rows_read) * 100,
      ),
    }),
  );
} finally {
  if (proxy) await proxy.dispose();
  await rm(state, { recursive: true, force: true });
}
