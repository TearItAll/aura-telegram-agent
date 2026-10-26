-- Review F4 / RELEASE_PLAN R3. Isolated review first; NOT applied to production.
-- Adds triggers only: no table, column, row or existing trigger is changed.
-- A preview may leave 'pending' exactly once, to a final state. Final states
-- (succeeded, cancelled, expired) can never be re-armed or changed again.
-- Application SQL only ever updates rows WHERE status = 'pending' to a final state.
-- Limitation: this blocks re-arming an existing row; it does not stop someone with
-- direct write access from DELETE + INSERT of a forged row.
CREATE TRIGGER aura_task_plan_actions_status_final
BEFORE UPDATE OF status ON aura_task_plan_actions
WHEN OLD.status <> 'pending' OR NEW.status NOT IN ('succeeded', 'cancelled', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'AURA_ACTION_FINAL');
END;

CREATE TRIGGER aura_task_plan_revisions_status_final
BEFORE UPDATE OF status ON aura_task_plan_revisions
WHEN OLD.status <> 'pending' OR NEW.status NOT IN ('succeeded', 'cancelled', 'expired')
BEGIN
  SELECT RAISE(ABORT, 'AURA_REVISION_FINAL');
END;
