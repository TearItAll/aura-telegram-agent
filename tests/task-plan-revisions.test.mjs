import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskPlanRevision, confirmTaskPlanRevision, cancelTaskPlanRevision } from '../src/task-plan-revisions.js';
import { createTaskPlanAction, ActionError } from '../src/task-plan-actions.js';
import { createDatabase } from './helpers/sqlite-d1.mjs';

const savedFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => { throw new Error('External requests blocked'); }; });
afterEach(() => { globalThis.fetch = savedFetch; });
async function fixture(t, options = {}) {
  const db = await createDatabase({ uniqueSteps: false, ...options });
  t.after(() => db.close());
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('parent', 'owner-a', 'Synthetic revision goal');
  for (const [n, status] of [[1, 'todo'], [2, 'in_progress'], [3, 'done']]) {
    db.sqlite.prepare('INSERT INTO task_steps(id,task_id,title,step_order,status,notes) VALUES (?,?,?,?,?,?)')
      .run('step-' + n, 'parent', 'Synthetic step ' + n, n, status, 'Synthetic retained notes');
  }
  const parent = () => db.sqlite.prepare('SELECT * FROM tasks').get();
  const rows = () => db.sqlite.prepare('SELECT * FROM task_steps ORDER BY step_order,id').all();
  const proposal = { summary: 'Synthetic reason', renames: [{ stepOrder: 1, newTitle: 'Synthetic revised first' }], additions: ['Synthetic appended step'] };
  const create = (input = proposal) => createTaskPlanRevision(db, 'owner-a', parent(), rows(), input);
  const confirm = id => confirmTaskPlanRevision(db, 'owner-a', id);
  const state = id => db.sqlite.prepare('SELECT status FROM aura_task_plan_revisions WHERE action_id = ?').get(id)?.status;
  return { db, parent, rows, proposal, create, confirm, state };
}

test('revision preview is immutable, owner bound, and does not change steps', async t => {
  const f = await fixture(t);
  const before = f.rows();
  const preview = await f.create();
  assert.deepEqual(f.rows(), before);
  assert.equal(f.state(preview.actionId), 'pending');
  const row = f.db.sqlite.prepare('SELECT * FROM aura_task_plan_revisions').get();
  assert.equal(row.action_type, 'task.plan.revise');
  assert.equal(row.owner_id, 'owner-a');
  assert.equal(row.expires_at - row.created_at, 600000);
  assert.throws(() => f.db.sqlite.prepare('UPDATE aura_task_plan_revisions SET payload_json = ?').run('{}'), /IMMUTABLE/);
});

test('revision confirmation updates only todo title, appends steps, preserves notes and states, and replays a receipt', async t => {
  const f = await fixture(t);
  const before = f.rows();
  const a = await f.create();
  assert.equal((await f.confirm(a.actionId)).alreadyApplied, false);
  const after = f.rows();
  assert.equal(after.length, 4);
  assert.equal(after[0].title, f.proposal.renames[0].newTitle);
  assert.equal(after[0].notes, before[0].notes);
  assert.deepEqual(after.slice(1, 3), before.slice(1));
  assert.equal(after[3].step_order, 4);
  assert.equal(after[3].status, 'todo');
  assert.equal((await f.confirm(a.actionId)).alreadyApplied, true);
  assert.deepEqual(f.rows(), after);
  assert.equal(f.state(a.actionId), 'succeeded');
});

test('concurrent confirmations apply one revision without relying on a step-order unique index', async t => {
  const f = await fixture(t);
  const a = await f.create();
  const receipts = await Promise.all(Array.from({ length: 4 }, () => f.confirm(a.actionId)));
  assert.equal(receipts.filter(x => !x.alreadyApplied).length, 1);
  assert.equal(f.rows().length, 4);
});

test('confirming A after B still applies A; competing B fails its old snapshot', async t => {
  const f = await fixture(t);
  const a = await f.create();
  const b = await f.create({ ...f.proposal, additions: ['Synthetic B'] });
  await f.confirm(a.actionId);
  await assert.rejects(f.confirm(b.actionId), ActionError);
  assert.equal(f.rows().at(-1).title, 'Synthetic appended step');
  assert.equal(f.state(b.actionId), 'pending');
});

test('two competing revision actions cannot both apply', async t => {
  const f = await fixture(t);
  const a = await f.create();
  const b = await f.create({ summary: '', renames: [], additions: ['Synthetic B'] });
  const results = await Promise.allSettled([f.confirm(a.actionId), f.confirm(b.actionId)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(f.rows().length, 4);
});

test('cancellation is specific and repeatable, prevents confirmation, and cannot undo success', async t => {
  const f = await fixture(t);
  const a = await f.create();
  const b = await f.create();
  for (let n = 0; n < 2; n++) assert.equal((await cancelTaskPlanRevision(f.db, 'owner-a', a.actionId)).status, 'cancelled');
  await assert.rejects(f.confirm(a.actionId), /取消/);
  await f.confirm(b.actionId);
  assert.equal((await cancelTaskPlanRevision(f.db, 'owner-a', b.actionId)).status, 'succeeded');
  assert.equal(f.rows().length, 4);
});

test('other owners and malformed IDs cannot confirm or cancel', async t => {
  const f = await fixture(t);
  const a = await f.create();
  for (const operation of [confirmTaskPlanRevision, cancelTaskPlanRevision]) {
    await assert.rejects(operation(f.db, 'owner-b', a.actionId), ActionError);
    await assert.rejects(operation(f.db, 'owner-a', 'bad-id'), ActionError);
    await assert.rejects(operation(f.db, 'owner-a', crypto.randomUUID()), ActionError);
  }
  assert.equal(f.rows().length, 3);
});

test('parent or step changes invalidate the whole revision', async t => {
  for (const sql of [
    "UPDATE tasks SET title = 'Changed'", "UPDATE tasks SET priority = 'high'",
    "UPDATE tasks SET due_at = '2099-01-01'", "UPDATE tasks SET status = 'done'",
    "UPDATE tasks SET status = 'cancelled'", "UPDATE tasks SET chat_id = 'owner-b'",
    "UPDATE tasks SET updated_at = 'changed'",
    "UPDATE task_steps SET status = 'in_progress' WHERE id = 'step-1'",
    "UPDATE task_steps SET title = 'Changed' WHERE id = 'step-2'",
    "UPDATE task_steps SET updated_at = 'changed' WHERE id = 'step-3'",
    "UPDATE task_steps SET step_order = 9 WHERE id = 'step-3'",
    "DELETE FROM task_steps WHERE id = 'step-3'",
    "INSERT INTO task_steps(id,task_id,title,step_order) VALUES ('extra','parent','Synthetic extra',4)"
  ]) await t.test(sql, async t => {
    const f = await fixture(t);
    const a = await f.create();
    f.db.sqlite.exec(sql);
    const before = f.rows();
    await assert.rejects(f.confirm(a.actionId), ActionError);
    assert.deepEqual(f.rows(), before);
    assert.equal(f.state(a.actionId), 'pending');
  });
});

test('generation-time snapshot changes prevent storing a proposal', async t => {
  const f = await fixture(t);
  const parent = f.parent(), rows = f.rows();
  f.db.sqlite.exec("UPDATE task_steps SET title = 'Changed during AI' WHERE id = 'step-1'");
  await assert.rejects(createTaskPlanRevision(f.db, 'owner-a', parent, rows, f.proposal), /沒有建立/);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM aura_task_plan_revisions').get().n, 0);
});

test('transaction guard catches a change or cancellation after the initial action read', async t => {
  for (const mutate of ['parent', 'cancel']) await t.test(mutate, async t => {
    const f = await fixture(t);
    const a = await f.create();
    f.db.beforeBatch = () => f.db.sqlite.exec(mutate === 'parent'
      ? "UPDATE tasks SET priority = 'high'"
      : "UPDATE aura_task_plan_revisions SET status = 'cancelled'");
    await assert.rejects(f.confirm(a.actionId), ActionError);
    assert.equal(f.rows().length, 3);
    assert.equal(f.rows()[0].title, 'Synthetic step 1');
  });
});

function alterImmutable(db, sql, ...values) {
  db.sqlite.exec('DROP TRIGGER aura_task_plan_revisions_immutable');
  db.sqlite.prepare(sql).run(...values);
}
test('expired and future previews cannot execute; expired cancellation reports expiry', async t => {
  for (const shift of [-600001, 60000]) await t.test(String(shift), async t => {
    const f = await fixture(t, { dbClock: () => Date.now() });
    const a = await f.create();
    const created = Date.now() + shift;
    alterImmutable(f.db, 'UPDATE aura_task_plan_revisions SET created_at = ?,expires_at = ?', created, created + 600000);
    await assert.rejects(f.confirm(a.actionId), ActionError);
    if (shift < 0) assert.equal((await cancelTaskPlanRevision(f.db, 'owner-a', a.actionId)).status, 'expired');
    assert.equal(f.rows().length, 3);
  });
});

test('SQL checks database time even if expiry happens after initial validation', async t => {
  const f = await fixture(t);
  const a = await f.create();
  f.db.beforeBatch = () => {
    const expiry = Date.now() - 1000;
    alterImmutable(f.db, 'UPDATE aura_task_plan_revisions SET created_at = ?,expires_at = ?', expiry - 600000, expiry);
  };
  await assert.rejects(f.confirm(a.actionId), ActionError);
  assert.equal(f.rows().length, 3);
});

test('payload corruption is rejected without modifying any steps', async t => {
  const f = await fixture(t);
  const a = await f.create();
  alterImmutable(f.db, 'UPDATE aura_task_plan_revisions SET payload_json = ?', '{}');
  await assert.rejects(f.confirm(a.actionId), ActionError);
  assert.equal(f.rows().length, 3);
});

test('failed INSERT rolls back earlier rename and all additions', async t => {
  const f = await fixture(t);
  const before = f.rows();
  const a = await f.create();
  f.db.sqlite.exec("CREATE TRIGGER fail_revision_insert BEFORE INSERT ON task_steps BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAIL'); END");
  await assert.rejects(f.confirm(a.actionId), ActionError);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.state(a.actionId), 'pending');
});

test('failed receipt UPDATE rolls back both rename and addition', async t => {
  const f = await fixture(t);
  const before = f.rows();
  const a = await f.create();
  f.db.sqlite.exec("CREATE TRIGGER fail_revision_receipt BEFORE UPDATE OF status ON aura_task_plan_revisions WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAIL'); END");
  await assert.rejects(f.confirm(a.actionId), ActionError);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.state(a.actionId), 'pending');
});

test('lost batch response is reconciled from persisted success without repeating writes', async t => {
  const f = await fixture(t);
  const a = await f.create();
  const batch = f.db.batch;
  f.db.batch = async statements => { await batch(statements); throw new Error('Synthetic transport failure'); };
  assert.equal((await f.confirm(a.actionId)).alreadyApplied, true);
  assert.equal((await f.confirm(a.actionId)).alreadyApplied, true);
  assert.equal(f.rows().length, 4);
});

test('invalid changes, duplicate orders, nonactive parents and oversized plans never create previews', async t => {
  const f = await fixture(t);
  for (const proposal of [
    { summary: '', renames: [], additions: [] },
    { summary: '', renames: [{ stepOrder: 2, newTitle: 'Cannot rename active step' }], additions: [] },
    { summary: '', renames: [{ stepOrder: 3, newTitle: 'Cannot rename done step' }], additions: [] },
    { summary: '', renames: [{ stepOrder: 1, newTitle: 'A' }, { stepOrder: 1, newTitle: 'B' }], additions: [] },
    { summary: '', renames: [], additions: ['a', 'b', 'c', 'd'] },
    { summary: '', renames: [], additions: ['x'.repeat(151)] }
  ]) await assert.rejects(f.create(proposal), ActionError);
  const parent = f.parent(), rows = f.rows();
  await assert.rejects(createTaskPlanRevision(f.db, 'owner-a', { ...parent, status: 'done' }, rows, f.proposal), ActionError);
  await assert.rejects(createTaskPlanRevision(f.db, 'owner-a', parent, rows.map(x => ({ ...x, step_order: 1 })), f.proposal), ActionError);
  await assert.rejects(createTaskPlanRevision(f.db, 'owner-a', parent, Array.from({ length: 11 }, (_, n) => ({ ...rows[0], id: String(n), step_order: n })), f.proposal), ActionError);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM aura_task_plan_revisions').get().n, 0);
});

test('create action IDs cannot be used to authorize revisions', async t => {
  const f = await fixture(t);
  f.db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('empty-parent', 'owner-a', 'Synthetic create goal');
  const parent = f.db.sqlite.prepare("SELECT * FROM tasks WHERE id='empty-parent'").get();
  const a = await createTaskPlanAction(f.db, 'owner-a', parent, ['Synthetic new step']);
  await assert.rejects(f.confirm(a.actionId), ActionError);
  assert.equal(f.rows().length, 3);
});
