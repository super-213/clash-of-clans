PRAGMA foreign_keys = ON;
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  home_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('base','army')),
  village TEXT NOT NULL CHECK(village IN ('home','builder')),
  town_hall INTEGER NOT NULL CHECK(town_hall BETWEEN 1 AND 50),
  title TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('war','farming','trophy','hybrid','general')),
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)),
  game_link TEXT,
  image_url TEXT NOT NULL,
  units TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(units)),
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'published' CHECK(visibility IN ('published','hidden')),
  link_status TEXT NOT NULL DEFAULT 'unverified' CHECK(link_status IN ('unverified','reported','confirmed','expired','unavailable')),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_entries_filter ON entries(visibility, village, kind, town_hall, updated_at DESC, id);
CREATE INDEX idx_entries_purpose ON entries(visibility, purpose, updated_at DESC);
CREATE TABLE provenance (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_url TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(entry_id, source_id, source_url)
);
CREATE TABLE crawl_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','partial','failed')),
  discovered INTEGER NOT NULL DEFAULT 0,
  ingested INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_crawl_runs_source_time ON crawl_runs(source_id, finished_at DESC);
CREATE TABLE hall_levels (
  village TEXT NOT NULL, level INTEGER NOT NULL,
  PRIMARY KEY(village, level)
);
INSERT INTO hall_levels(village, level) VALUES
 ('home',1),('home',2),('home',3),('home',4),('home',5),('home',6),
 ('home',7),('home',8),('home',9),('home',10),('home',11),('home',12),
 ('home',13),('home',14),('home',15),('home',16),('home',17),('home',18);
