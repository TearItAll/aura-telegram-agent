-- Isolated review only; NOT applied to production.
-- This ledger is separate from the task.plan.create table and its type constraint.
CREATE TABLE aura_task_plan_revisions (
  action_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type = 'task.plan.revise'),
  target_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','cancelled','expired')),
  completed_at REAL
);
CREATE INDEX aura_task_plan_revisions_expiry ON aura_task_plan_revisions(expires_at);
CREATE TRIGGER aura_task_plan_revisions_immutable
BEFORE UPDATE OF action_id, owner_id, action_type, target_id,
  payload_json, payload_hash, created_at, expires_at
ON aura_task_plan_revisions
BEGIN
  SELECT RAISE(ABORT, 'AURA_REVISION_IMMUTABLE');
END;
