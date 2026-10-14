import type { Context } from 'hono';
import type { Env } from './index';
import rules from '../shared/game-rules.json';

type ApiContext = Context<{ Bindings: Env }>;
// Bump this prefix when the public response contract changes.
const prefix = `/__atlas-cache/v3/${rules.version}/`;

function cacheKey(c: ApiContext, key: string) {
  return new Request(new URL(prefix + key, c.req.url));
}

export async function invalidatePublicCache(c: ApiContext) {
  try {
    const cache = await caches.open('atlas-public-v1');
    // Cache API invalidation is local to this Cloudflare data center. Other
    // centers expire content in 60s and catalog/source summaries in 300s.
    await cache.put(
      cacheKey(c, 'generation'),
      new Response(crypto.randomUUID(), {
        headers: { 'Cache-Control': 'public, max-age=3600' },
      }),
    );
  } catch {
    console.warn('Public cache invalidation unavailable; TTL expiry applies');
  }
}

export async function cachedPublicJson(
  c: ApiContext,
  key: string,
  ttl: number,
  load: () => Promise<Response>,
): Promise<Response> {
  let request: Request | undefined;
  let cache: Cache | undefined;
  try {
    cache = await caches.open('atlas-public-v1');
    const generation = await cache.match(cacheKey(c, 'generation'));
    const token = generation ? await generation.text() : 'initial';
    request = cacheKey(c, `${token}/${key}`);
    const hit = await cache.match(request);
    if (hit) return clientResponse(hit, ttl, 'HIT');
  } catch {
    // Cache outages must not prevent database-backed reads.
    request = undefined;
  }

  const response = await load();
  // Missing entries, validation errors and server errors are never cached.
  if (response.status !== 200) return response;
  const stored = new Response(response.body, response);
  stored.headers.set('Cache-Control', `public, max-age=${ttl}`);
  stored.headers.set('X-Atlas-Cached-At', String(Date.now()));
  if (request && cache) {
    c.executionCtx.waitUntil(
      cache.put(request, stored.clone()).catch(() => {
        console.warn('Public cache write unavailable');
      }),
    );
  }
  return clientResponse(stored, ttl, 'MISS');
}

function clientResponse(response: Response, ttl: number, status: string) {
  const result = new Response(response.body, response);
  const age = Math.max(
    0,
    Math.floor(
      (Date.now() - Number(response.headers.get('X-Atlas-Cached-At'))) / 1000,
    ),
  );
  // A browser must not extend an almost-expired edge response by another 60s.
  result.headers.set(
    'Cache-Control',
    `public, max-age=${Math.max(0, Math.min(60, ttl - age))}`,
  );
  // Freshness has already been reduced above; an old cached Date/Age would
  // make the browser subtract the same elapsed time a second time.
  result.headers.set('Date', new Date().toUTCString());
  result.headers.delete('Age');
  result.headers.delete('X-Atlas-Cached-At');
  result.headers.set('X-Atlas-Cache', status);
  return result;
}
