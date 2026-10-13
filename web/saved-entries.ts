import type { Entry } from '../shared/schema';

type CachedEntry = { entry: Entry | null; expires: number };
type FetchBatch = (ids: string[]) => Promise<Entry[]>;

async function fetchBatch(ids: string[]) {
  const response = await fetch('/api/entries/batch?ids=' + ids.join(','));
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);
  return ((await response.json()) as { items: Entry[] }).items;
}

export class SavedEntryStore {
  private cache = new Map<string, CachedEntry>();
  private pending = new Map<string, Promise<Entry | null>>();
  private revision = 0;

  constructor(
    private loadBatch: FetchBatch = fetchBatch,
    private now: () => number = Date.now,
  ) {}

  remember(entries: Entry[]) {
    for (const entry of entries) this.put(entry.id, entry);
  }

  private put(id: string, entry: Entry | null) {
    this.cache.delete(id);
    this.cache.set(id, { entry, expires: this.now() + 60_000 });
    // Bound session memory even after browsing many catalog pages.
    if (this.cache.size > 500)
      this.cache.delete(this.cache.keys().next().value!);
  }

  async getMany(ids: string[], revision = 0): Promise<Entry[]> {
    if (revision !== this.revision) {
      this.revision = revision;
      this.cache.clear();
      this.pending.clear();
    }
    const unique = [...new Set(ids)].filter((id) => /^[a-f0-9]{64}$/.test(id));
    const missing = unique.filter(
      (id) =>
        (this.cache.get(id)?.expires ?? 0) <= this.now() &&
        !this.pending.has(id),
    );
    for (let offset = 0; offset < missing.length; offset += 80) {
      const batch = missing.slice(offset, offset + 80);
      // Share in-flight requests across effect restarts and collection changes.
      // Do not abort them when just one consumer stops displaying the results.
      const loaded = Promise.resolve()
        .then(() => this.loadBatch(batch))
        .then((entries) => new Map(entries.map((entry) => [entry.id, entry])));
      for (const id of batch) {
        const pending = loaded
          .then((entries) => {
            const entry = entries.get(id) ?? null;
            if (this.revision === revision) this.put(id, entry);
            return entry;
          })
          .finally(() => {
            if (this.pending.get(id) === pending) this.pending.delete(id);
          });
        this.pending.set(id, pending);
      }
    }
    const entries = await Promise.all(
      unique.map(
        (id) =>
          this.pending.get(id) ??
          Promise.resolve(this.cache.get(id)?.entry ?? null),
      ),
    );
    return entries.filter((entry): entry is Entry => entry !== null);
  }
}

export function selectSavedEntries(
  entries: Entry[],
  filters: {
    kind: string;
    hall: number | null;
    purpose: string;
    query: string;
    sort: string;
    page: number;
    pageSize: number;
  },
) {
  const { kind, hall, purpose, query, sort, page, pageSize } = filters;
  const filtered = entries.filter(
    (entry) =>
      entry.kind === kind &&
      (!hall || entry.town_hall === hall) &&
      (purpose === 'all' || entry.purpose === purpose) &&
      (!query ||
        `${entry.title} ${entry.tags.join(' ')}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  filtered.sort((a, b) =>
    sort === 'latest'
      ? b.updated_at.localeCompare(a.updated_at)
      : a.updated_at.localeCompare(b.updated_at),
  );
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
  };
}
