import type { Entry, HeroLoadout } from '../../shared/schema';
import { unitName } from '../format';
import { Picture } from './Media';

type Item = HeroLoadout['hero'];
function Slot({ label, item }: { label: string; item?: Item | null }) {
  return (
    <div className={`loadout-slot ${item ? '' : 'loadout-missing'}`}>
      <span className="loadout-slot-label">{label}</span>
      {item?.image_url ? (
        <Picture src={item.image_url} alt={item.name} />
      ) : (
        <span className="loadout-placeholder" aria-hidden="true">
          {item ? '◇' : '—'}
        </span>
      )}
      <span className="loadout-name">{item?.name ?? '来源未注明'}</span>
    </div>
  );
}

export function HeroLoadouts({ entry }: { entry: Entry }) {
  const loadouts: HeroLoadout[] = entry.hero_loadouts?.length
    ? entry.hero_loadouts
    : entry.units
        .filter((u) => u.group === 'hero')
        .map((u) => ({
          hero: {
            name: u.name,
            image_url: u.image_url,
            image_source_url: entry.source_url,
          },
          pet: null,
          equipment: [],
          source_url: entry.source_url,
          source_text: '',
          notes: '',
        }));
  return (
    <section className="hero-loadouts" aria-label="英雄、宠物与技能装备搭配">
      <h3>英雄搭配</h3>
      <p className="loadout-explainer">空缺配置请到原文核对。</p>
      {!loadouts.length && (
        <p className="loadout-explainer">来源暂未提供英雄搭配。</p>
      )}
      <div className="loadout-grid">
        {loadouts.map((loadout, index) => {
          const heroLabel = unitName({
            ...loadout.hero,
            image_url: loadout.hero.image_url ?? '',
            group: 'hero',
            count: 1,
          });
          const illustrations = [
            ...new Set(
              [loadout.hero, loadout.pet, ...loadout.equipment].flatMap(
                (item) =>
                  item?.image_source_url ? [item.image_source_url] : [],
              ),
            ),
          ];
          return (
            <article
              className="hero-loadout"
              key={`${loadout.hero.name}-${index}`}
              aria-label={`${heroLabel}的搭配`}
            >
              <div className="loadout-hero">
                {loadout.hero.image_url && (
                  <Picture src={loadout.hero.image_url} alt={heroLabel} />
                )}
                <h4>{heroLabel}</h4>
              </div>
              <div className="loadout-slots">
                <Slot label="宠物" item={loadout.pet} />
                <Slot label="技能装备 1" item={loadout.equipment[0]} />
                <Slot label="技能装备 2" item={loadout.equipment[1]} />
              </div>
              {loadout.notes && (
                <p className="loadout-notes">原文备注：{loadout.notes}</p>
              )}
              <details className="loadout-evidence">
                <summary>搭配出处与配图来源</summary>
                <a
                  href={loadout.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  核对搭配原文 ↗
                </a>
                {loadout.source_text && <p lang="en">{loadout.source_text}</p>}
                {illustrations.length > 0 && (
                  <div>
                    配图出处：
                    {illustrations.map((url, i) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        图鉴 {i + 1} ↗
                      </a>
                    ))}
                  </div>
                )}
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}
