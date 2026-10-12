import type { Entry, EntryInput, EntryOrigin } from '../shared/schema';

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

// Language, tracking parameters and query order do not change a game share.
export async function entryId(
  entry: Pick<
    EntryInput,
    'kind' | 'village' | 'town_hall' | 'game_link' | 'source_url'
  >,
) {
  if (!entry.game_link)
    return digest(
      `${entry.kind}:${entry.village}:${entry.town_hall}:source:${entry.source_url}`,
    );
  const url = new URL(entry.game_link);
  return digest(
    `${entry.kind}:${entry.village}:${entry.town_hall}:${url.searchParams.get(entry.kind === 'base' ? 'id' : 'army')}`,
  );
}

function hydrate(row: Record<string, unknown>, origins: EntryOrigin[]): Entry {
  const { content_hash: _hash, visibility: _visibility, ...safe } = row;
  return {
    ...safe,
    origins,
    tags: JSON.parse(String(row.tags)),
    units: JSON.parse(String(row.units)),
    hero_loadouts: JSON.parse(String(row.hero_loadouts ?? '[]')),
  } as Entry;
}

// One bounded query per page, rather than one provenance query per entry.
export async function withOrigins(
  db: D1Database,
  rows: Record<string, unknown>[],
): Promise<Entry[]> {
  if (!rows.length) return [];
  const result = await db
    .prepare(
      `SELECT p.entry_id,p.source_id,s.name AS source_name,p.source_url,p.first_seen_at,p.last_seen_at
     FROM provenance p JOIN sources s ON s.id=p.source_id
     WHERE p.entry_id IN (${rows.map(() => '?').join(',')})
     ORDER BY p.last_seen_at DESC,p.source_id,p.source_url`,
    )
    .bind(...rows.map((row) => String(row.id)))
    .all<EntryOrigin & { entry_id: string }>();
  const byEntry = new Map<string, EntryOrigin[]>();
  for (const { entry_id, ...origin } of result.results) {
    const origins = byEntry.get(entry_id) ?? [];
    origins.push(origin);
    byEntry.set(entry_id, origins);
  }
  return rows.map((row) => hydrate(row, byEntry.get(String(row.id)) ?? []));
}

export async function ingest(db: D1Database, entries: EntryInput[]) {
  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  for (const entry of entries) {
    const id = await entryId(entry);
    const hash = await digest(
      JSON.stringify({
        title: entry.title,
        purpose: entry.purpose,
        tags: entry.tags,
        image_url: entry.image_url,
        units: entry.units,
        hero_loadouts: entry.hero_loadouts,
      }),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO sources(id,name,home_url) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, home_url=excluded.home_url`,
        )
        .bind(
          entry.source_id,
          entry.source_name,
          new URL(entry.source_url).origin,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO entries
      (id,kind,village,town_hall,title,purpose,tags,game_link,image_url,units,hero_loadouts,source_id,source_url,source_name,content_hash,created_at,updated_at,last_seen_at,link_status)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT enabled FROM sources WHERE id=?)=1
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, purpose=excluded.purpose, tags=excluded.tags,
        image_url=excluded.image_url, units=excluded.units, hero_loadouts=excluded.hero_loadouts, source_id=excluded.source_id,
        source_url=excluded.source_url, source_name=excluded.source_name,
        updated_at=CASE WHEN entries.content_hash<>excluded.content_hash THEN excluded.updated_at ELSE entries.updated_at END,
        content_hash=excluded.content_hash, last_seen_at=excluded.last_seen_at`,
        )
        .bind(
          id,
          entry.kind,
          entry.village,
          entry.town_hall,
          entry.title,
          entry.purpose,
          JSON.stringify(entry.tags),
          entry.game_link,
          entry.image_url,
          JSON.stringify(entry.units),
          JSON.stringify(entry.hero_loadouts),
          entry.source_id,
          entry.source_url,
          entry.source_name,
          hash,
          now,
          now,
          now,
          entry.game_link ? 'unverified' : 'unavailable',
          entry.source_id,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO provenance(entry_id,source_id,source_url,first_seen_at,last_seen_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM entries WHERE id=?) AND (SELECT enabled FROM sources WHERE id=?)=1
      ON CONFLICT(entry_id,source_id,source_url) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
        )
        .bind(
          id,
          entry.source_id,
          entry.source_url,
          now,
          now,
          id,
          entry.source_id,
        ),
    );
  }
  const results = await db.batch(statements);
  return results
    .filter((_, i) => i % 3 === 1)
    .reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}
