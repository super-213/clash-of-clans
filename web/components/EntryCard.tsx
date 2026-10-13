import { ArrowUpRight, Copy, Heart } from 'lucide-react';
import type { Entry } from '../../shared/schema';
import { purposes } from '../format';
import { Picture, UnitStrip } from './Media';

export function EntryCard({
  entry,
  isSaved,
  onSave,
  onSelect,
  onCopy,
}: {
  entry: Entry;
  isSaved: boolean;
  onSave: (id: string) => void;
  onSelect: (entry: Entry) => void;
  onCopy: (entry: Entry) => void;
}) {
  const tags = entry.tags
    .filter(
      (tag) =>
        tag !== purposes[entry.purpose] &&
        !entry.title.includes(tag) &&
        !/(配图|出处|来源|采集)/.test(tag),
    )
    .slice(0, 2);
  return (
    <article className="entry">
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
        <button
          className={`save-button ${isSaved ? 'is-saved' : ''}`}
          aria-label={isSaved ? '取消收藏' : '收藏'}
          aria-pressed={isSaved}
          onClick={() => onSave(entry.id)}
        >
          <Heart size={18} fill={isSaved ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="entry-info">
        <button className="entry-title" onClick={() => onSelect(entry)}>
          {entry.title}
        </button>
        <div className="entry-tags">
          <span>{purposes[entry.purpose]}</span>
          {entry.link_status === 'reported' && <span>链接待复核</span>}
          {tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
        <div className="entry-actions">
          <button
            className="copy-button"
            disabled={!entry.game_link}
            onClick={() => onCopy(entry)}
          >
            <Copy size={15} />
            {entry.game_link ? '复制链接' : '暂无链接'}
          </button>
          {entry.game_link && (
            <a
              href={entry.game_link}
              className="game-button"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="在游戏中打开"
            >
              打开
              <ArrowUpRight size={15} />
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
