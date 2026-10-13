import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app, { type Env } from '../worker/index';

describe('public API shared cache', () => {
  let stored: Map<string, { response: Response; expires: number }>;
  let tasks: Promise<unknown>[];
  let env: Env;
  let prepare: ReturnType<typeof vi.fn>;
  let batch: ReturnType<typeof vi.fn>;
  const ctx = {
    waitUntil: (task: Promise<unknown>) => tasks.push(task),
  } as unknown as ExecutionContext;
  const read = async (path: string, init?: RequestInit) => {
    const response = await app.fetch(
      new Request('https://atlas.example' + path, init),
      env,
      ctx,
    );
    await Promise.all(tasks.splice(0));
    return response;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    stored = new Map();
    tasks = [];
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (request: Request) => {
          const item = stored.get(request.url);
          return item && item.expires > Date.now()
            ? item.response.clone()
            : undefined;
        },
        put: async (request: Request, response: Response) => {
          const ttl = Number(
            response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1],
          );
          stored.set(request.url, {
            response: response.clone(),
            expires: Date.now() + ttl * 1000,
          });
        },
      }),
    });
    prepare = vi.fn(() => ({
      all: async () => ({ results: [{ level: 18, bases: 2, armies: 1 }] }),
      first: async () => ({ time: '2026-10-13T00:00:00Z' }),
      bind() {
        return this;
      },
      run: async () => ({ meta: { changes: 1 } }),
    }));
    batch = vi.fn(async () => [{ results: [] }, { results: [{ total: 0 }] }]);
    env = { DB: { prepare, batch }, ADMIN_TOKEN: 'admin' } as unknown as Env;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('serves repeated catalog reads without D1 and bounds browser freshness', async () => {
    const first = await read('/api/catalog');
    expect(first.headers.get('X-Atlas-Cache')).toBe('MISS');
    expect(((await first.json()) as { total_bases: number }).total_bases).toBe(
      2,
    );
    expect(prepare).toHaveBeenCalledTimes(2);
    for (const item of stored.values()) {
      item.response.headers.set('Age', '290');
      item.response.headers.set(
        'Date',
        new Date(Date.now() - 290_000).toUTCString(),
      );
    }
    vi.advanceTimersByTime(290_000);
    const hit = await read('/api/catalog?utm_source=other');
    expect(hit.headers.get('X-Atlas-Cache')).toBe('HIT');
    expect(hit.headers.get('Cache-Control')).toBe('public, max-age=10');
    expect(hit.headers.get('Date')).toBe(new Date().toUTCString());
    expect(hit.headers.has('Age')).toBe(false);
    expect(hit.headers.has('X-Atlas-Cached-At')).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_001);
    expect((await read('/api/catalog')).headers.get('X-Atlas-Cache')).toBe(
      'MISS',
    );
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it('canonicalizes list defaults but separates filters and pagination', async () => {
    await read('/api/entries');
    expect(
      (
        await read(
          '/api/entries?sort=latest&limit=12&page=1&village=home&kind=base&utm_source=x',
        )
      ).headers.get('X-Atlas-Cache'),
    ).toBe('HIT');
    expect(batch).toHaveBeenCalledTimes(1);
    await read('/api/entries?th=18');
    await read('/api/entries?page=2');
    expect(batch).toHaveBeenCalledTimes(3);
    expect((await read('/api/entries?th=abc')).status).toBe(400);
    expect(batch).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(60_001);
    expect((await read('/api/entries')).headers.get('X-Atlas-Cache')).toBe(
      'MISS',
    );
    expect(batch).toHaveBeenCalledTimes(4);
  });

  it('invalidates all local variants after moderation and never caches admin requests', async () => {
    await read('/api/catalog');
    await read('/api/entries?th=18');
    const denied = await read('/api/admin/sources/test', {
      method: 'PATCH',
      body: '{}',
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('Cache-Control')).toBe('no-store');
    expect((await read('/api/catalog')).headers.get('X-Atlas-Cache')).toBe(
      'HIT',
    );
    const moderated = await read('/api/admin/entries/' + 'a'.repeat(64), {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin' },
      body: JSON.stringify({ visibility: 'hidden', link_status: 'expired' }),
    });
    expect(moderated.status).toBe(200);
    expect(moderated.headers.get('Cache-Control')).toBe('no-store');
    expect((await read('/api/catalog')).headers.get('X-Atlas-Cache')).toBe(
      'MISS',
    );
    expect(
      (await read('/api/entries?th=18')).headers.get('X-Atlas-Cache'),
    ).toBe('MISS');
  });

  it('falls back to D1 if the cache is unavailable', async () => {
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('cache unavailable');
      },
    });
    expect((await read('/api/catalog')).status).toBe(200);
    expect((await read('/api/catalog')).status).toBe(200);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it('does not cache missing entries or failed database reads', async () => {
    prepare.mockImplementation(() => ({
      bind() {
        return this;
      },
      first: async () => null,
    }));
    expect((await read('/api/entries/' + 'a'.repeat(64))).status).toBe(404);
    expect((await read('/api/entries/' + 'a'.repeat(64))).status).toBe(404);
    expect(prepare).toHaveBeenCalledTimes(2);
    prepare.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await read('/api/catalog')).status).toBe(500);
    expect((await read('/api/catalog')).status).toBe(500);
    expect(stored.size).toBe(0);
    log.mockRestore();
  });
});
