-- Review on an isolated database first. This has NOT been applied to production.
-- Existing tasks/task_steps schema must be inspected before deployment.
-- No existing task table, row, index or constraint is changed here.
CREATE TABLE aura_task_plan_actions (
  action_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type = 'task.plan.create'),
  target_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'cancelled', 'expired')),
  completed_at REAL
);

CREATE INDEX aura_task_plan_actions_expiry ON aura_task_plan_actions(expires_at);

-- A preview is immutable; only lifecycle status and completion time may change.
CREATE TRIGGER aura_task_plan_actions_immutable
BEFORE UPDATE OF action_id, owner_id, action_type, target_id,
  payload_json, payload_hash, created_at, expires_at
ON aura_task_plan_actions
BEGIN
  SELECT RAISE(ABORT, 'AURA_ACTION_IMMUTABLE');
END;
