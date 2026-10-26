import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDatabase } from './helpers/sqlite-d1.mjs';
import { NEWS_SOURCES, runDailyNews } from '../src/daily-news.js';

// N3: a failed, interrupted or uncertain digest is never resent, so the next day's digest
// must say so once. Absent rows are not reported (the feature may simply have been off).
const NOW = Date.parse('2026-10-26T09:00:00+08:00'); // digest for 2026-10-25
const PREVIOUS = '2026-10-24';
const OWNER = String(100);
const fixture = name => 'synthetic-' + name;

async function setup() {
  const db = await createDatabase();
  db.sqlite.exec(await readFile(new URL('../migrations/0004_daily_news.sql', import.meta.url), 'utf8'));
  db.sqlite.exec(await readFile(new URL('../migrations/0005_daily_news_ai_budget.sql', import.meta.url), 'utf8'));
  const env = { AURA_TASKS_DB: db, DAILY_NEWS_ENABLED: 'true', ALLOWED_USER_ID: OWNER, TELEGRAM_BOT_TOKEN: fixture('bot') };
  const messages = [];
  const fetcher = async (url, options) => {
    if (NEWS_SOURCES.some(x => x.feed === url)) return new Response('<rss><channel></channel></rss>');
    assert.equal(new URL(url).hostname, 'api.telegram.org');
    messages.push(JSON.parse(options.body).text);
    return Response.json({ ok: true, result: { message_id: messages.length } });
  };
  const previous = (status, total = 0, sent = 0) => db.sqlite.prepare(
    'INSERT INTO aura_daily_news (owner_id, news_date, status, total_parts, sent_parts) VALUES (?, ?, ?, ?, ?)'
  ).run(OWNER, PREVIOUS, status, total, sent);
  const run = (now = NOW) => runDailyNews(env, { now, fetcher, generate: async () => { throw new Error('Model must not be called'); } });
  return { db, env, messages, previous, run };
}

for (const [status, total, sent, pattern] of [
  ['failed', 0, 0, /準備失敗/],
  ['preparing', 0, 0, /中斷/],
  ['unknown', 3, 1, /1\/3/],
  ['sending', 3, 2, /2\/3/]
]) {
  test(`a ${status} digest yesterday is reported once at the start of today's digest`, async () => {
    const f = await setup();
    try {
      f.previous(status, total, sent);
      assert.equal((await f.run()).status, 'sent');
      assert.match(f.messages[0], new RegExp(PREVIOUS));
      assert.match(f.messages[0], pattern);
      assert.match(f.messages[0], /不會自動補發/);
      assert.match(f.messages[1], /每日科技新聞速報｜2026-10-25/);
      for (const secret of [OWNER, fixture('bot')]) assert.equal(f.messages[0].includes(secret), false);
      const today = f.db.sqlite.prepare("SELECT * FROM aura_daily_news WHERE news_date = '2026-10-25'").get();
      assert.equal(today.status, 'sent');
      assert.equal(today.total_parts, f.messages.length);
      assert.equal(JSON.parse(today.parts_json)[0], f.messages[0]);
      // The previous row is a historical record; it is reported, never rewritten or resent.
      assert.equal(f.db.sqlite.prepare('SELECT status FROM aura_daily_news WHERE news_date = ?').get(PREVIOUS).status, status);
      assert.equal((await f.run(NOW + 300_000)).status, 'already-claimed');
      const count = f.messages.length;
      assert.equal((await f.run(NOW + 86_400_000)).status, 'sent');
      assert.equal(f.messages.slice(count).some(text => text.includes(PREVIOUS)), false);
    } finally { f.db.close(); }
  });
}

test('no notice when yesterday was sent or has no record', async () => {
  for (const seed of [f => f.previous('sent', 2, 2), () => {}]) {
    const f = await setup();
    try {
      seed(f);
      assert.equal((await f.run()).status, 'sent');
      assert.match(f.messages[0], /每日科技新聞速報｜2026-10-25/);
      assert.equal(f.messages.some(text => text.includes(PREVIOUS)), false);
    } finally { f.db.close(); }
  }
});

test('a failed lookup of yesterday never blocks today\'s digest', async () => {
  const f = await setup();
  try {
    f.previous('failed');
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = sql => {
      if (/^SELECT status, total_parts, sent_parts FROM aura_daily_news/.test(sql)) throw new Error('synthetic read failure');
      return prepare(sql);
    };
    assert.equal((await f.run()).status, 'sent');
    assert.match(f.messages[0], /每日科技新聞速報｜2026-10-25/);
  } finally { f.db.close(); }
});
