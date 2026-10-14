ALTER TABLE entries ADD COLUMN source_published_at TEXT;
ALTER TABLE entries ADD COLUMN source_updated_at TEXT;
ALTER TABLE entries ADD COLUMN first_seen_at TEXT;
-- Historical first observation is unknown; the original receipt time is the
-- earliest durable site record. Never backfill source dates from site dates.
UPDATE entries SET first_seen_at=created_at;
ALTER TABLE provenance ADD COLUMN source_published_at TEXT;
ALTER TABLE provenance ADD COLUMN source_updated_at TEXT;
