-- Additive migration: existing records remain readable with unknown loadouts.
ALTER TABLE entries ADD COLUMN hero_loadouts TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(hero_loadouts));
