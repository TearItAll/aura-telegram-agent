-- Additive, news-only daily generation claim and public-summary cache.
CREATE TABLE aura_daily_news_ai (
  owner_id TEXT NOT NULL,
  news_date TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed','succeeded','fallback')),
  reason TEXT,
  parts_json TEXT CHECK (parts_json IS NULL OR json_valid(parts_json)),
  counted_input_tokens INTEGER,
  input_tokens INTEGER,
  candidate_tokens INTEGER,
  thought_tokens INTEGER,
  total_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(owner_id,news_date)
);
