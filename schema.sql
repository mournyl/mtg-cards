-- mournyl mtg — D1 schema
-- Apply with:  npx wrangler d1 execute mournyl-mtg --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  failed      INTEGER NOT NULL DEFAULT 0,
  lock_until  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS favorites (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id   TEXT NOT NULL,
  data      TEXT NOT NULL,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lists_user ON lists(user_id);

CREATE TABLE IF NOT EXISTS list_cards (
  list_id   INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  card_id   TEXT NOT NULL,
  data      TEXT NOT NULL,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (list_id, card_id)
);

-- tier lists (also in migrations/0002_tier_feedback.sql)
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

CREATE TABLE IF NOT EXISTS rate_hits (
  key         TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_hits_key ON rate_hits(key, at);
