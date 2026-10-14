import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { entrySchema, type Entry } from '../shared/schema';
import { fullDate, shortDate } from '../web/format';
import { EntryTimes } from '../web/components/EntryTimes';

describe('source and site date display', () => {
  it('keeps source calendar dates separate from timezone-qualified instants', () => {
    expect(shortDate('2026-10-01')).toBe('2026/10/01');
    expect(fullDate('2026-10-01')).toBe('2026/10/01（仅日期）');
    expect(shortDate('2026-10-01T20:00:00Z')).toBe('2026/10/02');
    expect(fullDate(null)).toBe('未提供');
    expect(fullDate('invalid')).toBe('未提供');
  });
  it('shows all three labels and the legacy site receipt fallback', () => {
    const html = renderToStaticMarkup(createElement(EntryTimes, { entry: {
      source_published_at: null, source_updated_at: '2026-10-01',
      created_at: '2026-10-02T00:00:00Z',
    } as Entry }));
    for (const text of ['来源发布时间', '来源更新时间', '本站首次发现', '未提供', '2026/10/01', '2026/10/02'])
      expect(html).toContain(text);
  });
  it('rejects invalid input dates at the ingestion boundary', () => {
    const shape = entrySchema;
    const entry = { kind:'army', town_hall:18, title:'Army', purpose:'war',
      game_link:'https://link.clashofclans.com/en?action=CopyArmy&army=u1x0',
      image_url:'https://example.com/image.jpg', source_id:'test', source_name:'Test', source_url:'https://example.com' };
    expect(shape.parse(entry).source_published_at).toBe(null);
    expect(shape.safeParse({ ...entry, source_published_at:'2026-02-30' }).success).toBe(false);
    expect(shape.safeParse({ ...entry, source_updated_at:'2026-10-01' }).success).toBe(true);
    expect(shape.safeParse({ ...entry, first_seen_at:'2026-10-01' }).success).toBe(false);
  });
});
