import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskPlanAction, confirmTaskPlanAction, cancelTaskPlanAction, ActionError } from '../src/task-plan-actions.js';
import { createTaskPlanRevision, confirmTaskPlanRevision, cancelTaskPlanRevision } from '../src/task-plan-revisions.js';
import { createDatabase } from './helpers/sqlite-d1.mjs';

// Review F4 / RELEASE_PLAN R3: a finished preview (succeeded, cancelled, expired) must never be
// re-armed to pending by a direct UPDATE, and pending may only move to a final state once.
async function fixture(t) {
  const db = await createDatabase({ uniqueSteps: false });
  t.after(() => db.close());
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('empty', 'owner-a', 'Synthetic create goal');
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('planned', 'owner-a', 'Synthetic revise goal');
  db.sqlite.prepare("INSERT INTO task_steps(id,task_id,title,step_order) VALUES ('s1','planned','Synthetic step',1)").run();
  const task = id => db.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const steps = () => db.sqlite.prepare("SELECT * FROM task_steps WHERE task_id = 'planned' ORDER BY step_order").all();
  const count = id => db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ?').get(id).n;
  return {
    db, count,
    create: {
      table: 'aura_task_plan_actions', target: 'empty', base: 0,
      make: () => createTaskPlanAction(db, 'owner-a', task('empty'), ['Synthetic A']),
      confirm: id => confirmTaskPlanAction(db, 'owner-a', id),
      cancel: id => cancelTaskPlanAction(db, 'owner-a', id)
    },
    revise: {
      table: 'aura_task_plan_revisions', target: 'planned', base: 1,
      make: () => createTaskPlanRevision(db, 'owner-a', task('planned'), steps(), { summary: 'Synthetic', renames: [], additions: ['Synthetic added'] }),
      confirm: id => confirmTaskPlanRevision(db, 'owner-a', id),
      cancel: id => cancelTaskPlanRevision(db, 'owner-a', id)
    }
  };
}
const setStatus = (db, table, id, status) => db.sqlite.prepare(`UPDATE ${table} SET status = ? WHERE action_id = ?`).run(status, id);
const statusOf = (db, table, id) => db.sqlite.prepare(`SELECT status FROM ${table} WHERE action_id = ?`).get(id).status;

for (const kind of ['create', 'revise']) {
  test(`${kind}: a cancelled preview cannot be re-armed and then executed`, async t => {
    const f = await fixture(t); const k = f[kind];
    const p = await k.make();
    assert.equal((await k.cancel(p.actionId)).status, 'cancelled');
    assert.throws(() => setStatus(f.db, k.table, p.actionId, 'pending'), /AURA_(ACTION|REVISION)_FINAL/);
    assert.equal(statusOf(f.db, k.table, p.actionId), 'cancelled');
    await assert.rejects(k.confirm(p.actionId), ActionError);
    assert.equal(f.count(k.target), k.base);
  });

  test(`${kind}: succeeded and expired previews are final too`, async t => {
    const f = await fixture(t); const k = f[kind];
    const done = await k.make();
    const old = await k.make();
    await k.confirm(done.actionId);
    for (const next of ['pending', 'cancelled', 'expired']) {
      assert.throws(() => setStatus(f.db, k.table, done.actionId, next), /AURA_(ACTION|REVISION)_FINAL/);
    }
    assert.equal(statusOf(f.db, k.table, done.actionId), 'succeeded');
    f.db.sqlite.exec(`DROP TRIGGER ${k.table}_immutable`);
    f.db.sqlite.prepare(`UPDATE ${k.table} SET created_at = created_at - 700000, expires_at = expires_at - 700000 WHERE action_id = ?`).run(old.actionId);
    assert.equal((await k.cancel(old.actionId)).status, 'expired');
    assert.throws(() => setStatus(f.db, k.table, old.actionId, 'pending'), /AURA_(ACTION|REVISION)_FINAL/);
  });

  test(`${kind}: pending may still move to each final state exactly once`, async t => {
    const f = await fixture(t); const k = f[kind];
    for (const final of ['succeeded', 'cancelled', 'expired']) {
      const p = await k.make();
      setStatus(f.db, k.table, p.actionId, final);
      assert.equal(statusOf(f.db, k.table, p.actionId), final);
    }
    const p = await k.make();
    assert.throws(() => setStatus(f.db, k.table, p.actionId, 'pending'), /AURA_(ACTION|REVISION)_FINAL/);
    assert.throws(() => setStatus(f.db, k.table, p.actionId, 'bogus'), /CHECK|AURA_(ACTION|REVISION)_FINAL/);
  });
}
