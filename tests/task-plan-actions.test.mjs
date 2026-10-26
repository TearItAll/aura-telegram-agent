import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionError, createTaskPlanAction, confirmTaskPlanAction,
  cancelTaskPlanAction, pruneTaskPlanActions
} from '../src/task-plan-actions.js';
import { createDatabase } from './helpers/sqlite-d1.mjs';

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => { throw new Error('Network disabled in action tests'); }; });
afterEach(() => { globalThis.fetch = originalFetch; });

async function fixture(t, options) {
  const db = await createDatabase(options);
  t.after(() => db.close());
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)')
    .run('parent-a', 'owner-a', 'Synthetic goal');
  const parent = () => db.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get('parent-a');
  const create = steps => createTaskPlanAction(db, 'owner-a', parent(), steps ?? ['Synthetic first', 'Synthetic second']);
  const count = () => db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n;
  const state = id => db.sqlite.prepare('SELECT status FROM aura_task_plan_actions WHERE action_id = ?').get(id)?.status;
  return { db, parent, create, count, state };
}

function alterImmutable(db, sql, ...values) {
  // Simulate storage corruption / privileged changes; normal app SQL cannot do this.
  db.sqlite.exec('DROP TRIGGER aura_task_plan_actions_immutable');
  db.sqlite.prepare(sql).run(...values);
}

test('preview stores an immutable owner-bound action and does not create steps', async t => {
  const f = await fixture(t);
  const action = await f.create();
  assert.equal(f.count(), 0);
  assert.equal(f.state(action.actionId), 'pending');
  const row = f.db.sqlite.prepare('SELECT * FROM aura_task_plan_actions').get();
  assert.equal(row.owner_id, 'owner-a');
  assert.equal(row.action_type, 'task.plan.create');
  assert.equal(row.expires_at - row.created_at, 600000);
  assert.match(row.payload_hash, /^[0-9a-f]{64}$/);
  assert.throws(() => f.db.sqlite.prepare('UPDATE aura_task_plan_actions SET payload_json = ?').run('{}'), /IMMUTABLE/);
});

test('confirmation atomically writes steps and saves a replay receipt', async t => {
  const f = await fixture(t);
  const action = await f.create();
  const first = await confirmTaskPlanAction(f.db, 'owner-a', action.actionId);
  const repeat = await confirmTaskPlanAction(f.db, 'owner-a', action.actionId);
  assert.equal(first.alreadyApplied, false);
  assert.equal(repeat.alreadyApplied, true);
  assert.equal(f.count(), 2);
  assert.equal(f.state(action.actionId), 'succeeded');
  assert.deepEqual(first.steps, repeat.steps);
});

test('two concurrent confirmations of one action only write one plan', async t => {
  const f = await fixture(t, { uniqueSteps: false });
  const action = await f.create();
  const receipts = await Promise.all([
    confirmTaskPlanAction(f.db, 'owner-a', action.actionId),
    confirmTaskPlanAction(f.db, 'owner-a', action.actionId)
  ]);
  assert.equal(f.count(), 2);
  assert.equal(receipts.filter(result => !result.alreadyApplied).length, 1);
  assert.equal(f.state(action.actionId), 'succeeded');
});

test('confirming preview A after preview B still saves A only', async t => {
  const f = await fixture(t);
  const a = await f.create(['Synthetic A']);
  const b = await f.create(['Synthetic B']);
  await confirmTaskPlanAction(f.db, 'owner-a', a.actionId);
  assert.equal(f.db.sqlite.prepare('SELECT title FROM task_steps').get().title, 'Synthetic A');
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', b.actionId), ActionError);
  assert.equal(f.count(), 1);
});

test('competing actions for the same parent cannot both create a plan', async t => {
  const f = await fixture(t, { uniqueSteps: false });
  const a = await f.create(['Synthetic A']);
  const b = await f.create(['Synthetic B']);
  const results = await Promise.allSettled([
    confirmTaskPlanAction(f.db, 'owner-a', a.actionId),
    confirmTaskPlanAction(f.db, 'owner-a', b.actionId)
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.count(), 1);
});

test('another owner cannot read, confirm or cancel an action', async t => {
  const f = await fixture(t);
  const action = await f.create();
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-b', action.actionId), /屬於你/);
  await assert.rejects(cancelTaskPlanAction(f.db, 'owner-b', action.actionId), /屬於你/);
  await assert.rejects(createTaskPlanAction(f.db, 'owner-b', f.parent(), ['Synthetic']), ActionError);
  assert.equal(f.count(), 0);
});

test('missing, malformed and unknown action IDs never execute', async t => {
  const f = await fixture(t);
  for (const id of [undefined, '', 'invalid', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']) {
    await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', id), ActionError);
  }
  assert.equal(f.count(), 0);
});

test('cancellation is action-specific, repeatable and prevents later confirmation', async t => {
  const f = await fixture(t);
  const a = await f.create();
  const b = await f.create();
  assert.equal((await cancelTaskPlanAction(f.db, 'owner-a', a.actionId)).status, 'cancelled');
  assert.equal((await cancelTaskPlanAction(f.db, 'owner-a', a.actionId)).status, 'cancelled');
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', a.actionId), /取消/);
  assert.equal(f.state(b.actionId), 'pending');
  assert.equal(f.count(), 0);
});

test('cancelling a succeeded action does not claim it undid the plan', async t => {
  const f = await fixture(t);
  const action = await f.create();
  await confirmTaskPlanAction(f.db, 'owner-a', action.actionId);
  assert.equal((await cancelTaskPlanAction(f.db, 'owner-a', action.actionId)).status, 'succeeded');
  assert.equal(f.count(), 2);
});

test('expired and future-dated previews are rejected', async t => {
  for (const offset of [-600001, 60000]) {
    await t.test(String(offset), async t => {
      const f = await fixture(t);
      const action = await f.create();
      const createdAt = Date.now() + offset;
      alterImmutable(f.db, 'UPDATE aura_task_plan_actions SET created_at = ?, expires_at = ? WHERE action_id = ?',
        createdAt, createdAt + 600000, action.actionId);
      await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
      assert.equal(f.count(), 0);
    });
  }
});

test('expired pending cancellation reports expired and never writes steps', async t => {
  const f = await fixture(t, { dbClock: () => Date.now() });
  const action = await f.create();
  const past = Date.now() - 600001;
  alterImmutable(f.db, 'UPDATE aura_task_plan_actions SET created_at = ?, expires_at = ? WHERE action_id = ?', past, past + 600000, action.actionId);
  assert.equal((await cancelTaskPlanAction(f.db, 'owner-a', action.actionId)).status, 'expired');
  assert.equal(f.count(), 0);
});

test('payload tampering is caught before any step is created', async t => {
  const f = await fixture(t);
  const action = await f.create();
  alterImmutable(f.db, 'UPDATE aura_task_plan_actions SET payload_json = ? WHERE action_id = ?', '{}', action.actionId);
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
  assert.equal(f.count(), 0);
});

test('parent changes while AI generates a plan reject preview creation', async t => {
  const f = await fixture(t);
  const oldParent = f.parent();
  f.db.sqlite.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Changed goal', 'parent-a');
  await assert.rejects(createTaskPlanAction(f.db, 'owner-a', oldParent, ['Synthetic']), ActionError);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM aura_task_plan_actions').get().n, 0);
});

test('changed parent or completed parent invalidates confirmation', async t => {
  for (const sql of ["UPDATE tasks SET title = 'Changed'", "UPDATE tasks SET status = 'done'", "UPDATE tasks SET priority = 'high'", "UPDATE tasks SET due_at = '2099-01-01'", "UPDATE tasks SET updated_at = 'changed-version'", "UPDATE tasks SET chat_id = 'owner-b'"]) {
    await t.test(sql, async t => {
      const f = await fixture(t);
      const action = await f.create();
      f.db.sqlite.exec(sql);
      await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
      assert.equal(f.count(), 0);
      assert.equal(f.state(action.actionId), 'pending');
    });
  }
});

test('existing steps invalidate confirmation even without a unique index', async t => {
  const f = await fixture(t, { uniqueSteps: false });
  const action = await f.create();
  f.db.sqlite.exec("INSERT INTO task_steps(id,task_id,title,step_order) VALUES ('existing','parent-a','Existing',1)");
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
  assert.equal(f.count(), 1);
});

test('transaction guard catches parent changes after the initial action read', async t => {
  const f = await fixture(t);
  const action = await f.create();
  f.db.beforeBatch = () => f.db.sqlite.exec("UPDATE tasks SET status = 'done'");
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
  assert.equal(f.count(), 0);
});

test('transaction guard catches cancellation after the initial action read', async t => {
  const f = await fixture(t);
  const action = await f.create();
  f.db.beforeBatch = () => f.db.sqlite.exec("UPDATE aura_task_plan_actions SET status = 'cancelled'");
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
  assert.equal(f.count(), 0);
});

test('transaction checks expiry at execution time, not just at initial read', async t => {
  const f = await fixture(t, { dbClock: () => Date.now() });
  const action = await f.create();
  f.db.beforeBatch = () => {
    const past = Date.now() - 600001;
    alterImmutable(f.db, 'UPDATE aura_task_plan_actions SET created_at = ?, expires_at = ?', past, past + 600000);
  };
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
  assert.equal(f.count(), 0);
});

test('an INSERT failure rolls back earlier steps and leaves authorization pending', async t => {
  const f = await fixture(t);
  const action = await f.create();
  f.db.sqlite.exec("CREATE TRIGGER reject_second_step BEFORE INSERT ON task_steps WHEN NEW.step_order = 2 BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_FAILURE'); END;");
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
  assert.equal(f.count(), 0);
  assert.equal(f.state(action.actionId), 'pending');
  f.db.sqlite.exec('DROP TRIGGER reject_second_step');
  await confirmTaskPlanAction(f.db, 'owner-a', action.actionId);
  assert.equal(f.count(), 2);
});

test('a lost batch response is reconciled by the saved receipt', async t => {
  const f = await fixture(t);
  const action = await f.create();
  const batch = f.db.batch.bind(f.db);
  f.db.batch = async statements => { await batch(statements); throw new Error('Synthetic lost response'); };
  const result = await confirmTaskPlanAction(f.db, 'owner-a', action.actionId);
  assert.equal(result.alreadyApplied, true);
  assert.equal(f.count(), 2);
});

test('receipt UPDATE failure also rolls back every inserted step', async t => {
  const f = await fixture(t);
  const action = await f.create();
  f.db.sqlite.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE OF status ON aura_task_plan_actions WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_RECEIPT_FAILURE'); END;");
  await assert.rejects(confirmTaskPlanAction(f.db, 'owner-a', action.actionId), ActionError);
  assert.equal(f.count(), 0);
  assert.equal(f.state(action.actionId), 'pending');
});

test('invalid steps and non-active parents do not create action records', async t => {
  const f = await fixture(t);
  for (const steps of [[], [''], [null], ['x'.repeat(151)], Array(11).fill('Synthetic')]) {
    await assert.rejects(f.create(steps), ActionError);
  }
  f.db.sqlite.exec("UPDATE tasks SET status = 'done'");
  await assert.rejects(f.create(), ActionError);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM aura_task_plan_actions').get().n, 0);
});

test('cleanup removes old receipts but preserves current previews', async t => {
  const f = await fixture(t);
  const old = await f.create();
  const fresh = await f.create();
  const past = Date.now() - 25 * 60 * 60 * 1000 - 600000;
  alterImmutable(f.db, 'UPDATE aura_task_plan_actions SET created_at = ?, expires_at = ? WHERE action_id = ?', past, past + 600000, old.actionId);
  await pruneTaskPlanActions(f.db);
  assert.equal(f.state(old.actionId), undefined);
  assert.equal(f.state(fresh.actionId), 'pending');
});
