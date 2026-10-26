-- LOCAL EMPTY DATABASE EXAMPLE ONLY.
-- Inferred from worker.js SQL; the production DDL was not provided or inspected.
-- Do not apply to production. Compare sqlite_master, indexes and constraints first.
PRAGMA foreign_keys = ON;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high')),
  due_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  reminded_due_at TEXT,
  reminded_at TEXT,
  reminder_claimed_due_at TEXT,
  reminder_claimed_at TEXT
);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  title TEXT NOT NULL,
  step_order INTEGER NOT NULL CHECK (step_order > 0),
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'done')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_id, step_order)
);

CREATE INDEX tasks_chat_created ON tasks(chat_id, created_at);
CREATE INDEX tasks_status_due ON tasks(status, due_at);
