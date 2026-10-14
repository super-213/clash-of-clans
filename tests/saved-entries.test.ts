import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../shared/schema';
import { SavedEntryStore, selectSavedEntries } from '../web/saved-entries';

const id = (i: number) => i.toString(16).padStart(64, '0');
const entry = (i: number) =>
  ({
    id: id(i),
    kind: 'base',
    town_hall: 18,
    purpose: 'war',
    title: `资料 ${i}`,
    tags: ['测试'],
    updated_at: String(i).padStart(4, '0'),
    first_seen_at: new Date(Date.UTC(2026, 0, 1) + i * 86400_000).toISOString(),
    source_published_at: null,
    source_updated_at: null,
  }) as Entry;

describe('saved collection loading', () => {
  it('sorts by the selected time with unknown dates last in either direction', () => {
    const entries = [
      { ...entry(1), source_published_at: '2026-10-01', source_updated_at: '2026-10-03' },
      { ...entry(2), source_published_at: null, source_updated_at: null },
      { ...entry(3), source_published_at: '2026-09-01', source_updated_at: '2026-10-10' },
    ];
    const filters = { kind: 'base', hall: 18, purpose: 'all', query: '', sort: 'published_desc', page: 1, pageSize: 12 };
    const ids = (sort: string) => selectSavedEntries(entries, { ...filters, sort }).items.map(x => x.id);
    expect(ids('published_desc')).toEqual([id(1), id(3), id(2)]);
    expect(ids('published_asc')).toEqual([id(3), id(1), id(2)]);
    expect(ids('source_updated_desc')).toEqual([id(3), id(1), id(2)]);
    expect(ids('source_updated_asc')).toEqual([id(1), id(3), id(2)]);
    expect(ids('discovered_desc')).toEqual([id(3), id(2), id(1)]);
  });
  it('loads 200 entries in three batches and filters/pages without more requests', async () => {
    const load = vi.fn(async (ids: string[]) =>
      ids.map((key) => entry(parseInt(key, 16))),
    );
    const store = new SavedEntryStore(load);
    const ids = Array.from({ length: 200 }, (_, i) => id(i));
    const entries = await store.getMany(ids);
    expect(load.mock.calls.map(([ids]) => ids.length)).toEqual([80, 80, 40]);
    const filters = {
      kind: 'base',
      hall: 18,
      purpose: 'all',
      query: '',
      sort: 'latest',
      page: 1,
      pageSize: 12,
    };
    expect(selectSavedEntries(entries, filters).items[0].id).toBe(id(199));
    expect(
      selectSavedEntries(entries, { ...filters, page: 2 }).items[0].id,
    ).toBe(id(187));
    expect(
      selectSavedEntries(entries, { ...filters, query: '测试', sort: 'oldest' })
        .items[0].id,
    ).toBe(id(0));
    await store.getMany(ids);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('reuses catalog entries and concurrent requests, fetching only added IDs', async () => {
    let resolve!: (entries: Entry[]) => void;
    const load = vi.fn(
      () =>
        new Promise<Entry[]>((done) => {
          resolve = done;
        }),
    );
    const store = new SavedEntryStore(load);
    store.remember([entry(1)]);
    const first = store.getMany([id(1), id(2)]);
    const restart = store.getMany([id(2), id(1), id(2)]);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]).toEqual([[id(2)]]);
    resolve([entry(2)]);
    expect((await first).map((x) => x.id)).toEqual([id(1), id(2)]);
    expect((await restart).map((x) => x.id)).toEqual([id(2), id(1)]);
    await store.getMany([id(1)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('temporarily remembers removed entries and retries failures and expired data', async () => {
    let now = 1000;
    const load = vi.fn(async (_ids: string[]): Promise<Entry[]> => []);
    const store = new SavedEntryStore(load, () => now);
    expect(await store.getMany([id(1)])).toEqual([]);
    await store.getMany([id(1)]);
    expect(load).toHaveBeenCalledTimes(1);
    now += 60_001;
    load.mockRejectedValueOnce(new Error('offline'));
    await expect(store.getMany([id(1)])).rejects.toThrow('offline');
    load.mockResolvedValueOnce([entry(1)]);
    expect(await store.getMany([id(1)])).toEqual([entry(1)]);
    expect(load).toHaveBeenCalledTimes(3);
    await store.getMany([id(1)], 1);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('does not let an older in-flight response overwrite a forced refresh', async () => {
    const resolve: ((entries: Entry[]) => void)[] = [];
    const load = vi.fn(
      () => new Promise<Entry[]>((done) => resolve.push(done)),
    );
    const store = new SavedEntryStore(load);
    const old = store.getMany([id(1)]);
    const fresh = store.getMany([id(1)], 1);
    await Promise.resolve();
    const updated = { ...entry(1), title: '更新后的资料' };
    resolve[1]([updated]);
    await fresh;
    resolve[0]([entry(1)]);
    await old;
    expect(await store.getMany([id(1)], 1)).toEqual([updated]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
