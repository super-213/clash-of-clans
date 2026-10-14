import { Hono } from 'hono';
import { z } from 'zod';
import { ingestSchema } from '../shared/schema';
import { catalogLevelsSql, compatibleContentSql, digest, withOrigins, ingest } from './store';
import { cachedPublicJson, invalidatePublicCache } from './cache';
import { entrySortKeys, entrySorts, normalizeSort } from '../shared/entry-sort';

export type Env = {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  INGEST_TOKEN?: string;
  ADMIN_TOKEN?: string;
  ENVIRONMENT: string;
};
const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  await next();
});

for (const [path, secret] of [
  ['/api/ingest/*', 'INGEST_TOKEN'],
  ['/api/admin/*', 'ADMIN_TOKEN'],
] as const) {
  app.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const token = c.env[secret];
    if (!token) return c.json({ error: 'Service not configured' }, 503);
    const supplied = c.req.header('Authorization') ?? '';
    if ((await digest(supplied)) !== (await digest(`Bearer ${token}`)))
      return c.json({ error: 'Unauthorized' }, 401);
    const size = Number(c.req.header('Content-Length') ?? 0);
    if (size > 512_000) return c.json({ error: 'Body too large' }, 413);
    await next();
  });
}

async function jsonBody(request: Request) {
  // Bound streams as well as Content-Length, which callers can omit.
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid JSON');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 512_000) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Invalid JSON');
  }
}

const listSchema = z.object({
  kind: z.enum(['base', 'army']).default('base'),
  village: z.enum(['home', 'builder']).default('home'),
  th: z.coerce.number().int().min(1).max(50).optional(),
  purpose: z.enum(['war', 'farming', 'trophy', 'hybrid', 'general']).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
  sort: z.enum([...entrySortKeys, 'latest', 'oldest']).default('discovered_desc'),
});

app.get('/api/health', async (c) => {
  await c.env.DB.prepare('SELECT 1').first();
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, version: '0.1.0' });
});

app.get('/api/catalog', async (c) => {
  return cachedPublicJson(c, 'catalog', 300, async () => {
    const levels = await c.env.DB.prepare(catalogLevelsSql).all<{
      level: number;
      bases: number;
      armies: number;
    }>();
    const last = await c.env.DB.prepare(
      `SELECT MAX(last_seen_at) AS time FROM entries WHERE visibility='published' AND ${compatibleContentSql}`,
    ).first<{ time: string | null }>();
    return c.json({
      levels: levels.results,
      total_bases: levels.results.reduce((n, x) => n + x.bases, 0),
      total_armies: levels.results.reduce((n, x) => n + x.armies, 0),
      last_sync: last?.time ?? null,
    });
  });
});

app.get('/api/entries', async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid filters' }, 400);
  const { kind, village, th, purpose, q, page, limit, sort } = parsed.data;
  const normalizedSort = normalizeSort(sort);
  const order = entrySorts[normalizedSort];
  const timeColumn = order.field === 'first_seen_at' ? 'COALESCE(first_seen_at,created_at)' : order.field;
  // Defaults, parameter ordering and unrelated tracking parameters share a key.
  const filters = new URLSearchParams({
    kind,
    village,
    page: String(page),
    limit: String(limit),
    sort: normalizedSort,
  });
  if (th) filters.set('th', String(th));
  if (purpose) filters.set('purpose', purpose);
  if (q?.trim()) filters.set('q', q.trim());
  return cachedPublicJson(c, 'entries?' + filters, 60, async () => {
    const clauses = [
      "visibility='published'",
      "link_status<>'expired'",
      compatibleContentSql,
      'kind=?',
      'village=?',
    ];
    const values: (string | number)[] = [kind, village];
    if (th) {
      clauses.push('town_hall=?');
      values.push(th);
    }
    if (purpose) {
      clauses.push('purpose=?');
      values.push(purpose);
    }
    if (q?.trim()) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      const search = `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`;
      values.push(search, search);
    }
    const where = clauses.join(' AND ');
    const [rows, total] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare(
        `SELECT * FROM entries WHERE ${where} ORDER BY ${timeColumn} IS NULL ASC,
          julianday(${timeColumn}) ${order.direction}, town_hall DESC, id ASC LIMIT ? OFFSET ?`,
      ).bind(...values, limit, (page - 1) * limit),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM entries WHERE ${where}`,
      ).bind(...values),
    ]);
    return c.json({
      items: await withOrigins(c.env.DB, rows.results),
      total: total.results[0].total,
      page,
      limit,
    });
  });
});

// 80 IDs stay below D1's 100 bound parameters per statement. A full 200-item
// collection needs at most three requests, with two SQL statements each.
app.get('/api/entries/batch', async (c) => {
  const parsed = z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(80)
    .safeParse(c.req.query('ids')?.split(','));
  if (!parsed.success) return c.json({ error: 'Invalid entry IDs' }, 400);
  const ids = [...new Set(parsed.data)].sort();
  return cachedPublicJson(c, 'batch?ids=' + ids.join(','), 60, async () => {
    const rows = await c.env.DB.prepare(
      `SELECT * FROM entries WHERE id IN (${ids.map(() => '?').join(',')})
       AND visibility='published' AND link_status<>'expired' AND ${compatibleContentSql}`,
    )
      .bind(...ids)
      .all<Record<string, unknown>>();
    return c.json({ items: await withOrigins(c.env.DB, rows.results) });
  });
});

app.get('/api/entries/:id', async (c) => {
  if (!/^[a-f0-9]{64}$/.test(c.req.param('id')))
    return c.json({ error: 'Not found' }, 404);
  return cachedPublicJson(c, 'entry/' + c.req.param('id'), 60, async () => {
    const row = await c.env.DB.prepare(
      `SELECT * FROM entries WHERE id=? AND visibility='published' AND link_status<>'expired' AND ${compatibleContentSql}`,
    )
      .bind(c.req.param('id'))
      .first();
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json((await withOrigins(c.env.DB, [row]))[0]);
  });
});

app.get('/api/sources', async (c) => {
  return cachedPublicJson(c, 'sources', 300, async () => {
    const rows = await c.env.DB.prepare(
      `SELECT s.id,s.name,s.home_url,s.enabled,r.status,r.finished_at,r.discovered,r.ingested,
    (SELECT COUNT(DISTINCT p.entry_id) FROM provenance p JOIN entries e ON e.id=p.entry_id
      WHERE p.source_id=s.id AND e.visibility='published' AND e.link_status<>'expired' AND ${compatibleContentSql}) AS entries
    FROM sources s LEFT JOIN crawl_runs r ON r.id=(SELECT id FROM crawl_runs WHERE source_id=s.id ORDER BY finished_at DESC LIMIT 1)
    ORDER BY s.name`,
    ).all();
    return c.json({ items: rows.results });
  });
});

app.post('/api/ingest/entries', async (c) => {
  const body = ingestSchema.safeParse(await jsonBody(c.req.raw));
  if (!body.success)
    return c.json({ error: 'Invalid entries', issues: body.error.issues }, 400);
  const accepted = await ingest(c.env.DB, body.data.entries);
  if (accepted) await invalidatePublicCache(c);
  return c.json({ accepted });
});

const runSchema = z.object({
  id: z.string().uuid(),
  source_id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  source_name: z.string().min(1).max(100),
  home_url: z.url().startsWith('https://'),
  started_at: z.iso.datetime(),
  finished_at: z.iso.datetime(),
  status: z.enum(['success', 'partial', 'failed']),
  discovered: z.number().int().nonnegative(),
  ingested: z.number().int().nonnegative(),
  error: z.string().max(2000).nullable(),
});
app.post('/api/ingest/runs', async (c) => {
  const parsed = runSchema.safeParse(await jsonBody(c.req.raw));
  if (!parsed.success) return c.json({ error: 'Invalid run' }, 400);
  const v = parsed.data;
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO sources(id,name,home_url) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
    ).bind(v.source_id, v.source_name, v.home_url),
    c.env.DB.prepare(
      `INSERT INTO crawl_runs(id,source_id,started_at,finished_at,status,discovered,ingested,error)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    ).bind(
      v.id,
      v.source_id,
      v.started_at,
      v.finished_at,
      v.status,
      v.discovered,
      v.ingested,
      v.error,
    ),
  ]);
  await invalidatePublicCache(c);
  return c.json({ ok: true });
});

app.get('/api/admin/runs', async (c) =>
  c.json(
    (
      await c.env.DB.prepare(
        'SELECT * FROM crawl_runs ORDER BY finished_at DESC LIMIT 100',
      ).all()
    ).results,
  ),
);
app.patch('/api/admin/sources/:id', async (c) => {
  const body = z
    .object({ enabled: z.boolean() })
    .safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: 'Invalid source update' }, 400);
  const result = await c.env.DB.prepare(
    'UPDATE sources SET enabled=? WHERE id=?',
  )
    .bind(Number(body.data.enabled), c.req.param('id'))
    .run();
  if (result.meta.changes) await invalidatePublicCache(c);
  return result.meta.changes
    ? c.json({ ok: true })
    : c.json({ error: 'Not found' }, 404);
});
app.patch('/api/admin/entries/:id', async (c) => {
  const body = z
    .object({
      visibility: z.enum(['published', 'hidden']),
      link_status: z.enum(['unverified', 'reported', 'confirmed', 'expired']),
    })
    .safeParse(await jsonBody(c.req.raw));
  if (!body.success) return c.json({ error: 'Invalid moderation update' }, 400);
  const result = await c.env.DB.prepare(
    'UPDATE entries SET visibility=?,link_status=? WHERE id=?',
  )
    .bind(body.data.visibility, body.data.link_status, c.req.param('id'))
    .run();
  if (result.meta.changes) await invalidatePublicCache(c);
  return result.meta.changes
    ? c.json({ ok: true })
    : c.json({ error: 'Not found' }, 404);
});

app.get('/media/:key', async (c) => {
  const key = c.req.param('key');
  if (!/^[a-f0-9]{64}\.(webp|png|jpg)$/.test(key)) return c.notFound();
  const object = await c.env.IMAGES.get(key, { onlyIf: c.req.raw.headers });
  if (!object) return c.notFound();
  const headers = new Headers({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  if (err.message === 'Invalid JSON')
    return c.json({ error: err.message }, 400);
  if (err.message === 'Body too large')
    return c.json({ error: err.message }, 413);
  console.error(
    JSON.stringify({
      event: 'request_failed',
      path: c.req.path,
      message: err.message,
    }),
  );
  return c.json({ error: '服务暂时不可用，请稍后重试' }, 500);
});

export default app;
