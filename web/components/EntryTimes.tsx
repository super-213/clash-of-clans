import type { Entry } from '../../shared/schema';
import { fullDate, shortDate } from '../format';

export function EntryTimes({ entry, compact = false }: { entry: Entry; compact?: boolean }) {
  return (
    <dl className={`entry-times ${compact ? 'compact' : ''}`}>
      {[
        ['来源发布时间', entry.source_published_at],
        ['来源更新时间', entry.source_updated_at],
        ['本站首次发现', entry.first_seen_at ?? entry.created_at],
      ].map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ? <time dateTime={value} title={fullDate(value)}>
            {compact ? shortDate(value) : fullDate(value)}
          </time> : '未提供'}</dd>
        </div>
      ))}
    </dl>
  );
}
