-- Additive. Telegram may redeliver a webhook update; this records each processed update_id
-- once so a redelivery is skipped. Only the authorised owner's private messages are recorded.
-- No message text, chat or user identifiers are stored. Rows older than 7 days are pruned.
CREATE TABLE aura_telegram_updates (
  update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
  received_at INTEGER NOT NULL
);
