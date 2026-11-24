-- mournyl mtg — My decks: one row per deck, cards stored as JSON (names + counts)
-- Optional: the worker creates this table by itself the first time someone opens My decks.
-- To make it up front anyway:  npx wrangler d1 execute mournyl-mtg --remote --file=migrations/0002_decks.sql
-- Only adds a table; nothing existing changes. (Named user_decks because an older "decks" table may exist.)

CREATE TABLE IF NOT EXISTS user_decks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_decks_user ON user_decks(user_id, updated_at);
