-- Schema-only snapshot observed read-only in the Cloudflare dashboard on 2026-10-25.
-- No account/resource IDs, credentials or task rows are included.
-- Use this only to reproduce the current structure in an EMPTY isolated database.
-- This is NOT a production migration. No UNIQUE(task_id, step_order) exists here.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high')),
  due_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reminded_due_at TEXT,
  reminded_at TEXT,
  reminder_claimed_due_at TEXT,
  reminder_claimed_at TEXT
);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  step_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'done')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_steps_task ON task_steps(task_id, step_order);
CREATE INDEX idx_tasks_chat ON tasks(chat_id, status, due_at);
CREATE INDEX idx_tasks_due_status ON tasks(status, due_at);
