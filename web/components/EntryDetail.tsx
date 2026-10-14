import { Copy, ExternalLink, Heart } from 'lucide-react';
import type { Entry } from '../../shared/schema';
import { fullDate, purposes } from '../format';
import { Picture, UnitStrip, Dialog } from './Media';
import { HeroLoadouts } from './HeroLoadouts';
import { EntryTimes } from './EntryTimes';

export function EntryDetail({
  selected,
  isSaved,
  onSave,
  onCopy,
  onClose,
}: {
  selected: Entry;
  isSaved: boolean;
  onSave: (id: string) => void;
  onCopy: (entry: Entry) => void;
  onClose: () => void;
}) {
  return (
    <Dialog close={onClose} label={selected.title}>
      <div className="detail-media">
        {selected.kind === 'base' ? (
          <Picture src={selected.image_url} alt={selected.title} />
        ) : (
          <div className="detail-army">
            <HeroLoadouts entry={selected} />
            {!selected.units.length && (
              <Picture
                className="army-composition-image"
                src={selected.image_url}
                alt={`${selected.title} · 来源配兵图`}
              />
            )}
            {(['troop', 'spell', 'siege'] as const)
              .filter((group) => selected.units.some((u) => u.group === group))
              .map((group) => (
                <section key={group}>
                  <h3>
                    {
                      {
                        troop: '兵种',
                        spell: '法术',
                        siege: '攻城机器',
                      }[group]
                    }
                  </h3>
                  <UnitStrip
                    units={selected.units.filter((u) => u.group === group)}
                    full
                  />
                </section>
              ))}
          </div>
        )}
      </div>
      <div className="detail-body">
        <span className="detail-kicker">
          TH {selected.town_hall} / {purposes[selected.purpose]}
        </span>
        <h2>{selected.title}</h2>
        <EntryTimes entry={selected} />
        {selected.kind === 'army' && (
          <p>分享链接可能不含完整英雄搭配，请在游戏内核对。</p>
        )}
        <p>
          {!selected.game_link
            ? '来源暂未提供分享链接，可以参考图片手动摆放。'
            : selected.link_status === 'reported'
              ? '链接待复核，请以游戏内导入结果为准。'
              : `链接${selected.link_status === 'confirmed' ? '已人工确认' : '未在游戏内验证'}，以游戏内导入结果为准。`}
        </p>
        <div className="detail-actions">
          {selected.game_link && (
            <>
              <button
                className="primary-button"
                onClick={() => onCopy(selected)}
              >
                <Copy size={15} />
                复制游戏链接
              </button>
              <a
                className="secondary-button"
                href={selected.game_link}
                target="_blank"
                rel="noopener noreferrer"
              >
                在游戏中打开
                <ExternalLink size={14} />
              </a>
            </>
          )}
          <button
            className="icon-button"
            aria-label={isSaved ? '取消收藏' : '收藏'}
            aria-pressed={isSaved}
            onClick={() => onSave(selected.id)}
          >
            <Heart size={20} fill={isSaved ? 'currentColor' : 'none'} />
          </button>
        </div>
        <details className="entry-provenance">
          <summary>
            来源与收录记录 <span>{selected.origins.length} 个出处</span>
          </summary>
          <p>来源时间属于对应网页，不是游戏链接创建时间，也不作为版本判断依据。</p>
          {selected.game_link && (
            <label className="link-field">
              原始分享链接
              <input
                readOnly
                value={selected.game_link}
                onFocus={(e) => e.target.select()}
              />
            </label>
          )}
          <ul>
            {selected.origins.map((origin) => (
              <li key={`${origin.source_id}:${origin.source_url}`}>
                <div className="provenance-title">
                  <a
                    href={origin.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {origin.source_name}
                    <ExternalLink size={13} />
                  </a>
                  {origin.source_id === selected.source_id &&
                    origin.source_url === selected.source_url && (
                      <span>当前来源</span>
                    )}
                </div>
                <a
                  className="provenance-url"
                  href={origin.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {origin.source_url}
                </a>
                <dl>
                  <div>
                    <dt>来源发布时间</dt>
                    <dd>{fullDate(origin.source_published_at)}</dd>
                  </div>
                  <div>
                    <dt>来源更新时间</dt>
                    <dd>{fullDate(origin.source_updated_at)}</dd>
                  </div>
                  <div>
                    <dt>本站首次发现此出处</dt>
                    <dd>
                      <time dateTime={origin.first_seen_at}>
                        {fullDate(origin.first_seen_at)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>最近采集</dt>
                    <dd>
                      <time dateTime={origin.last_seen_at}>
                        {fullDate(origin.last_seen_at)}
                      </time>
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="provenance-note">出处数量不代表独立验证。</p>
        </details>
      </div>
    </Dialog>
  );
}
