-- Existing observations have no content proof. Keep them for reassessment,
-- but never publish them as current solely because they have a valid URL.
ALTER TABLE entries ADD COLUMN compatibility TEXT NOT NULL DEFAULT
  '{"status":"unknown","rules_version":null,"reasons":["not_checked"],"evidence_url":null}'
  CHECK(json_valid(compatibility));
