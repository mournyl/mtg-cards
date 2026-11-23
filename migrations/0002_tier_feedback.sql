-- mournyl mtg — tier lists: "suggest a tier" feedback queue and per-IP rate limits
-- Apply once with:  npx wrangler d1 execute mournyl-mtg --remote --file=migrations/0002_tier_feedback.sql

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
