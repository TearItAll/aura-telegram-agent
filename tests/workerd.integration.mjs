import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';

const require = createRequire(import.meta.url);
const runtime = require('workerd');
// Pin the stable Miniflare 4 API and the observed production-compatible engine.
process.env.MINIFLARE_WORKERD_PATH = runtime.default;
const bundleMode = process.env.AURA_TEST_BUNDLE === '1';
const moduleNames = ['tests/fixtures/runtime-harness.mjs', bundleMode ? 'dist/worker.js' : 'worker.js', 'src/task-plan-actions.js', 'src/task-plan-revisions.js', 'src/daily-news.js', 'src/news-ai.js'];
const modules = await Promise.all(moduleNames.map(async name => ({
  type: 'ESModule', path: fileURLToPath(new URL('../' + name, import.meta.url)),
  contents: (await readFile(new URL('../' + name, import.meta.url), 'utf8'))
    .replace(bundleMode && name.endsWith('runtime-harness.mjs') ? '../../worker.js' : '\u0000', '../../dist/worker.js')
})));
const outbound = [];
const messages = [];
const analysisPrompts = [];
let messageWaiter;
const fixture = name => 'synthetic-' + name;
const mf = new Miniflare({
  modules,
  modulesRoot: fileURLToPath(new URL('../', import.meta.url)),
  compatibilityDate: '2026-10-19',
  host: '127.0.0.1',
  port: 0,
  cf: false,
  log: new Log(LogLevel.ERROR),
  d1Databases: { AURA_TASKS_DB: 'local-aura-validation' },
  kvNamespaces: ['AURA_AUTH_STORE', 'AURA_MEMORY_STORE'],
  bindings: {
    WEBHOOK_SECRET: fixture('webhook'), TELEGRAM_BOT_TOKEN: fixture('bot'),
    ALLOWED_USER_ID: String(100), GEMINI_API_KEY: fixture('gemini')
  },
  outboundService: async request => {
    const url = new URL(request.url);
    outbound.push(url.hostname);
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const body = await request.json();
      const prompt = body.contents?.[0]?.parts?.[0]?.text || '';
      if (prompt.includes('你是 AURA 的任務計畫修訂顧問')) {
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          summary: 'Synthetic revision', renames: [{ step_order: 1, new_title: 'Synthetic revised first' }], additions: ['Synthetic appended revision']
        }) }] } }] });
      }
      if (prompt.includes('steps_truncated')) {
        analysisPrompts.push(prompt);
        return Response.json({ candidates: [{ content: { parts: [{ text: 'Synthetic readonly analysis' }] } }] });
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ steps: ['Synthetic first', 'Synthetic second'] }) }] } }] });
    }
    if (url.hostname === 'api.telegram.org') {
      const body = await request.json();
      messages.push(body.text);
      if (messageWaiter) { messageWaiter(body.text); messageWaiter = undefined; }
      return Response.json({ ok: true });
    }
    throw new Error('Unexpected outbound destination blocked by runtime test');
  }
});

// Split only these fixed, reviewed schema fixtures. Keep a trigger BEGIN...END intact.
function schemaStatements(text) {
  return text.replace(/--[^\n]*/g, '').split(/;(?=\s*(?:CREATE|PRAGMA|$))/i).map(sql => sql.trim()).filter(Boolean);
}
let passed = 0;
async function scenario(name, run) {
  await run();
  passed++;
  console.log('PASS', name);
}

try {
  await mf.ready;
  const db = await mf.getD1Database('AURA_TASKS_DB');
  const observed = await readFile(new URL('../examples/schema.observed.sql', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../migrations/0001_task_plan_actions.sql', import.meta.url), 'utf8');
  const revisionMigration = await readFile(new URL('../migrations/0002_task_plan_revisions.sql', import.meta.url), 'utf8');
  const statusMigration = await readFile(new URL('../migrations/0003_task_plan_status_final.sql', import.meta.url), 'utf8');
  const updateMigration = await readFile(new URL('../migrations/0006_telegram_updates.sql', import.meta.url), 'utf8');
  for (const sql of [...schemaStatements(observed), ...schemaStatements(migration), ...schemaStatements(revisionMigration), ...schemaStatements(statusMigration), ...schemaStatements(updateMigration)]) await db.prepare(sql).run();

  async function seed(id, title = 'Synthetic goal ' + id) {
    await db.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').bind(id, String(100), title).run();
  }
  async function action(operation, extra) {
    const response = await mf.dispatchFetch('https://aura.invalid/__test/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: String(100), operation, ...extra })
    });
    return response.json();
  }
  const preview = (taskId, steps = ['Synthetic first', 'Synthetic second']) => action('preview', { taskId, steps });
  const confirm = actionId => action('confirm', { actionId });
  const count = async taskId => (await db.prepare('SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ?').bind(taskId).first()).n;
  let nextUpdateId = 1;
  async function deliver(text, updateId = nextUpdateId++) {
    const response = await mf.dispatchFetch('https://aura.invalid/telegram', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': fixture('webhook') },
      body: JSON.stringify({ update_id: updateId, message: { from: { id: 100 }, chat: { id: 100, type: 'private' }, text } })
    });
    assert.equal(response.status, 200);
  }
  async function send(text, updateId) {
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { messageWaiter = undefined; reject(new Error('No Telegram mock reply')); }, 10000);
      messageWaiter = value => { clearTimeout(timer); resolve(value); };
    });
    await deliver(text, updateId);
    return reply;
  }

  await scenario('health and webhook authentication in workerd', async () => {
    const health = await mf.dispatchFetch('https://aura.invalid/');
    assert.equal(await health.text(), 'AURA is online!');
    const denied = await mf.dispatchFetch('https://aura.invalid/telegram', { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal(outbound.length, 0);
  });

  await scenario('observed schema has no unique task/step-order index', async () => {
    const indexes = await db.prepare("PRAGMA index_list('task_steps')").all();
    assert.equal(indexes.results.filter(index => index.unique === 1).length, 1); // primary key only
    const columns = await db.prepare("PRAGMA table_info('tasks')").all();
    assert.ok(columns.results.some(column => column.name === 'description'));
  });

  await scenario('readonly step analysis uses owner-scoped ranked SQL in workerd', async () => {
    await seed('runtime-analysis');
    await db.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)')
      .bind('runtime-other-owner', '200', 'Synthetic other owner').run();
    for (const [id, title] of [['runtime-analysis', 'Synthetic own analysis step'], ['runtime-other-owner', 'Synthetic excluded step']]) {
      await db.prepare('INSERT INTO task_steps(id,task_id,title,step_order,notes) VALUES (?,?,?,?,?)')
        .bind(id + '-step', id, title, 1, 'Synthetic excluded note').run();
    }
    const reply = await send('請分析計畫的步驟是否清楚，只給建議');
    assert.ok(reply.includes('Synthetic readonly analysis'));
    assert.equal(analysisPrompts.length, 1);
    const context = JSON.parse(analysisPrompts[0].split('\n').at(-1));
    assert.ok(context.some(task => task.steps.some(step => step.title === 'Synthetic own analysis step')));
    assert.ok(!analysisPrompts[0].includes('Synthetic excluded step'));
    assert.ok(!analysisPrompts[0].includes('Synthetic excluded note'));
    assert.equal(await count('runtime-analysis'), 1);
  });

  await scenario('D1 JSON guard functions and millisecond clock', async () => {
    const result = await db.prepare("SELECT json_valid('{}') AS valid, ((julianday('now') - 2440587.5) * 86400000) AS now_ms").first();
    assert.equal(result.valid, 1);
    assert.ok(Math.abs(result.now_ms - Date.now()) < 10000);
  });

  await scenario('preview is immutable and creates no task steps', async () => {
    await seed('runtime-preview');
    const a = await preview('runtime-preview');
    assert.equal(a.ok, true);
    assert.equal(await count('runtime-preview'), 0);
    await assert.rejects(db.prepare('UPDATE aura_task_plan_actions SET payload_json = ? WHERE action_id = ?').bind('{}', a.result.actionId).run(), /IMMUTABLE/);
  });

  await scenario('confirmation and replay consume one authorization', async () => {
    await seed('runtime-repeat');
    const a = await preview('runtime-repeat');
    assert.equal((await confirm(a.result.actionId)).result.alreadyApplied, false);
    assert.equal((await confirm(a.result.actionId)).result.alreadyApplied, true);
    assert.equal(await count('runtime-repeat'), 2);
  });

  await scenario('four concurrent workerd requests save one plan', async () => {
    await seed('runtime-concurrent');
    const a = await preview('runtime-concurrent');
    const results = await Promise.all(Array.from({ length: 4 }, () => confirm(a.result.actionId)));
    assert.ok(results.every(result => result.ok));
    assert.equal(results.filter(result => !result.result.alreadyApplied).length, 1);
    assert.equal(await count('runtime-concurrent'), 2);
  });

  await scenario('confirming A after B still applies A only', async () => {
    await seed('runtime-specific');
    const a = await preview('runtime-specific', ['Synthetic A']);
    const b = await preview('runtime-specific', ['Synthetic B']);
    assert.equal((await confirm(a.result.actionId)).ok, true);
    assert.equal((await confirm(b.result.actionId)).ok, false);
    assert.equal((await db.prepare('SELECT title FROM task_steps WHERE task_id = ?').bind('runtime-specific').first()).title, 'Synthetic A');
  });

  await scenario('two competing actions cannot both populate a parent', async () => {
    await seed('runtime-competing');
    const a = await preview('runtime-competing', ['Synthetic A']);
    const b = await preview('runtime-competing', ['Synthetic B']);
    const results = await Promise.all([confirm(a.result.actionId), confirm(b.result.actionId)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(await count('runtime-competing'), 1);
  });

  await scenario('another owner cannot confirm or cancel', async () => {
    await seed('runtime-owner');
    const a = await preview('runtime-owner');
    for (const operation of ['confirm', 'cancel']) {
      assert.equal((await action(operation, { owner: 'other-owner', actionId: a.result.actionId })).ok, false);
    }
    assert.equal(await count('runtime-owner'), 0);
  });

  await scenario('cancellation prevents matching confirmation', async () => {
    await seed('runtime-cancel');
    const a = await preview('runtime-cancel');
    assert.equal((await action('cancel', { actionId: a.result.actionId })).result.status, 'cancelled');
    assert.equal((await confirm(a.result.actionId)).ok, false);
    assert.equal(await count('runtime-cancel'), 0);
  });

  await scenario('a cancelled action cannot be re-armed to pending in D1', async () => {
    await seed('runtime-rearm');
    const a = await preview('runtime-rearm');
    assert.equal((await action('cancel', { actionId: a.result.actionId })).result.status, 'cancelled');
    await assert.rejects(db.prepare("UPDATE aura_task_plan_actions SET status = 'pending' WHERE action_id = ?")
      .bind(a.result.actionId).run(), /AURA_ACTION_FINAL/);
    assert.equal((await db.prepare('SELECT status FROM aura_task_plan_actions WHERE action_id = ?').bind(a.result.actionId).first()).status, 'cancelled');
    assert.equal((await confirm(a.result.actionId)).ok, false);
    assert.equal(await count('runtime-rearm'), 0);
  });

  await scenario('changed parent is rejected without partial writes', async () => {
    await seed('runtime-stale');
    const a = await preview('runtime-stale');
    await db.prepare('UPDATE tasks SET title = ? WHERE id = ?').bind('Changed synthetic title', 'runtime-stale').run();
    assert.equal((await confirm(a.result.actionId)).ok, false);
    assert.equal(await count('runtime-stale'), 0);
  });

  await scenario('D1 batch rolls back an earlier INSERT when the second fails', async () => {
    await seed('runtime-rollback');
    const a = await preview('runtime-rollback');
    await db.prepare("CREATE TRIGGER runtime_reject_second BEFORE INSERT ON task_steps WHEN NEW.task_id = 'runtime-rollback' AND NEW.step_order = 2 BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_INSERT_FAILURE'); END").run();
    assert.equal((await confirm(a.result.actionId)).ok, false);
    assert.equal(await count('runtime-rollback'), 0);
    assert.equal((await db.prepare('SELECT status FROM aura_task_plan_actions WHERE action_id = ?').bind(a.result.actionId).first()).status, 'pending');
  });

  await scenario('D1 batch rolls back all steps when receipt UPDATE fails', async () => {
    await seed('runtime-receipt');
    const a = await preview('runtime-receipt');
    await db.prepare("CREATE TRIGGER runtime_reject_receipt BEFORE UPDATE OF status ON aura_task_plan_actions WHEN OLD.target_id = 'runtime-receipt' AND NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_RECEIPT_FAILURE'); END").run();
    assert.equal((await confirm(a.result.actionId)).ok, false);
    assert.equal(await count('runtime-receipt'), 0);
  });

  await scenario('actual Telegram route previews, confirms and rejects duplicates', async () => {
    await seed('runtime-telegram', 'Synthetic full route');
    const message = await send('規劃任務：Synthetic full route');
    const id = message.match(/確認計畫 ([0-9a-f-]{36})/)?.[1];
    assert.ok(id);
    assert.equal(await count('runtime-telegram'), 0);
    assert.ok((await send('確認計畫 ' + id)).includes('已成功儲存'));
    assert.ok((await send('確認計畫 ' + id)).includes('沒有重複新增'));
    assert.equal(await count('runtime-telegram'), 2);
    assert.ok((await send('確認計畫')).includes('計畫ID'));
  });

  async function seedRevision(id) {
    await seed(id, 'Synthetic ' + id);
    for (const [n, status] of [[1, 'todo'], [2, 'in_progress'], [3, 'done']]) {
      await db.prepare('INSERT INTO task_steps(id,task_id,title,step_order,status,notes) VALUES (?,?,?,?,?,?)')
        .bind(id + '-' + n, id, 'Synthetic existing ' + n, n, status, 'Synthetic retained notes').run();
    }
  }
  async function revision(operation, extra) {
    return (await mf.dispatchFetch('https://aura.invalid/__test/revision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: '100', operation, ...extra })
    })).json();
  }
  const proposal = { summary: 'Synthetic reason', renames: [{ stepOrder: 1, newTitle: 'Synthetic revised first' }], additions: ['Synthetic appended revision'] };

  await scenario('actual Telegram revision previews, confirms, replays and preserves active or done steps', async () => {
    await seedRevision('runtime-revision-telegram');
    const preview = await send('AI 修改計畫：Synthetic runtime-revision-telegram');
    const id = preview.match(/確認修改計畫 ([0-9a-f-]{36})/)?.[1];
    assert.ok(id);
    assert.equal(await count('runtime-revision-telegram'), 3);
    assert.ok((await send('確認修改計畫')).includes('修改ID'));
    assert.ok((await send('確認修改計畫 ' + id)).includes('已成功修改'));
    assert.ok((await send('確認修改計畫 ' + id)).includes('沒有重複'));
    const rows = (await db.prepare('SELECT title,status,notes FROM task_steps WHERE task_id = ? ORDER BY step_order')
      .bind('runtime-revision-telegram').all()).results;
    assert.equal(rows.length, 4);
    assert.equal(rows[0].title, 'Synthetic revised first');
    assert.equal(rows[0].notes, 'Synthetic retained notes');
    assert.equal(rows[1].status, 'in_progress');
    assert.equal(rows[2].status, 'done');
  });

  await scenario('four concurrent revision confirmations produce one stored result', async () => {
    await seedRevision('runtime-revision-concurrent');
    const a = await revision('preview', { taskId: 'runtime-revision-concurrent', proposal });
    assert.equal(a.ok, true);
    const results = await Promise.all(Array.from({ length: 4 }, () => revision('confirm', { actionId: a.result.actionId })));
    assert.ok(results.every(x => x.ok));
    assert.equal(results.filter(x => !x.result.alreadyApplied).length, 1);
    assert.equal(await count('runtime-revision-concurrent'), 4);
  });

  await scenario('revision cancellation and competing snapshots reject stale execution', async () => {
    await seedRevision('runtime-revision-specific');
    const a = await revision('preview', { taskId: 'runtime-revision-specific', proposal });
    const b = await revision('preview', { taskId: 'runtime-revision-specific', proposal: { summary: '', renames: [], additions: ['Synthetic B'] } });
    assert.equal((await revision('confirm', { actionId: a.result.actionId, owner: 'other-owner' })).ok, false);
    assert.equal((await revision('confirm', { actionId: a.result.actionId })).ok, true);
    assert.equal((await revision('confirm', { actionId: b.result.actionId })).ok, false);
    assert.equal((await revision('cancel', { actionId: b.result.actionId })).result.status, 'cancelled');
    assert.equal((await revision('confirm', { actionId: b.result.actionId })).ok, false);
    assert.equal(await count('runtime-revision-specific'), 4);
  });

  await scenario('revision INSERT failure rolls back an earlier rename in D1 batch', async () => {
    await seedRevision('runtime-revision-rollback');
    const a = await revision('preview', { taskId: 'runtime-revision-rollback', proposal });
    await db.prepare("CREATE TRIGGER runtime_revision_insert_fail BEFORE INSERT ON task_steps WHEN NEW.task_id='runtime-revision-rollback' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REVISION_FAIL'); END").run();
    assert.equal((await revision('confirm', { actionId: a.result.actionId })).ok, false);
    assert.equal(await count('runtime-revision-rollback'), 3);
    assert.equal((await db.prepare('SELECT title FROM task_steps WHERE task_id=? AND step_order=1').bind('runtime-revision-rollback').first()).title, 'Synthetic existing 1');
  });

  await scenario('revision receipt failure rolls back every step change in D1 batch', async () => {
    await seedRevision('runtime-revision-receipt');
    const a = await revision('preview', { taskId: 'runtime-revision-receipt', proposal });
    await db.prepare("CREATE TRIGGER runtime_revision_receipt_fail BEFORE UPDATE OF status ON aura_task_plan_revisions WHEN OLD.target_id='runtime-revision-receipt' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_REVISION_RECEIPT_FAIL'); END").run();
    assert.equal((await revision('confirm', { actionId: a.result.actionId })).ok, false);
    assert.equal(await count('runtime-revision-receipt'), 3);
    assert.equal((await db.prepare('SELECT title FROM task_steps WHERE task_id=? AND step_order=1').bind('runtime-revision-receipt').first()).title, 'Synthetic existing 1');
  });

  await scenario('a redelivered Telegram update_id is processed once in D1', async () => {
    const before = messages.length;
    const greeting = await send('/start', 777001);
    assert.match(greeting, /AURA/);
    // Redeliver the same update, then a new one. Without dedupe the redelivery's greeting
    // needs no I/O and arrives before the D1-backed task list reply.
    await deliver('/start', 777001);
    await send('任務清單', 777002);
    assert.equal(messages.slice(before).filter(text => text === greeting).length, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM aura_telegram_updates WHERE update_id IN (777001, 777002)').first()).n, 2);
  });

  await scenario('all external fetches stay within local Gemini/Telegram mocks', async () => {
    assert.ok(outbound.length > 0);
    assert.ok(outbound.every(host => ['generativelanguage.googleapis.com', 'api.telegram.org'].includes(host)));
  });
  console.log(JSON.stringify({ runtime_scenarios_passed: passed, runtime: runtime.version, mode: bundleMode ? 'bundle' : 'modules',
    compatibility_date: '2026-10-19', real_external_requests: 0, schema: 'observed-structure-only', production_modified: false }));
} finally {
  await mf.dispose();
}
