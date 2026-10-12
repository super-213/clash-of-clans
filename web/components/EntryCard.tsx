import { ArrowRight, Copy, ExternalLink, Heart } from 'lucide-react';
import type { Entry } from '../../shared/schema';
import { date, fullDate, purposes } from '../format';
import { Picture, UnitStrip } from './Media';

export function EntryCard({
  entry,
  index,
  isSaved,
  onSave,
  onSelect,
  onCopy,
}: {
  entry: Entry;
  index: number;
  isSaved: boolean;
  onSave: (id: string) => void;
  onSelect: (entry: Entry) => void;
  onCopy: (entry: Entry) => void;
}) {
  return (
    <article
      className="entry"
      key={entry.id}
      style={{ animationDelay: `${Math.min(index, 5) * 45}ms` }}
    >
      <div
        className={`entry-visual ${entry.kind === 'army' ? 'army-visual' : ''}`}
      >
        <button
          className="visual-open"
          onClick={() => onSelect(entry)}
          aria-label={`查看 ${entry.title}`}
        >
          {entry.kind === 'base' || !entry.units.length ? (
            <Picture src={entry.image_url} alt={entry.title} />
          ) : (
            <>
              <span className="army-board-label">ARMY COMPOSITION</span>
              <UnitStrip
                units={entry.units
                  .filter((u) => u.group === 'troop' || u.group === 'siege')
                  .slice(0, 6)}
              />
              <span className="army-spells">
                <UnitStrip
                  units={entry.units
                    .filter((u) => u.group === 'spell')
                    .slice(0, 6)}
                />
              </span>
            </>
          )}
        </button>
        <span className="visual-tag">
          TH {entry.town_hall} <span>·</span> {purposes[entry.purpose]}
        </span>
        <button
          className={`save-button ${isSaved ? 'is-saved' : ''}`}
          aria-label={isSaved ? '取消收藏' : '收藏'}
          aria-pressed={isSaved}
          onClick={() => onSave(entry.id)}
        >
          <Heart size={17} fill={isSaved ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="entry-info">
        <div className="entry-tags">
          {entry.tags.slice(0, 2).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
          <span className="unverified">
            {entry.link_status === 'unavailable'
              ? '暂无分享链接'
              : entry.link_status === 'confirmed'
                ? '人工确认'
                : entry.link_status === 'reported'
                  ? '待复核'
                  : '未游戏内验证'}
          </span>
        </div>
        <button className="entry-title" onClick={() => onSelect(entry)}>
          {entry.title}
        </button>
        <div className="entry-origin">
          <a href={entry.source_url} target="_blank" rel="noopener noreferrer">
            <span>来源：{entry.source_name}</span>
            <ExternalLink size={10} />
          </a>
          <div className="entry-origin-meta">
            <time
              dateTime={entry.last_seen_at}
              title={fullDate(entry.last_seen_at)}
            >
              采集于 {date(entry.last_seen_at)}
            </time>
            {entry.origins.length > 1 && (
              <button onClick={() => onSelect(entry)}>
                {entry.origins.length} 个出处
              </button>
            )}
          </div>
        </div>
        <div className="entry-actions">
          <button
            className="copy-button"
            disabled={!entry.game_link}
            onClick={() => onCopy(entry)}
          >
            <Copy size={14} />
            {entry.game_link
              ? `复制${entry.kind === 'base' ? '阵型' : '配兵'}链接`
              : '暂无分享链接'}
          </button>
          {entry.game_link && (
            <a
              href={entry.game_link}
              className="game-button"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="在游戏中打开"
            >
              <ArrowRight size={18} />
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
