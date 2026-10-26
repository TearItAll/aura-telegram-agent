-- Additive migration. Review and test before applying to any cloud database.
CREATE TABLE aura_daily_news (
  owner_id TEXT NOT NULL,
  news_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing','sending','sent','failed','unknown')),
  parts_json TEXT CHECK (parts_json IS NULL OR json_valid(parts_json)),
  total_parts INTEGER NOT NULL DEFAULT 0 CHECK (total_parts >= 0),
  sent_parts INTEGER NOT NULL DEFAULT 0 CHECK (sent_parts >= 0 AND sent_parts <= total_parts),
  last_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, news_date)
);
