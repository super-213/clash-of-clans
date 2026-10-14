import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const state = await mkdtemp(join(tmpdir(), 'atlas-test-'));
const cli = 'node_modules/.bin/wrangler';
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false',
  XDG_CONFIG_HOME: join(state, 'config'),
};
let server;
let output = '';
const rules = JSON.parse(await readFile(new URL('../shared/game-rules.json', import.meta.url), 'utf8'));
try {
  const migration = spawnSync(
    cli,
    [
      'd1',
      'migrations',
      'apply',
      'village-atlas',
      '--local',
      '--persist-to',
      state,
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  server = spawn(
    cli,
    [
      'dev',
      '--port',
      '8877',
      '--persist-to',
      state,
      '--var',
      'INGEST_TOKEN:integration-ingest',
      '--var',
      'ADMIN_TOKEN:integration-admin',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout.on('data', (chunk) => {
    output += chunk;
  });
  server.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const root = 'http://127.0.0.1:8877';
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(root + '/api/health')).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Worker did not start: ' + output.slice(-2500));
  const request = (path, body, token = 'integration-ingest', method = 'POST') =>
    fetch(root + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  const entry = {
    kind: 'base',
    village: 'home',
    town_hall: 18,
    title: '防三星测试阵型',
    purpose: 'war',
    tags: ['防三星'],
    game_link:
      'https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3Aintegration',
    image_url: 'https://source.example/base.jpg',
    source_id: 'test-source',
    source_url: 'https://source.example/base',
    source_name: 'Test',
    units: [],
    compatibility: { status: 'compatible', rules_version: rules.version, reasons: [], evidence_url: 'https://source.example/inventory' },
  };
  assert.equal(
    (await request('/api/ingest/entries', { entries: [entry] }, 'wrong'))
      .status,
    401,
  );
  assert.equal(
    (
      await request('/api/ingest/entries', {
        entries: [{ ...entry, town_hall: 17 }],
      })
    ).status,
    400,
  );
  assert.equal(
    (await request('/api/ingest/entries', { entries: [entry] })).status,
    200,
  );
  let list = await (
    await fetch(root + '/api/entries?th=18&q=' + encodeURIComponent('防三星'))
  ).json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].link_status, 'unverified');
  assert.equal('content_hash' in list.items[0], false);
  const first = list.items[0];
  // Legacy, incompatible and previous-rule data stay stored but are excluded
  // from list, detail, saved-item lookups and both summary counts.
  for (const [label, compatibility] of [
    ['legacy', undefined],
    ['incompatible', { ...entry.compatibility, status: 'incompatible', reasons: ['missing_building'] }],
    ['previous-rules', { ...entry.compatibility, rules_version: 'previous-release' }],
  ]) {
    const hidden = { ...entry, game_link: entry.game_link + '-' + label, compatibility };
    assert.equal((await request('/api/ingest/entries', { entries: [hidden] })).status, 200);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`base:home:18:TH18:WB:integration-${label}`));
    const hiddenId = Buffer.from(bytes).toString('hex');
    assert.equal((await fetch(root + '/api/entries/' + hiddenId)).status, 404);
    assert.deepEqual((await (await fetch(root + '/api/entries/batch?ids=' + hiddenId)).json()).items, []);
  }
  assert.equal((await (await fetch(root + '/api/entries')).json()).total, 1);
  assert.equal((await (await fetch(root + '/api/catalog')).json()).total_bases, 1);
  // Rechecks can retire an already published share without changing its ID.
  await request('/api/ingest/entries', { entries: [{ ...entry, compatibility: { ...entry.compatibility, status: 'unknown', reasons: ['inventory_missing'] } }] });
  assert.equal((await fetch(root + '/api/entries/' + first.id)).status, 404);
  assert.equal((await (await fetch(root + '/api/entries')).json()).total, 0);
  await request('/api/ingest/entries', { entries: [entry] });
  const restored = (await (await fetch(root + '/api/entries')).json()).items[0];
  assert.equal(restored.id, first.id);
  assert.equal(restored.created_at, first.created_at);
  // Rechecking changes content timestamps, so subsequent dedup comparisons
  // use the freshly restored observation.
  first.updated_at = restored.updated_at;
  first.last_seen_at = restored.last_seen_at;
  assert.deepEqual(first.hero_loadouts, []);
  assert.equal(first.origins.length, 1);
  assert.equal(first.origins[0].source_url, entry.source_url);
  assert.equal(first.origins[0].first_seen_at, first.created_at);
  await request('/api/ingest/entries', {
    entries: [
      {
        ...entry,
        game_link:
          'https://link.clashofclans.com/cn?id=TH18:WB:integration&action=OpenLayout',
      },
    ],
  });
  list = await (await fetch(root + '/api/entries')).json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].updated_at, first.updated_at);
  assert.ok(list.items[0].last_seen_at >= first.last_seen_at);
  assert.equal(list.items[0].origins.length, 1);
  assert.equal(
    list.items[0].origins[0].first_seen_at,
    first.origins[0].first_seen_at,
  );
  assert.ok(
    list.items[0].origins[0].last_seen_at >= first.origins[0].last_seen_at,
  );
  const secondSource = {
    ...entry,
    source_id: 'second-source',
    source_name: 'Second Source',
    source_url: 'https://second.example/layout/original?ref=18',
  };
  await request('/api/ingest/entries', { entries: [secondSource] });
  await request('/api/ingest/entries', { entries: [secondSource] });
  list = await (await fetch(root + '/api/entries')).json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].origins.length, 2);
  const detail = await (await fetch(root + '/api/entries/' + first.id)).json();
  assert.deepEqual(detail.origins, list.items[0].origins);
  assert.equal(detail.source_url, secondSource.source_url);
  assert.equal(detail.link_status, 'unverified');
  assert.equal(
    detail.origins.find((origin) => origin.source_id === 'test-source')
      .first_seen_at,
    first.origins[0].first_seen_at,
  );
  assert.equal(
    detail.origins.find((origin) => origin.source_id === 'second-source')
      .source_url,
    secondSource.source_url,
  );
  const sources = await (await fetch(root + '/api/sources')).json();
  assert.equal(
    sources.items.find((source) => source.id === 'test-source').entries,
    1,
  );
  assert.equal(
    sources.items.find((source) => source.id === 'second-source').entries,
    1,
  );
  const wildcard = await (await fetch(root + '/api/entries?q=%25')).json();
  assert.equal(wildcard.total, 0);
  assert.equal((await fetch(root + '/api/entries?th=abc')).status, 400);
  assert.equal((await fetch(root + '/api/does-not-exist')).status, 404);
  const catalogResponse = await fetch(root + '/api/catalog');
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.headers.get('X-Atlas-Cache'), 'MISS');
  assert.equal(
    (await fetch(root + '/api/catalog')).headers.get('X-Atlas-Cache'),
    'HIT',
  );
  assert.equal(catalog.total_bases, 1);
  assert.equal(catalog.levels.length, 18);
  assert.equal(catalog.levels.find((level) => level.level === 1).bases, 0);
  // Batch lookup omits unavailable IDs, deduplicates and keeps full provenance.
  const missingId = 'f'.repeat(64);
  const batchPath =
    '/api/entries/batch?ids=' + [first.id, missingId, first.id].join(',');
  const savedBatch = await (await fetch(root + batchPath)).json();
  assert.equal(savedBatch.items.length, 1);
  assert.deepEqual(savedBatch.items[0].origins, detail.origins);
  assert.equal('content_hash' in savedBatch.items[0], false);
  assert.equal(
    (await fetch(root + batchPath)).headers.get('X-Atlas-Cache'),
    'HIT',
  );
  const fullBatch = [
    first.id,
    ...Array.from({ length: 79 }, (_, i) => i.toString(16).padStart(64, '0')),
  ];
  assert.equal(
    (
      await (
        await fetch(root + '/api/entries/batch?ids=' + fullBatch.join(','))
      ).json()
    ).items.length,
    1,
  );
  assert.equal((await fetch(root + '/api/entries/batch?ids=bad')).status, 400);
  assert.equal(
    (
      await fetch(
        root + '/api/entries/batch?ids=' + Array(81).fill(first.id).join(','),
      )
    ).status,
    400,
  );
  await request(
    '/api/admin/entries/' + first.id,
    { visibility: 'hidden', link_status: 'reported' },
    'integration-admin',
    'PATCH',
  );
  await request('/api/ingest/entries', { entries: [entry] });
  assert.equal((await (await fetch(root + '/api/entries')).json()).total, 0);
  assert.equal((await fetch(root + '/api/entries/' + first.id)).status, 404);
  assert.deepEqual((await (await fetch(root + batchPath)).json()).items, []);
  assert.equal(
    (await (await fetch(root + '/api/catalog')).json()).total_bases,
    0,
  );
  await request(
    '/api/admin/sources/test-source',
    { enabled: false },
    'integration-admin',
    'PATCH',
  );
  const blocked = await (
    await request('/api/ingest/entries', {
      entries: [{ ...entry, game_link: entry.game_link + '2' }],
    })
  ).json();
  assert.equal(blocked.accepted, 0);
  const run = {
    id: crypto.randomUUID(),
    source_id: 'test-source',
    source_name: 'Test',
    home_url: 'https://source.example',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    status: 'failed',
    discovered: 0,
    ingested: 0,
    error: 'source unavailable',
  };
  assert.equal((await request('/api/ingest/runs', run)).status, 200);
  await request('/api/ingest/runs', run);
  const runs = await (
    await fetch(root + '/api/admin/runs', {
      headers: { Authorization: 'Bearer integration-admin' },
    })
  ).json();
  assert.equal(runs.length, 1);
  assert.equal((await fetch(root + '/api/admin/runs')).status, 401);
  assert.equal((await fetch(root + '/media/not-a-hash.jpg')).status, 404);
  const noLink = {
    ...entry,
    town_hall: 3,
    game_link: null,
    source_url: 'https://source.example/th3',
    compatibility: { status: 'unknown', rules_version: rules.version, reasons: ['missing_layout_link'], evidence_url: null },
  };
  assert.equal(
    (
      await request('/api/ingest/entries', {
        entries: [{ ...noLink, source_id: 'another-source' }],
      })
    ).status,
    200,
  );
  const lowHall = await (await fetch(root + '/api/entries?th=3')).json();
  assert.equal(lowHall.total, 0);
  const item = {
    name: 'Rocket Backpack',
    image_url: 'https://source.example/equipment.webp',
    image_source_url: 'https://source.example/encyclopedia',
  };
  const army = {
    ...entry,
    source_id: 'army-source',
    kind: 'army',
    title: 'Hydra loadouts',
    game_link:
      'https://link.clashofclans.com/en?action=CopyArmy&army=h7p11e53_57u8x8',
    hero_loadouts: [
      {
        hero: { ...item, name: 'Dragon Duke' },
        pet: { ...item, name: 'Angry Jelly' },
        equipment: [item, { ...item, name: 'Flame Blower' }],
        source_url: entry.source_url,
        source_text: 'Dragon Duke with Angry Jelly',
        notes: '',
      },
    ],
  };
  assert.equal(
    (await request('/api/ingest/entries', { entries: [army] })).status,
    200,
  );
  const armyFirst = (
    await (await fetch(root + '/api/entries?kind=army')).json()
  ).items[0];
  assert.deepEqual(armyFirst.hero_loadouts, army.hero_loadouts);
  assert.equal(
    (await (await fetch(root + '/api/entries/' + armyFirst.id)).json())
      .hero_loadouts[0].pet.name,
    'Angry Jelly',
  );
  await request('/api/ingest/entries', { entries: [army] });
  assert.equal(
    (await (await fetch(root + '/api/entries/' + armyFirst.id)).json())
      .updated_at,
    armyFirst.updated_at,
  );
  await request(
    '/api/admin/entries/' + armyFirst.id,
    { visibility: 'published', link_status: 'reported' },
    'integration-admin',
    'PATCH',
  );
  const changedArmy = {
    ...army,
    hero_loadouts: [{ ...army.hero_loadouts[0], pet: null, equipment: [item] }],
  };
  await request('/api/ingest/entries', { entries: [changedArmy] });
  const changed = await (
    await fetch(root + '/api/entries/' + armyFirst.id)
  ).json();
  assert.equal(changed.hero_loadouts[0].pet, null);
  assert.equal(changed.hero_loadouts[0].equipment.length, 1);
  assert.ok(changed.updated_at > armyFirst.updated_at);
  assert.equal(changed.link_status, 'reported');
  assert.equal(changed.created_at, armyFirst.created_at);
  const dated = [
    { label: 'A', source_published_at: '2026-10-01', source_updated_at: '2026-10-03', first_seen_at: '2026-09-03T00:00:00.000Z' },
    { label: 'B', source_published_at: null, source_updated_at: null, first_seen_at: '2026-09-02T00:00:00.000Z' },
    { label: 'C', source_published_at: '2026-09-01', source_updated_at: '2026-10-10', first_seen_at: '2026-09-01T00:00:00.000Z' },
  ].map(({ label, ...times }) => ({ ...entry, ...times, source_id: 'dates-source',
    source_name: 'Dates Source', title: '时间测试 ' + label,
    game_link: entry.game_link + '-dates-' + label, source_url: 'https://dates.example/' + label }));
  assert.equal((await request('/api/ingest/entries', { entries: dated })).status, 200);
  const dateList = async (sort, page = 1, limit = 12) => (await fetch(root + '/api/entries?' + new URLSearchParams({
    q: '时间测试', sort, page: String(page), limit: String(limit),
  }))).json();
  for (const [sort, labels] of [
    ['published_desc', ['A', 'C', 'B']], ['published_asc', ['C', 'A', 'B']],
    ['source_updated_desc', ['C', 'A', 'B']], ['source_updated_asc', ['A', 'C', 'B']],
    ['discovered_desc', ['A', 'B', 'C']], ['discovered_asc', ['C', 'B', 'A']],
    ['latest', ['A', 'B', 'C']], ['oldest', ['C', 'B', 'A']],
  ]) assert.deepEqual((await dateList(sort)).items.map(x => x.title.slice(-1)), labels);
  assert.equal((await dateList('published_desc', 2, 1)).items[0].title, '时间测试 C');
  assert.equal((await fetch(root + '/api/entries?sort=untrusted_column')).status, 400);
  const datedFirst = (await dateList('discovered_desc')).items[0];
  assert.equal(datedFirst.source_published_at, '2026-10-01');
  assert.equal(datedFirst.first_seen_at, '2026-09-03T00:00:00.000Z');
  assert.equal(datedFirst.origins[0].source_updated_at, '2026-10-03');
  await request('/api/ingest/entries', { entries: [{ ...dated[0], first_seen_at: '2026-10-14T00:00:00Z' }] });
  let datedDetail = await (await fetch(root + '/api/entries/' + datedFirst.id)).json();
  assert.equal(datedDetail.first_seen_at, datedFirst.first_seen_at);
  assert.equal(datedDetail.updated_at, datedFirst.updated_at);
  await request('/api/ingest/entries', { entries: [{ ...dated[0], source_id: 'dates-second',
    source_name: 'Second date source', source_url: 'https://dates-second.example/A',
    source_published_at: '2026-08-01', source_updated_at: '2026-10-12', first_seen_at: '2026-09-02T00:00:00Z' }] });
  datedDetail = await (await fetch(root + '/api/entries/' + datedFirst.id)).json();
  assert.equal(datedDetail.source_published_at, '2026-08-01');
  assert.equal(datedDetail.first_seen_at, '2026-09-02T00:00:00.000Z');
  assert.equal(datedDetail.created_at, datedFirst.created_at);
  assert.equal(datedDetail.origins.find(x => x.source_id === 'dates-source').source_published_at, '2026-10-01');
  assert.equal(datedDetail.origins.find(x => x.source_id === 'dates-source').first_seen_at, datedFirst.first_seen_at);
  assert.equal(datedDetail.compatibility.status, 'compatible'); // Old article dates never retire a share.
  console.log(
    'PASS: all six date sorts, missing dates last, pagination, source-specific dates, preserved first observation, compatibility independent of dates, and existing D1/auth/ingestion/provenance/moderation contracts.',
  );
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  await rm(state, { recursive: true, force: true });
}
