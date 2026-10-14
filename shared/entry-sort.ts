export const entrySorts = {
  discovered_desc: { field: 'first_seen_at', direction: 'DESC', label: '本站首次发现 · 从新到旧' },
  discovered_asc: { field: 'first_seen_at', direction: 'ASC', label: '本站首次发现 · 从旧到新' },
  published_desc: { field: 'source_published_at', direction: 'DESC', label: '来源发布 · 从新到旧' },
  published_asc: { field: 'source_published_at', direction: 'ASC', label: '来源发布 · 从旧到新' },
  source_updated_desc: { field: 'source_updated_at', direction: 'DESC', label: '来源更新 · 从新到旧' },
  source_updated_asc: { field: 'source_updated_at', direction: 'ASC', label: '来源更新 · 从旧到新' },
} as const;
export type EntrySort = keyof typeof entrySorts;
export const entrySortKeys = Object.keys(entrySorts) as [EntrySort, ...EntrySort[]];
export function normalizeSort(value: string | null): EntrySort {
  if (value === 'oldest') return 'discovered_asc';
  if (value && Object.hasOwn(entrySorts, value)) return value as EntrySort;
  return 'discovered_desc';
}
