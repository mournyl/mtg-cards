-- mournyl mtg — tier lists and deck tools: saved decks, check history, tier feedback, Spellbook cache
-- Apply once with:  npx wrangler d1 execute mournyl-mtg --remote --file=migrations/0002_decks_feedback.sql

CREATE TABLE IF NOT EXISTS decks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  commander   TEXT NOT NULL DEFAULT '',
  list        TEXT NOT NULL,
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decks_user ON decks(user_id, updated_at);

CREATE TABLE IF NOT EXISTS deck_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  deck_id     INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  summary     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deck_checks_deck ON deck_checks(deck_id, created_at);

CREATE TABLE IF NOT EXISTS tier_feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  role        TEXT NOT NULL,
  card        TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT '',
  suggested   TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_hash     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tier_feedback_status ON tier_feedback(status, created_at);

CREATE TABLE IF NOT EXISTS spellbook_cache (
  key         TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_hits (
  key         TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_hits_key ON rate_hits(key, at);
