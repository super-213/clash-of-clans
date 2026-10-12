import { z } from 'zod';

const httpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  }, 'HTTPS URL required');
const imageUrl = z.union([
  httpsUrl,
  z.string().regex(/^\/media\/[a-f0-9]{64}\.(webp|png|jpg)$/),
]);
export const unitSchema = z.object({
  name: z.string().min(1).max(100),
  count: z.number().int().min(1).max(1000),
  group: z.enum(['troop', 'spell', 'siege', 'hero']),
  image_url: imageUrl,
});
const loadoutItemSchema = z.object({
  name: z.string().min(1).max(100),
  image_url: imageUrl.nullable().default(null),
  image_source_url: httpsUrl.nullable().default(null),
});
export const heroLoadoutSchema = z.object({
  hero: loadoutItemSchema,
  pet: loadoutItemSchema.nullable(),
  equipment: z.array(loadoutItemSchema).max(2),
  source_url: httpsUrl,
  source_text: z.string().max(1500),
  notes: z.string().max(500).default(''),
});
export type HeroLoadout = z.infer<typeof heroLoadoutSchema>;
export const entrySchema = z
  .object({
    kind: z.enum(['base', 'army']),
    village: z.enum(['home', 'builder']).default('home'),
    town_hall: z.number().int().min(1).max(50),
    title: z.string().min(1).max(200),
    purpose: z.enum(['war', 'farming', 'trophy', 'hybrid', 'general']),
    tags: z.array(z.string().min(1).max(40)).max(12).default([]),
    game_link: httpsUrl.nullable(),
    image_url: imageUrl,
    source_id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    source_url: httpsUrl,
    source_name: z.string().min(1).max(100),
    units: z.array(unitSchema).max(100).default([]),
    hero_loadouts: z.array(heroLoadoutSchema).max(8).default([]),
  })
  .superRefine((v, ctx) => {
    if (!v.game_link) {
      if (v.kind === 'army')
        ctx.addIssue({
          code: 'custom',
          path: ['game_link'],
          message: 'Army share link required',
        });
      return;
    }
    const u = new URL(v.game_link);
    const action = v.kind === 'base' ? 'OpenLayout' : 'CopyArmy';
    const payload = u.searchParams.get(v.kind === 'base' ? 'id' : 'army');
    if (
      u.hostname !== 'link.clashofclans.com' ||
      u.port ||
      u.searchParams.get('action') !== action ||
      !payload
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['game_link'],
        message: 'Invalid game share link',
      });
    }
    if (
      v.kind === 'base' &&
      payload &&
      !payload.startsWith(
        `${v.village === 'home' ? 'TH' : 'BH'}${v.town_hall}:`,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['town_hall'],
        message: 'Hall does not match layout link',
      });
    }
  });
export const ingestSchema = z.object({
  entries: z.array(entrySchema).min(1).max(25),
});
export type EntryInput = z.infer<typeof entrySchema>;
export type Unit = z.infer<typeof unitSchema>;
export type EntryOrigin = {
  source_id: string;
  source_name: string;
  source_url: string;
  first_seen_at: string;
  last_seen_at: string;
};
export type Entry = EntryInput & {
  origins: EntryOrigin[];
  id: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  link_status:
    'unverified' | 'reported' | 'confirmed' | 'expired' | 'unavailable';
};
export type Catalog = {
  levels: { level: number; bases: number; armies: number }[];
  total_bases: number;
  total_armies: number;
  last_sync: string | null;
};
