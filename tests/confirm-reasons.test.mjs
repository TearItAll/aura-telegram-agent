import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActionError, createTaskPlanAction, confirmTaskPlanAction } from '../src/task-plan-actions.js';
import { createTaskPlanRevision, confirmTaskPlanRevision } from '../src/task-plan-revisions.js';
import { createDatabase } from './helpers/sqlite-d1.mjs';

// R1 / review F3: a rejected confirmation must say why (expired, data changed, no longer
// pending, or unknown) with a code that carries no payload, owner, task or action identifier.
const savedFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => { throw new Error('External requests blocked'); }; });
afterEach(() => { globalThis.fetch = savedFetch; });

// Expiry is set 1 ms before Date.now(); SQLite 'now' can lag Date.now() by 1–2 ms on Windows,
// so these tests read the database clock from the same source instead of widening the margin.
const PINNED_CLOCK = { dbClock: () => Date.now() };
const CODES = ['expired', 'data_changed', 'not_pending', 'unknown'];

async function rejection(promise, code, pattern) {
  let caught;
  await assert.rejects(promise, error => { caught = error; return error instanceof ActionError; });
  assert.equal(caught.code, code);
  assert.match(caught.message, pattern);
  assert.ok(CODES.includes(caught.code));
  return caught;
}

function stripChangeCounts(db) {
  // D1 shape drift: the batch commits but meta.changes is absent.
  const batch = db.batch.bind(db);
  db.batch = async statements => (await batch(statements)).map(({ success }) => ({ success, meta: {} }));
}

async function planFixture(t, options) {
  const db = await createDatabase(options);
  t.after(() => db.close());
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('parent-a', 'owner-a', 'Synthetic goal');
  const parent = () => db.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get('parent-a');
  const action = await createTaskPlanAction(db, 'owner-a', parent(), ['Synthetic first', 'Synthetic second']);
  const confirm = () => confirmTaskPlanAction(db, 'owner-a', action.actionId);
  const steps = () => db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n;
  return { db, action, confirm, steps };
}

test('plan confirmation reports expired when the guard rejects an expired preview', async t => {
  const f = await planFixture(t, PINNED_CLOCK);
  f.db.beforeBatch = () => {
    f.db.sqlite.exec('DROP TRIGGER aura_task_plan_actions_immutable');
    const past = Date.now() - 600001;
    f.db.sqlite.prepare('UPDATE aura_task_plan_actions SET created_at = ?, expires_at = ?').run(past, past + 600000);
  };
  await rejection(f.confirm(), 'expired', /超過 10 分鐘/);
  assert.equal(f.steps(), 0);
});

test('plan confirmation reports data_changed when the parent task changed after the preview', async t => {
  const f = await planFixture(t);
  f.db.sqlite.prepare("UPDATE tasks SET title = 'Synthetic renamed goal', updated_at = '2099-01-01 00:00:00'").run();
  const error = await rejection(f.confirm(), 'data_changed', /已變更/);
  assert.equal(error.message.includes(f.action.actionId), false);
  assert.equal(f.steps(), 0);
});

test('plan confirmation reports data_changed when steps were added after the preview', async t => {
  const f = await planFixture(t);
  f.db.sqlite.prepare("INSERT INTO task_steps(id,task_id,title,step_order) VALUES ('manual','parent-a','Synthetic manual',1)").run();
  await rejection(f.confirm(), 'data_changed', /已變更/);
  assert.equal(f.steps(), 1);
});

test('plan confirmation reports not_pending when the preview is cancelled during confirmation', async t => {
  const f = await planFixture(t);
  f.db.beforeBatch = () => f.db.sqlite.prepare("UPDATE aura_task_plan_actions SET status = 'cancelled'").run();
  await rejection(f.confirm(), 'not_pending', /已取消或失效/);
  assert.equal(f.steps(), 0);
});

test('plan confirmation reports unknown for a failure the guard cannot explain, and the same ID can retry', async t => {
  const f = await planFixture(t);
  f.db.sqlite.exec("CREATE TRIGGER reject_step BEFORE INSERT ON task_steps BEGIN SELECT RAISE(ABORT, 'SYNTHETIC'); END;");
  await rejection(f.confirm(), 'unknown', /同一個「確認計畫/);
  f.db.sqlite.exec('DROP TRIGGER reject_step');
  assert.equal((await f.confirm()).alreadyApplied, false);
  assert.equal(f.steps(), 2);
});

test('a committed plan batch without change counts is a first save, not a replay', async t => {
  const f = await planFixture(t);
  stripChangeCounts(f.db);
  assert.equal((await f.confirm()).alreadyApplied, false);
  assert.equal(f.steps(), 2);
});

async function revisionFixture(t, options = {}) {
  const db = await createDatabase({ uniqueSteps: false, ...options });
  t.after(() => db.close());
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('parent', 'owner-a', 'Synthetic revision goal');
  for (const [n, status] of [[1, 'todo'], [2, 'in_progress']]) {
    db.sqlite.prepare('INSERT INTO task_steps(id,task_id,title,step_order,status) VALUES (?,?,?,?,?)')
      .run('step-' + n, 'parent', 'Synthetic step ' + n, n, status);
  }
  const parent = db.sqlite.prepare('SELECT * FROM tasks').get();
  const rows = db.sqlite.prepare('SELECT * FROM task_steps ORDER BY step_order').all();
  const preview = await createTaskPlanRevision(db, 'owner-a', parent, rows,
    { summary: 'Synthetic reason', renames: [{ stepOrder: 1, newTitle: 'Synthetic revised first' }], additions: ['Synthetic appended'] });
  const confirm = () => confirmTaskPlanRevision(db, 'owner-a', preview.actionId);
  const titles = () => db.sqlite.prepare('SELECT title FROM task_steps ORDER BY step_order').all().map(x => x.title);
  return { db, preview, confirm, titles };
}

test('revision confirmation reports expired when the guard rejects an expired preview', async t => {
  const f = await revisionFixture(t, PINNED_CLOCK);
  f.db.beforeBatch = () => {
    f.db.sqlite.exec('DROP TRIGGER aura_task_plan_revisions_immutable');
    const past = Date.now() - 600001;
    f.db.sqlite.prepare('UPDATE aura_task_plan_revisions SET created_at = ?, expires_at = ?').run(past, past + 600000);
  };
  await rejection(f.confirm(), 'expired', /超過 10 分鐘/);
  assert.deepEqual(f.titles(), ['Synthetic step 1', 'Synthetic step 2']);
});

test('revision confirmation reports data_changed when a step changed after the preview', async t => {
  const f = await revisionFixture(t);
  f.db.sqlite.prepare("UPDATE task_steps SET status = 'done', updated_at = '2099-01-01 00:00:00' WHERE id = 'step-2'").run();
  const error = await rejection(f.confirm(), 'data_changed', /已變更/);
  assert.equal(error.message.includes(f.preview.actionId), false);
  assert.deepEqual(f.titles(), ['Synthetic step 1', 'Synthetic step 2']);
});

test('revision confirmation reports not_pending when the preview is cancelled during confirmation', async t => {
  const f = await revisionFixture(t);
  f.db.beforeBatch = () => f.db.sqlite.prepare("UPDATE aura_task_plan_revisions SET status = 'cancelled'").run();
  await rejection(f.confirm(), 'not_pending', /已取消或失效/);
});

test('revision confirmation reports unknown for a failure the guard cannot explain, and the same ID can retry', async t => {
  const f = await revisionFixture(t);
  f.db.sqlite.exec("CREATE TRIGGER reject_step BEFORE INSERT ON task_steps BEGIN SELECT RAISE(ABORT, 'SYNTHETIC'); END;");
  await rejection(f.confirm(), 'unknown', /同一個「確認修改計畫/);
  f.db.sqlite.exec('DROP TRIGGER reject_step');
  assert.equal((await f.confirm()).alreadyApplied, false);
  assert.deepEqual(f.titles(), ['Synthetic revised first', 'Synthetic step 2', 'Synthetic appended']);
});

test('a committed revision batch without change counts is a first save, not a replay', async t => {
  const f = await revisionFixture(t);
  stripChangeCounts(f.db);
  assert.equal((await f.confirm()).alreadyApplied, false);
  assert.deepEqual(f.titles(), ['Synthetic revised first', 'Synthetic step 2', 'Synthetic appended']);
});
