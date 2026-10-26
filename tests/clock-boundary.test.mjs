import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskPlanAction, confirmTaskPlanAction, cancelTaskPlanAction, ActionError } from '../src/task-plan-actions.js';
import { createTaskPlanRevision, confirmTaskPlanRevision } from '../src/task-plan-revisions.js';
import { createDatabase } from './helpers/sqlite-d1.mjs';
import { guardBreakdown } from './helpers/guard-breakdown.mjs';

const INT_DB_NOW = "CAST(((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

// Both clocks are controlled; no test depends on real wall-clock timing.
// T is an integer ms whose SQLite julianday round trip lands about 0.015 ms
// below the integer, i.e. the same-millisecond float case from the handoff.
const T = Date.UTC(2025, 9, 25, 13, 46, 40, 3);
const TTL = 600000;

async function clocks(t) {
  const clock = { js: T, db: T };
  const realNow = Date.now;
  Date.now = () => clock.js;
  t.after(() => { Date.now = realNow; });
  const db = await createDatabase({ uniqueSteps: false, dbClock: () => clock.db });
  t.after(() => db.close());
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('empty', 'owner-a', 'Synthetic create goal');
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('planned', 'owner-a', 'Synthetic revise goal');
  db.sqlite.prepare("INSERT INTO task_steps(id,task_id,title,step_order) VALUES ('s1','planned','Synthetic step',1)").run();
  const task = id => db.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const steps = () => db.sqlite.prepare("SELECT * FROM task_steps WHERE task_id = 'planned' ORDER BY step_order").all();
  const count = id => db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ?').get(id).n;
  const kinds = {
    create: {
      make: () => createTaskPlanAction(db, 'owner-a', task('empty'), ['Synthetic A', 'Synthetic B']),
      confirm: id => confirmTaskPlanAction(db, 'owner-a', id),
      table: 'aura_task_plan_actions', written: () => count('empty'), expected: 2
    },
    revise: {
      make: () => createTaskPlanRevision(db, 'owner-a', task('planned'), steps(),
        { summary: 'Synthetic', renames: [], additions: ['Synthetic appended'] }),
      confirm: id => confirmTaskPlanRevision(db, 'owner-a', id),
      table: 'aura_task_plan_revisions', written: () => count('planned') - 1, expected: 1
    }
  };
  return { db, clock, kinds };
}

function tamper(db, table, sql, ...values) {
  db.sqlite.exec(`DROP TRIGGER ${table}_immutable`);
  db.sqlite.prepare(sql).run(...values);
}

for (const kind of ['create', 'revise']) {
  test(`${kind}: confirmation in the same millisecond as the preview is accepted`, async t => {
    const { kinds } = await clocks(t);
    const k = kinds[kind];
    const preview = await k.make();
    assert.equal((await k.confirm(preview.actionId)).alreadyApplied, false);
    assert.equal(k.written(), k.expected);
  });

  test(`${kind}: diagnostic shows every time condition true at the same millisecond`, async t => {
    const { db, kinds } = await clocks(t);
    const k = kinds[kind];
    const preview = await k.make();
    // Booleans only; names the failing condition if this ever regresses.
    assert.deepEqual({ ...guardBreakdown(db, k.table, preview.actionId, INT_DB_NOW) },
      { pending: 1, not_future: 1, not_expired: 1, ttl_intact: 1 });
  });

  test(`${kind}: a database clock a few ms behind the Worker clock does not reject`, async t => {
    const { clock, kinds } = await clocks(t);
    const k = kinds[kind];
    clock.db = T - 7; // e.g. coarse OS clock / different clock source
    const preview = await k.make();
    clock.js += 1; clock.db += 1;
    assert.equal((await k.confirm(preview.actionId)).alreadyApplied, false);
    assert.equal(k.written(), k.expected);
  });

  for (const skew of [-5000, 5000]) {
    test(`${kind}: Worker/DB skew of ${skew} ms neither rejects a fresh preview nor extends expiry`, async t => {
      const { clock, kinds } = await clocks(t);
      const k = kinds[kind];
      clock.js = T + skew;
      const preview = await k.make();
      clock.js += 1000; clock.db += 1000;
      assert.equal((await k.confirm(preview.actionId)).alreadyApplied, false);
      assert.equal(k.written(), k.expected);
    });
  }

  test(`${kind}: expiry is enforced on the database clock with exact TTL`, async t => {
    const { db, clock, kinds } = await clocks(t);
    const k = kinds[kind];
    const late = await k.make();
    const row = db.sqlite.prepare(`SELECT created_at, expires_at FROM ${k.table} WHERE action_id = ?`).get(late.actionId);
    assert.equal(row.expires_at - row.created_at, TTL);
    // DB clock is quantised to integer ms; +1 ms is always past expiry, -1 ms always before.
    clock.db = row.expires_at + 1; clock.js = row.expires_at - 1000; // JS precheck passes, DB says expired
    await assert.rejects(k.confirm(late.actionId), ActionError);
    assert.equal(k.written(), 0);
    clock.db = row.expires_at - 1;
    assert.equal((await k.confirm(late.actionId)).alreadyApplied, false);
    assert.equal(k.written(), k.expected);
  });

  test(`${kind}: crossing expiry between the JS precheck and the batch is rejected`, async t => {
    const { db, clock, kinds } = await clocks(t);
    const k = kinds[kind];
    const preview = await k.make();
    db.beforeBatch = () => { clock.db = T + TTL + 1; };
    await assert.rejects(k.confirm(preview.actionId), ActionError);
    assert.equal(k.written(), 0);
    assert.equal(db.sqlite.prepare(`SELECT status FROM ${k.table}`).get().status, 'pending');
  });

  test(`${kind}: a future-dated row is still rejected inside the transaction`, async t => {
    const { db, kinds } = await clocks(t);
    const k = kinds[kind];
    const preview = await k.make();
    tamper(db, k.table, `UPDATE ${k.table} SET created_at = ?, expires_at = ?`, T + 60000, T + 60000 + TTL);
    await assert.rejects(k.confirm(preview.actionId), ActionError);
    assert.equal(k.written(), 0);
  });
}

test('create: cancel after DB-clock expiry reports expired', async t => {
  const { clock, kinds, db } = await clocks(t);
  const preview = await kinds.create.make();
  clock.db = T + TTL + 5; clock.js = T + TTL + 5;
  assert.equal((await cancelTaskPlanAction(db, 'owner-a', preview.actionId)).status, 'expired');
});
