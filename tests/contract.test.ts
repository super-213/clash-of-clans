import { describe, it, expect } from 'vitest';
import { entrySchema } from '../shared/schema';
import { entryId } from '../worker/store';

const base = {
  kind: 'base',
  village: 'home',
  town_hall: 18,
  title: '18 本阵型',
  purpose: 'war',
  game_link:
    'https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3Asample',
  image_url: 'https://source.example/layout.jpg',
  source_id: 'example',
  source_url: 'https://source.example/base',
  source_name: 'Example',
};

describe('ingestion contract', () => {
  it('validates associated hero loadouts and defaults legacy records to unknown', () => {
    expect(entrySchema.parse(base).hero_loadouts).toEqual([]);
    const item = {
      name: 'Angry Jelly',
      image_url: null,
      image_source_url: null,
    };
    const loadout = {
      hero: { ...item, name: 'Dragon Duke' },
      pet: item,
      equipment: [{ ...item, name: 'Rocket Backpack' }],
      source_url: base.source_url,
      source_text: 'Dragon Duke with Angry Jelly',
    };
    expect(
      entrySchema.parse({ ...base, hero_loadouts: [loadout] }).hero_loadouts[0]
        .pet?.name,
    ).toBe('Angry Jelly');
    expect(
      entrySchema.safeParse({
        ...base,
        hero_loadouts: [{ ...loadout, equipment: [item, item, item] }],
      }).success,
    ).toBe(false);
    expect(
      entrySchema.safeParse({
        ...base,
        hero_loadouts: [
          { ...loadout, pet: { ...item, image_url: 'javascript:alert(1)' } },
        ],
      }).success,
    ).toBe(false);
  });
  it('requires matching hall and official game action', () => {
    expect(entrySchema.safeParse(base).success).toBe(true);
    expect(entrySchema.safeParse({ ...base, town_hall: 17 }).success).toBe(
      false,
    );
    expect(entrySchema.safeParse({ ...base, kind: 'army' }).success).toBe(
      false,
    );
    expect(
      entrySchema.safeParse({
        ...base,
        game_link: base.game_link.replace(
          'link.clashofclans.com',
          'link.clashofclans.com.evil.test',
        ),
      }).success,
    ).toBe(false);
    expect(
      entrySchema.safeParse({ ...base, image_url: 'javascript:alert(1)' })
        .success,
    ).toBe(false);
  });
  it('deduplicates across languages and tracking parameters', async () => {
    const entry = entrySchema.parse(base);
    if (!entry.game_link) throw new Error('Expected link');
    const alternate = {
      ...entry,
      game_link:
        'https://link.clashofclans.com/cn?utm_source=other&id=TH18:WB:sample&action=OpenLayout',
    };
    expect(await entryId(entry)).toEqual(await entryId(alternate));
    expect(
      await entryId({
        ...entry,
        game_link: entry.game_link.replace('sample', 'other'),
      }),
    ).not.toEqual(await entryId(entry));
  });
  it('keeps identical armies independently discoverable at different halls', async () => {
    const army = entrySchema.parse({
      ...base,
      kind: 'army',
      game_link:
        'https://link.clashofclans.com/en?action=CopyArmy&army=u9x65s2x2',
    });
    expect(await entryId(army)).not.toEqual(
      await entryId({ ...army, town_hall: 17 }),
    );
    expect(entrySchema.safeParse({ ...army, game_link: null }).success).toBe(
      false,
    );
    expect(entrySchema.safeParse({ ...base, game_link: null }).success).toBe(
      true,
    );
  });
});
