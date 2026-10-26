import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanText } from '../scripts/security-scan.mjs';
import { createDatabase } from './helpers/sqlite-d1.mjs';

// Test-only access to private helpers, without changing the production export.
// All fetches fail closed unless a test supplies an explicit local stub.
const source = (await readFile(new URL('../worker.js', import.meta.url), 'utf8'))
  .replace('./src/task-plan-actions.js', new URL('../src/task-plan-actions.js', import.meta.url).href)
  .replace('./src/task-plan-revisions.js', new URL('../src/task-plan-revisions.js', import.meta.url).href)
  .replace('./src/daily-news.js', new URL('../src/daily-news.js', import.meta.url).href);
const exposed = [
  'encryptToken', 'decryptToken', 'extractGeminiText', 'callGeminiWithRetry',
  'createGoogleCalendarEvent', 'updateGoogleCalendarEvent', 'deleteGoogleCalendarEvent',
  'generateAuraTaskPlan', 'confirmAuraPlanRevision', 'listAuraTasks',
  'askGemini', 'prepareAuraTaskPlan', 'isFreshConfirmation', 'analyzeAuraTaskPriorities'
];
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport { ' + exposed.join(', ') + ' };').toString('base64');
const api = await import(moduleUrl);
const worker = api.default;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = async () => { throw new Error('Unexpected network request blocked by test'); };
});
afterEach(() => { globalThis.fetch = originalFetch; });

function envBase() {
  const fixture = name => 'test-' + name + '-only';
  return {
    WEBHOOK_SECRET: fixture('webhook'), TELEGRAM_BOT_TOKEN: fixture('bot'),
    ALLOWED_USER_ID: String(100), GEMINI_API_KEY: fixture('gemini'),
    GOOGLE_CLIENT_ID: fixture('client'), GOOGLE_CLIENT_SECRET: fixture('client-secret'),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64')
  };
}
function telegramRequest(body, secret = 'test-webhook-only') {
  return new Request('https://aura.invalid/telegram', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}
// Every call is a new Telegram update; redelivery tests reuse one object on purpose.
let nextUpdateId = 1;
function message(text, user = 100, type = 'private') {
  return { update_id: nextUpdateId++, message: { from: { id: user }, chat: { id: user, type }, text } };
}
function json(value, status = 200) { return Response.json(value, { status }); }
function freshEvent() {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', summary: 'Synthetic event',
    status: 'pending', createdAt: Date.now(),
    start: '2099-01-01T10:00:00+08:00', end: '2099-01-01T11:00:00+08:00', reminderMinutes: 10
  };
}
async function calendarEnv() {
  const env = envBase();
  const encrypted = await api.encryptToken(env, 'synthetic-refresh-token');
  env.AURA_AUTH_STORE = { get: async () => encrypted };
  return env;
}

test('health endpoint works without bindings', async () => {
  const response = await worker.fetch(new Request('https://aura.invalid/'), {}, {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'AURA is online!');
});

test('webhook and diagnostic endpoint reject absent or wrong secrets', async () => {
  for (const secret of ['', 'wrong']) {
    const response = await worker.fetch(telegramRequest(message('/start'), secret), envBase(), {});
    assert.equal(response.status, 403);
  }
  const response = await worker.fetch(new Request('https://aura.invalid/test-gemini'), envBase(), {});
  assert.equal(response.status, 403);
});

test('webhook rejects malformed JSON and safely ignores null', async () => {
  assert.equal((await worker.fetch(telegramRequest('{'), envBase(), {})).status, 400);
  assert.equal((await worker.fetch(telegramRequest('null'), envBase(), {})).status, 200);
});

test('wrong user and non-private chats never start background work', async () => {
  for (const body of [message('/start', 200), message('/start', 100, 'group'), {}]) {
    const response = await worker.fetch(telegramRequest(body), envBase(), {
      waitUntil() { assert.fail('Unauthorized background work'); }
    });
    assert.equal(response.status, 200);
  }
});

test('authorized /start only sends a Telegram response', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return json({ ok: true });
  };
  const jobs = [];
  const response = await worker.fetch(telegramRequest(message('/start')), envBase(), { waitUntil(p) { jobs.push(p); } });
  await Promise.all(jobs);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'api.telegram.org');
  assert.equal(calls[0].body.chat_id, 100);
});

test('OAuth unknown state cannot obtain tokens', async () => {
  const env = { ...envBase(), AURA_AUTH_STORE: { get: async () => null } };
  const url = 'https://aura.invalid/oauth/callback?state=' + 'a'.repeat(43) + '&code=synthetic';
  assert.equal((await worker.fetch(new Request(url), env, {})).status, 400);
});

test('AES-GCM token round trip and tamper detection', async () => {
  const env = envBase();
  const packed = await api.encryptToken(env, 'synthetic-refresh-token');
  assert.equal(await api.decryptToken(env, packed), 'synthetic-refresh-token');
  const obj = JSON.parse(packed);
  const bytes = Buffer.from(obj.data, 'base64');
  bytes[0] ^= 1;
  obj.data = bytes.toString('base64');
  await assert.rejects(api.decryptToken(env, JSON.stringify(obj)));
  await assert.rejects(api.encryptToken({ TOKEN_ENCRYPTION_KEY: Buffer.from([0]).toString('base64') }, 'synthetic'));
});

test('freshness rejects stale, missing, malformed and future timestamps', () => {
  for (const pending of [null, {}, { createdAt: 'now' }, { createdAt: Date.now() - 600001 }, { createdAt: Date.now() + 60000 }]) {
    assert.equal(api.isFreshConfirmation(pending), false);
  }
  assert.equal(api.isFreshConfirmation({ createdAt: Date.now() }), true);
});

test('stale calendar create/update/delete never contact an API', async () => {
  for (const createdAt of [undefined, Date.now() - 600001, Date.now() + 60000]) {
    const pending = { ...freshEvent(), createdAt, originalStart: '2099-01-01T10:00:00+08:00', originalEnd: '2099-01-01T11:00:00+08:00' };
    await assert.rejects(api.createGoogleCalendarEvent({}, pending), /預覽/);
    await assert.rejects(api.updateGoogleCalendarEvent({}, pending), /預覽/);
    await assert.rejects(api.deleteGoogleCalendarEvent({}, pending), /過期/);
  }
});

test('calendar create uses a deterministic event ID and treats 409 as uncertain', async () => {
  const env = await calendarEnv();
  const ids = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com')) return json({ access_token: 'synthetic-access' });
    assert.equal(options.method, 'POST');
    ids.push(JSON.parse(options.body).id);
    return json({}, 409);
  };
  const event = freshEvent();
  await assert.rejects(api.createGoogleCalendarEvent(env, event), /尚未確認/);
  await assert.rejects(api.createGoogleCalendarEvent(env, event), /尚未確認/);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test('calendar update rechecks the event and sends If-Match', async () => {
  const env = await calendarEnv();
  const pending = { ...freshEvent(), originalStart: '2099-01-01T10:00:00+08:00', originalEnd: '2099-01-01T11:00:00+08:00', newStart: '2099-01-02T10:00:00+08:00', newEnd: '2099-01-02T11:00:00+08:00' };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com')) return json({ access_token: 'synthetic-access' });
    if (options.method === 'PATCH') {
      calls.push(options);
      assert.equal(options.headers['If-Match'], 'synthetic-etag');
      return json({}, 412);
    }
    return json({ summary: pending.summary, start: { dateTime: pending.originalStart }, end: { dateTime: pending.originalEnd }, etag: 'synthetic-etag' });
  };
  await assert.rejects(api.updateGoogleCalendarEvent(env, pending), /變更/);
  assert.equal(calls.length, 1);
});

test('calendar deletion refuses events with attendees before DELETE', async () => {
  const env = await calendarEnv();
  const pending = { ...freshEvent(), originalStart: '2099-01-01T10:00:00+08:00', originalEnd: '2099-01-01T11:00:00+08:00' };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('oauth2.googleapis.com')) return json({ access_token: 'synthetic-access' });
    assert.notEqual(options.method, 'DELETE');
    return json({ attendees: [{ self: true }] });
  };
  await assert.rejects(api.deleteGoogleCalendarEvent(env, pending), /受邀者/);
});

test('model thought blocks never become a user-facing answer or plan JSON', async () => {
  const parts = [{ text: 'synthetic internal content', thought: true }, { text: '{"steps":["Synthetic step"]}' }];
  assert.equal(api.extractGeminiText({ candidates: [{ content: { parts } }] }), '{"steps":["Synthetic step"]}');
  globalThis.fetch = async () => json({ candidates: [{ content: { parts } }] });
  assert.deepEqual(await api.generateAuraTaskPlan(envBase(), 'Synthetic goal'), ['Synthetic step']);
});

test('Gemini 400 is not retried and raw upstream error text is not logged', async t => {
  let requests = 0;
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', () => {});
  globalThis.fetch = async () => { requests++; return new Response('PRIVATE_UPSTREAM_DETAIL', { status: 400 }); };
  await assert.rejects(api.callGeminiWithRetry(envBase(), {}), /Gemini HTTP 400/);
  assert.equal(requests, 1);
  assert.equal(logs.join('\n').includes('PRIVATE_UPSTREAM_DETAIL'), false);
});

test('task lookup binds the chat ID instead of interpolating SQL', async () => {
  let bound;
  const malicious = "synthetic' OR 1=1 --";
  const env = { AURA_TASKS_DB: { prepare(sql) {
    assert.ok(sql.includes('WHERE chat_id = ?1'));
    assert.equal(sql.includes(malicious), false);
    return { bind(...values) { bound = values; return { all: async () => ({ success: true, results: [] }) }; } };
  } } };
  assert.deepEqual(await api.listAuraTasks(env, malicious), []);
  assert.deepEqual(bound, [malicious]);
});

test('legacy revision confirmation only gives ID guidance and never reads KV or D1', async () => {
  const env = { AURA_AUTH_STORE: { get: async () => assert.fail('Legacy KV must not be read') } };
  assert.match(await api.confirmAuraPlanRevision(env, '100'), /修改ID/);
});

test('offline scanner detects synthetic credentials but returns no raw values', () => {
  const synthetic = 'AIza' + 'x'.repeat(35);
  const result = scanText(synthetic, 'synthetic.txt');
  assert.equal(result[0].rule, 'google-api-key');
  assert.equal(JSON.stringify(result).includes(synthetic), false);
  assert.deepEqual(scanText('GEMINI_API_KEY="REPLACE_WITH_TEST_GEMINI_API_KEY"'), []);
});

test('task-analysis function response retains task data without querying Calendar', async () => {
  const payloads = [];
  const env = {
    ...envBase(),
    AURA_MEMORY_STORE: { list: async () => ({ keys: [], list_complete: true }) },
    AURA_TASKS_DB: { prepare: () => ({ bind: () => ({ all: async () => ({
      success: true, results: [{ title: 'Synthetic task', status: 'todo', priority: 'high', due_at: null }]
    }) }) }) }
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'generativelanguage.googleapis.com');
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payloads.length === 1) return json({ candidates: [{ content: {
      role: 'model', parts: [{ functionCall: { name: 'list_tasks', args: {} } }]
    } }] });
    assert.equal(payload.contents.at(-1).parts[0].functionResponse.name, 'list_tasks');
    assert.equal(payload.contents.at(-1).parts[0].functionResponse.response.result.tasks[0].title, 'Synthetic task');
    return json({ candidates: [{ content: { parts: [{ text: 'Synthetic analysis' }] } }] });
  };
  assert.equal(await api.askGemini(env, '分析我的任務', '100'), 'Synthetic analysis');
  assert.equal(payloads.length, 2);
});

test('legacy confirmation text only returns guidance and never reads old KV pending', async () => {
  const sent = [];
  const env = { ...envBase(), AURA_AUTH_STORE: { get() { assert.fail('Legacy KV read'); } } };
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.telegram.org');
    sent.push(JSON.parse(options.body).text);
    return json({ ok: true });
  };
  const jobs = [];
  await worker.fetch(telegramRequest(message('確認計畫')), env, { waitUntil(p) { jobs.push(p); } });
  await Promise.all(jobs);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes('計畫ID'));
});

async function planChatFixture(t, { missingMigration = false } = {}) {
  const db = await createDatabase();
  t.after(() => db.close());
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('synthetic-parent', String(100), 'Synthetic goal');
  if (missingMigration) db.sqlite.exec('DROP TABLE aura_task_plan_actions');
  const sent = [];
  const env = { ...envBase(), AURA_TASKS_DB: db,
    AURA_AUTH_STORE: { get() { assert.fail('New plan flow must not read legacy KV'); }, put() { assert.fail('New plan flow must not write legacy KV'); } }
  };
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === 'generativelanguage.googleapis.com') {
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ steps: ['Synthetic first', 'Synthetic second'] }) }] } }] });
    }
    assert.equal(new URL(url).hostname, 'api.telegram.org');
    sent.push(JSON.parse(options.body).text);
    return json({ ok: true });
  };
  async function send(text) {
    const jobs = [];
    const response = await worker.fetch(telegramRequest(message(text)), env, { waitUntil(p) { jobs.push(p); } });
    assert.equal(response.status, 200);
    await Promise.all(jobs);
    return sent.at(-1);
  }
  return { db, send, sent };
}

test('Telegram preview, ID-bound confirmation and repeat confirmation use the action transaction', async t => {
  const f = await planChatFixture(t);
  const preview = await f.send('規劃任務：Synthetic goal');
  const id = preview.match(/確認計畫 ([0-9a-f-]{36})/)?.[1];
  assert.ok(id);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n, 0);
  assert.ok((await f.send('確認計畫 ' + id)).includes('已成功儲存'));
  assert.ok((await f.send('確認計畫 ' + id)).includes('沒有重複新增'));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n, 2);
});

test('Telegram cancellation command prevents its matching confirmation', async t => {
  const f = await planChatFixture(t);
  const preview = await f.send('規劃任務：Synthetic goal');
  const id = preview.match(/取消計畫 ([0-9a-f-]{36})/)?.[1];
  assert.ok(id);
  assert.ok((await f.send('取消計畫 ' + id)).includes('已取消'));
  assert.ok((await f.send('確認計畫 ' + id)).includes('已取消或失效'));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n, 0);
});

test('Telegram confirmation of a changed task explains why and logs only the reason code', async t => {
  const f = await planChatFixture(t);
  const preview = await f.send('規劃任務：Synthetic goal');
  const id = preview.match(/確認計畫 ([0-9a-f-]{36})/)?.[1];
  assert.ok(id);
  f.db.sqlite.prepare("UPDATE tasks SET title = 'Synthetic renamed', updated_at = '2099-01-01 00:00:00'").run();
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  assert.ok((await f.send('確認計畫 ' + id)).includes('已變更'));
  const logged = logs.join('\n');
  assert.ok(logged.includes('data_changed'));
  for (const secret of [id, 'Synthetic', String(100)]) assert.equal(logged.includes(secret), false);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n, 0);
});

// R7: Telegram may redeliver one update_id. Each update is processed at most once while
// the dedupe table works; when it does not, messages are still processed (fail open).
async function dedupeFixture(t, { withTable = true } = {}) {
  const db = await createDatabase();
  t.after(() => db.close());
  if (!withTable) db.sqlite.exec('DROP TABLE aura_telegram_updates');
  const replies = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.telegram.org');
    replies.push(JSON.parse(options.body).text);
    return json({ ok: true });
  };
  const env = { ...envBase(), AURA_TASKS_DB: db };
  async function deliver(update) {
    const jobs = [];
    const response = await worker.fetch(telegramRequest(update), env, { waitUntil(p) { jobs.push(p); } });
    assert.equal(response.status, 200);
    await Promise.all(jobs);
  }
  const rows = () => db.sqlite.prepare('SELECT * FROM aura_telegram_updates ORDER BY update_id').all();
  return { db, deliver, replies, rows };
}

test('a redelivered Telegram update is processed only once, even concurrently', async t => {
  const f = await dedupeFixture(t);
  const update = message('/start');
  await Promise.all([f.deliver(update), f.deliver(update)]);
  await f.deliver(update);
  assert.equal(f.replies.length, 1);
  await f.deliver(message('/start'));
  assert.equal(f.replies.length, 2);
  assert.deepEqual(f.rows().map(row => Object.keys(row).sort()), [['received_at', 'update_id'], ['received_at', 'update_id']]);
});

test('updates from other users are neither processed nor recorded', async t => {
  const f = await dedupeFixture(t);
  await f.deliver(message('/start', 999));
  await f.deliver(message('/start', 100, 'group'));
  assert.equal(f.replies.length, 0);
  assert.equal(f.rows().length, 0);
});

test('dedupe records older than 7 days are pruned when a new update arrives', async t => {
  const f = await dedupeFixture(t);
  f.db.sqlite.prepare('INSERT INTO aura_telegram_updates (update_id, received_at) VALUES (?, ?), (?, ?)')
    .run(900001, Date.now() - 8 * 86400000, 900002, Date.now() - 86400000);
  await f.deliver(message('/start'));
  assert.deepEqual(f.rows().map(row => row.update_id).filter(id => id >= 900001), [900002]);
});

test('without the dedupe table or update_id, messages are still processed', async t => {
  const f = await dedupeFixture(t, { withTable: false });
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const update = message('/start');
  await f.deliver(update);
  await f.deliver(update);
  assert.equal(f.replies.length, 2);
  assert.equal(logs.join('\n').includes(String(update.update_id)), false);
  const withTable = await dedupeFixture(t);
  const { update_id, ...noId } = message('/start');
  await withTable.deliver(noId);
  await withTable.deliver(noId);
  assert.equal(withTable.replies.length, 2);
  assert.equal(withTable.rows().length, 0);
});

test('missing action migration fails closed without falling back to KV writes', async t => {
  const f = await planChatFixture(t, { missingMigration: true });
  const result = await f.send('規劃任務：Synthetic goal');
  assert.ok(result.includes('暫時無法完成'));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n, 0);
});

async function analysisFixture(t) {
  const db = await createDatabase();
  t.after(() => db.close());
  for (const [id, owner, status] of [['own', '100', 'todo'], ['other', '200', 'todo'], ['finished', '100', 'done']]) {
    db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title,status) VALUES (?,?,?,?)').run(id, owner, 'Synthetic ' + id, status);
    db.sqlite.prepare('INSERT INTO task_steps(id,task_id,title,step_order,status,notes) VALUES (?,?,?,?,?,?)')
      .run(id + '-step', id, id + ' step title', 1, 'todo', 'private-note-not-for-model');
  }
  const prompts = [];
  const sent = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (new URL(url).hostname === 'generativelanguage.googleapis.com') {
      prompts.push(body.contents[0].parts[0].text);
      return json({ candidates: [{ content: { parts: [{ text: 'Synthetic analysis' }] } }] });
    }
    if (new URL(url).hostname === 'api.telegram.org') {
      sent.push(body.text);
      return json({ ok: true });
    }
    throw new Error('Unexpected external request');
  };
  return { db, prompts, sent, env: { ...envBase(), AURA_TASKS_DB: db } };
}

test('task analysis includes ordered own steps, excludes other owners, completed tasks, IDs and notes, and never writes', async t => {
  const f = await analysisFixture(t);
  f.db.sqlite.prepare('INSERT INTO task_steps(id,task_id,title,step_order,status) VALUES (?,?,?,?,?)')
    .run('own-second', 'own', 'own second title', 2, 'in_progress');
  f.db.sqlite.exec('PRAGMA query_only = ON');
  const reply = await api.analyzeAuraTaskPriorities(f.env, 100, '分析現有步驟');
  assert.ok(reply.includes('AI 任務分析'));
  const context = JSON.parse(f.prompts[0].split('\n').at(-1));
  assert.equal(context.length, 1);
  assert.deepEqual(context[0].steps, [
    { step_order: 1, title: 'own step title', status: 'todo' },
    { step_order: 2, title: 'own second title', status: 'in_progress' }
  ]);
  assert.equal(context[0].steps_truncated, false);
  assert.ok(!f.prompts[0].includes('private-note-not-for-model'));
  assert.ok(!JSON.stringify(context).includes('other step title'));
  assert.ok(!JSON.stringify(context).includes('finished step title'));
  assert.ok(!JSON.stringify(context).includes('own-second'));
  assert.ok(f.prompts[0].includes('不強制推薦三項任務'));
});

test('task analysis marks truncated steps and represents an empty plan explicitly', async t => {
  const f = await analysisFixture(t);
  for (let n = 2; n <= 22; n++) {
    f.db.sqlite.prepare('INSERT INTO task_steps(id,task_id,title,step_order) VALUES (?,?,?,?)')
      .run('bounded-' + n, 'own', 'Synthetic step ' + n, n);
  }
  f.db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('empty', '100', 'Synthetic empty');
  await api.analyzeAuraTaskPriorities(f.env, 100, '分析步驟');
  const context = JSON.parse(f.prompts[0].split('\n').at(-1));
  assert.equal(context.find(x => x.title === 'Synthetic own').steps.length, 20);
  assert.equal(context.find(x => x.title === 'Synthetic own').steps_truncated, true);
  assert.deepEqual(context.find(x => x.title === 'Synthetic empty').steps, []);
  assert.equal(context.find(x => x.title === 'Synthetic empty').steps_truncated, false);
});

test('step read failure stops task analysis before sending incomplete data to AI', async t => {
  const f = await analysisFixture(t);
  const prepare = f.db.prepare;
  f.db.prepare = sql => sql.includes('WITH ranked_steps')
    ? { bind: () => ({ all: async () => ({ success: false }) }) }
    : prepare(sql);
  await assert.rejects(api.analyzeAuraTaskPriorities(f.env, 100, '分析步驟'), /無法讀取任務步驟/);
  assert.equal(f.prompts.length, 0);
});

test('Telegram natural-language step analysis reaches the readonly task context without requiring 任務 in the message', async t => {
  const f = await analysisFixture(t);
  f.db.sqlite.exec('PRAGMA query_only = ON');
  const jobs = [];
  await worker.fetch(telegramRequest(message('請分析計畫的三個步驟是否清楚，只給建議')), f.env, { waitUntil(p) { jobs.push(p); } });
  await Promise.all(jobs);
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0].includes('own step title'));
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].includes('Synthetic analysis'));
});

async function revisionChatFixture(t, options = {}) {
  const db = await createDatabase({ uniqueSteps: false });
  t.after(() => db.close());
  db.sqlite.prepare('INSERT INTO tasks(id,chat_id,title) VALUES (?,?,?)').run('synthetic-revision', '100', 'Synthetic revision goal');
  for (const [n, status] of [[1, 'todo'], [2, 'in_progress']]) {
    db.sqlite.prepare('INSERT INTO task_steps(id,task_id,title,step_order,status) VALUES (?,?,?,?,?)')
      .run('synthetic-revision-' + n, 'synthetic-revision', 'Synthetic step ' + n, n, status);
  }
  if (options.missingMigration) db.sqlite.exec('DROP TABLE aura_task_plan_revisions');
  const sent = [];
  let modelValue = { summary: 'Synthetic reason', renames: [{ step_order: 1, new_title: 'Synthetic better first' }], additions: ['Synthetic final'] };
  const prompts = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (new URL(url).hostname === 'generativelanguage.googleapis.com') {
      prompts.push(body.contents[0].parts[0].text);
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(modelValue) }] } }] });
    }
    if (new URL(url).hostname === 'api.telegram.org') { sent.push(body.text); return json({ ok: true }); }
    throw new Error('Unexpected network request');
  };
  const noKv = async () => assert.fail('Revision path must not access legacy KV');
  const env = { ...envBase(), AURA_TASKS_DB: db, AURA_AUTH_STORE: { get: noKv, put: noKv, delete: noKv } };
  async function send(text) {
    const jobs = [];
    assert.equal((await worker.fetch(telegramRequest(message(text)), env, { waitUntil(p) { jobs.push(p); } })).status, 200);
    await Promise.all(jobs);
    return sent.at(-1);
  }
  return { db, send, prompts, setModel(value) { modelValue = value; } };
}

test('Telegram revision preview, ID confirmation, replay and legacy guidance do not touch KV', async t => {
  const f = await revisionChatFixture(t);
  const preview = await f.send('AI 修改計畫：Synthetic revision goal');
  const id = preview.match(/確認修改計畫 ([0-9a-f-]{36})/)?.[1];
  assert.ok(id);
  assert.ok(preview.includes('取消修改計畫 ' + id));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n, 2);
  assert.ok(!f.prompts[0].includes('synthetic-revision-1'));
  assert.ok((await f.send('確認修改計畫')).includes('修改ID'));
  assert.ok((await f.send('取消修改計畫')).includes('修改ID'));
  assert.ok((await f.send('確認修改計畫 ' + id)).includes('已成功修改'));
  assert.ok((await f.send('確認修改計畫 ' + id)).includes('沒有重複'));
  const rows = f.db.sqlite.prepare('SELECT title,status FROM task_steps ORDER BY step_order').all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Synthetic better first');
  assert.equal(rows[1].status, 'in_progress');
});

test('Telegram revision cancellation prevents later execution of that ID', async t => {
  const f = await revisionChatFixture(t);
  const preview = await f.send('AI 修改計畫：Synthetic revision goal');
  const id = preview.match(/取消修改計畫 ([0-9a-f-]{36})/)[1];
  assert.ok((await f.send('取消修改計畫 ' + id)).includes('已取消'));
  assert.ok((await f.send('確認修改計畫 ' + id)).includes('取消或失效'));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n, 2);
});

test('failed or no-change revision proposals cannot replace an earlier ID-bound preview', async t => {
  const f = await revisionChatFixture(t);
  const first = await f.send('AI 修改計畫：Synthetic revision goal');
  const id = first.match(/確認修改計畫 ([0-9a-f-]{36})/)[1];
  f.setModel({ summary: 'Synthetic no changes', renames: [], additions: [] });
  assert.ok((await f.send('AI 修改計畫：Synthetic revision goal')).includes('沒有建議修改'));
  f.setModel({ summary: 'Synthetic invalid', renames: [{ step_order: 2, new_title: 'Forbidden active rename' }], additions: [] });
  assert.ok((await f.send('AI 修改計畫：Synthetic revision goal')).includes('未能產生'));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM aura_task_plan_revisions').get().n, 1);
  assert.ok((await f.send('確認修改計畫 ' + id)).includes('已成功修改'));
});

test('missing revision migration fails closed without legacy KV fallback', async t => {
  const f = await revisionChatFixture(t, { missingMigration: true });
  assert.ok((await f.send('AI 修改計畫：Synthetic revision goal')).includes('暫時無法完成'));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM task_steps').get().n, 2);
});

// A cancellation that did not take effect must never be reported as cancelled or expired,
// because the preview is still pending and could still be confirmed.
const IGNORE_CANCEL = table => `CREATE TRIGGER synthetic_ignore_cancel BEFORE UPDATE OF status ON ${table} ` +
  "WHEN NEW.status IN ('cancelled','expired') BEGIN SELECT RAISE(IGNORE); END;";

test('news preview defaults off and cannot trigger a model or source fetch', async () => {
  const messages=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).hostname,'api.telegram.org');messages.push(JSON.parse(options.body));
    return json({ok:true,result:{message_id:1}});
  };
  const jobs=[];await worker.fetch(telegramRequest(message('昨日科技新聞')),envBase(),{waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);assert.equal(messages.length,1);assert.match(messages[0].text,/尚未啟用/);
});
test('authorized news preview uses public feeds only and bypasses Gemini and private bindings', async () => {
  const env={...envBase(),DAILY_NEWS_PREVIEW_ENABLED:'true'};
  const yesterday=new Date(Date.now()-86400000).toUTCString();
  const messages=[];
  globalThis.fetch=async(url,options)=>{
    const host=new URL(url).hostname;
    if(host==='api.telegram.org'){
      messages.push(JSON.parse(options.body));return json({ok:true,result:{message_id:messages.length}});
    }
    assert.ok(['openai.com','blog.google','www.apple.com','developer.nvidia.com'].includes(host),'unexpected network destination');
    return new Response(host==='openai.com'?`<rss><channel><item><title>Synthetic AI model</title><link>https://openai.com/index/synthetic</link><pubDate>${yesterday}</pubDate><description>Public synthetic description</description></item></channel></rss>`:'<rss><channel></channel></rss>');
  };
  const jobs=[];await worker.fetch(telegramRequest(message('昨日科技新聞')),env,{waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);assert.equal(messages.length,2);assert.match(messages[0].text,/未呼叫 AI/);
});

test('Telegram plan cancellation that did not apply is reported honestly', async t => {
  const f = await planChatFixture(t);
  const preview = await f.send('規劃任務：Synthetic goal');
  const id = preview.match(/取消計畫 ([0-9a-f-]{36})/)?.[1];
  f.db.sqlite.exec(IGNORE_CANCEL('aura_task_plan_actions'));
  const reply = await f.send('取消計畫 ' + id);
  assert.ok(!reply.includes('已取消') && !reply.includes('已失效'), reply);
  assert.ok(reply.includes('未能確認取消'), reply);
  assert.equal(f.db.sqlite.prepare('SELECT status FROM aura_task_plan_actions').get().status, 'pending');
});

test('Telegram revision cancellation that did not apply is reported honestly', async t => {
  const f = await revisionChatFixture(t);
  const preview = await f.send('AI 修改計畫：Synthetic revision goal');
  const id = preview.match(/取消修改計畫 ([0-9a-f-]{36})/)[1];
  f.db.sqlite.exec(IGNORE_CANCEL('aura_task_plan_revisions'));
  const reply = await f.send('取消修改計畫 ' + id);
  assert.ok(!reply.includes('已取消') && !reply.includes('已過期'), reply);
  assert.ok(reply.includes('未能確認取消'), reply);
  assert.equal(f.db.sqlite.prepare('SELECT status FROM aura_task_plan_revisions').get().status, 'pending');
});

// Staging-only acceptance aid: preview a specific past Taipei date (gated like 昨日科技新聞).
function taipeiDate(offsetDays) {
  return new Date(Date.now() + 8 * 3600000 - offsetDays * 86400000).toISOString().slice(0, 10);
}
test('dated news preview is off unless preview is enabled', async () => {
  const messages=[];
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).hostname,'api.telegram.org');messages.push(JSON.parse(options.body));
    return json({ok:true,result:{message_id:1}});
  };
  const jobs=[];await worker.fetch(telegramRequest(message('科技新聞 ' + taipeiDate(2))),envBase(),{waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);assert.equal(messages.length,1);assert.match(messages[0].text,/尚未啟用/);
});
test('dated news preview rejects today, future, invalid and older-than-7-day dates without fetching feeds', async () => {
  const env={...envBase(),DAILY_NEWS_PREVIEW_ENABLED:'true'};
  for (const date of [taipeiDate(0), taipeiDate(-1), taipeiDate(8), '2026-02-30', '2026-13-01']) {
    const messages=[];
    globalThis.fetch=async(url,options)=>{
      assert.equal(new URL(url).hostname,'api.telegram.org','feeds must not be fetched for a rejected date');
      messages.push(JSON.parse(options.body));return json({ok:true,result:{message_id:1}});
    };
    const jobs=[];await worker.fetch(telegramRequest(message('科技新聞 ' + date)),env,{waitUntil:p=>jobs.push(p)});
    await Promise.all(jobs);assert.equal(messages.length,1,date);assert.match(messages[0].text,/過去 7 天/,date);
  }
});
test('dated news preview covers exactly that Taipei calendar day', async () => {
  const env={...envBase(),DAILY_NEWS_PREVIEW_ENABLED:'true'};
  const date=taipeiDate(3);
  const inside=new Date(Date.parse(date+'T12:00:00+08:00')).toUTCString();
  const outside=new Date(Date.parse(date+'T12:00:00+08:00')+86400000).toUTCString();
  const messages=[];
  globalThis.fetch=async(url,options)=>{
    const host=new URL(url).hostname;
    if(host==='api.telegram.org'){messages.push(JSON.parse(options.body));return json({ok:true,result:{message_id:messages.length}});}
    assert.ok(['openai.com','blog.google','www.apple.com','developer.nvidia.com'].includes(host),'unexpected network destination');
    return new Response(host==='openai.com'?`<rss><channel><item><title>Synthetic AI model inside</title><link>https://openai.com/index/inside</link><pubDate>${inside}</pubDate><description>Inside day</description></item><item><title>Synthetic AI model outside</title><link>https://openai.com/index/outside</link><pubDate>${outside}</pubDate><description>Next day</description></item></channel></rss>`:'<rss><channel></channel></rss>');
  };
  const jobs=[];await worker.fetch(telegramRequest(message('科技新聞 ' + date)),env,{waitUntil:p=>jobs.push(p)});
  await Promise.all(jobs);
  assert.equal(messages.length,2);
  assert.ok(messages[0].text.includes(date));
  assert.match(messages[1].text,/inside/);assert.ok(!messages.some(m=>m.text.includes('outside')));
});
