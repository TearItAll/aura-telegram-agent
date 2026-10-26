import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDatabase } from './helpers/sqlite-d1.mjs';
import { NEWS_SOURCES, newsWindow, parseNewsFeed, collectNews, renderNews, runDailyNews, sendNewsPart, buildNewsDigest } from '../src/daily-news.js';
const fixture = name => 'synthetic-' + name;
const NOW = Date.parse('2026-10-26T09:00:00+08:00');
const window = newsWindow(NOW);
function rss({date='Sun, 25 Oct 2026 08:00:00 GMT',url='https://openai.com/index/synthetic',title='Synthetic AI model'}={}) {
  return `<rss><channel><item><title>${title}</title><link>${url}</link><pubDate>${date}</pubDate><description><![CDATA[<p>Synthetic publisher description</p>]]></description></item></channel></rss>`;
}
const article = parseNewsFeed(rss(), NEWS_SOURCES[0], window)[0];
const output = JSON.stringify({items:[{index:0,category:'AI 模型與研究',summary:'合成模型研究摘要。',difference:'來源摘要未提供可核對的技術比較',importance:3}]});
const collection = {items:[article],successful:4,failed:[]};
async function setup() {
  const db = await createDatabase();
  db.sqlite.exec(await readFile(new URL('../migrations/0004_daily_news.sql',import.meta.url),'utf8'));
  db.sqlite.exec(await readFile(new URL('../migrations/0005_daily_news_ai_budget.sql',import.meta.url),'utf8'));
  return {db,env:{AURA_TASKS_DB:db,DAILY_NEWS_ENABLED:'true',DAILY_NEWS_USE_AI:'true',DAILY_NEWS_AI_FREE_VERIFIED:'true',ALLOWED_USER_ID:String(100),TELEGRAM_BOT_TOKEN:fixture('bot'),GEMINI_API_KEY:fixture('model')}};
}
function network({failFeeds=false,timeout=false,badAck=false}={}) {
  const messages=[];
  const fetcher=async(url,options)=>{
    if(NEWS_SOURCES.some(x=>x.feed===url)) {
      if(failFeeds)throw Error('synthetic outage');
      return new Response(url===NEWS_SOURCES[0].feed?rss():'<rss><channel></channel></rss>');
    }
    assert.equal(new URL(url).hostname,'api.telegram.org');
    assert.equal(options.method,'POST');
    messages.push(JSON.parse(options.body));
    if(timeout)throw Error('synthetic timeout after possible delivery');
    return Response.json(badAck?{ok:false}:{ok:true,result:{message_id:messages.length}});
  };
  return {fetcher,messages};
}
test('Taipei date window is previous calendar day, not rolling 24 hours',()=>{
  assert.equal(window.date,'2026-10-25');
  assert.equal(window.start,Date.parse('2026-10-24T16:00:00Z'));
  assert.equal(window.end,Date.parse('2026-10-25T16:00:00Z'));
  assert.equal(window.due,true);
  assert.equal(newsWindow(Date.parse('2026-10-26T08:59:59+08:00')).due,false);
  assert.equal(newsWindow(Date.parse('2026-10-26T10:00:00+08:00')).due,false);
  assert.equal(newsWindow(Date.parse('2028-03-01T09:00:00+08:00')).date,'2028-02-29');
  assert.equal(newsWindow(Date.parse('2027-01-01T09:00:00+08:00')).date,'2026-12-31');
});
test('publication boundaries, missing dates and changed dates are not news',()=>{
  assert.equal(parseNewsFeed(rss({date:'2026-10-25T00:00:00+08:00'}),NEWS_SOURCES[0],window).length,1);
  for(const date of ['2026-10-26T00:00:00+08:00','2026-10-24T23:59:59+08:00','','2026-10-25 12:00:00'])
    assert.equal(parseNewsFeed(rss({date}),NEWS_SOURCES[0],window).length,0);
});
test('feed parser strips markup, rejects unsafe links and entity declarations',()=>{
  assert.equal(article.excerpt,'Synthetic publisher description');
  for(const url of ['http://openai.com/a','https://openai.com.evil.invalid/a',['https://user:pass','openai.com/a'].join('@'),'javascript:alert(1)','https://127.0.0.1/a'])
    assert.equal(parseNewsFeed(rss({url}),NEWS_SOURCES[0],window).length,0);
  assert.throws(()=>parseNewsFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///x">]>'+rss(),NEWS_SOURCES[0],window));
  assert.throws(()=>parseNewsFeed('<html>error</html>',NEWS_SOURCES[0],window));
});
test('Atom published date is used; updated-only entry is excluded',()=>{
  const feed='<feed><entry><title>Synthetic product</title><link rel="alternate" href="https://www.apple.com/newsroom/synthetic/"/><published>2026-10-25T10:00:00Z</published><summary>Test</summary></entry></feed>';
  assert.equal(parseNewsFeed(feed,NEWS_SOURCES[2],window).length,1);
  assert.equal(parseNewsFeed(feed.replaceAll('published','updated'),{...NEWS_SOURCES[2],verifyUpdated:false},window).length,0);
  assert.equal(parseNewsFeed(feed.replaceAll('published','updated'),NEWS_SOURCES[2],window)[0].requiresPublicationCheck,true);
});
test('Apple updated timestamps require article publication metadata; old publication is excluded',async()=>{
  const feed='<feed><entry><title>Synthetic Apple product</title><link href="https://www.apple.com/newsroom/synthetic/"/><updated>2026-10-25T10:00:00Z</updated></entry></feed>';
  for(const published of ['2026-10-25T10:00:00Z','2026-10-20T10:00:00Z',null]){
    const got=await collectNews(window,async url=>new Response(url===NEWS_SOURCES[2].feed?feed:
      url==='https://www.apple.com/newsroom/synthetic/'?JSON.stringify({datePublished:published}):'<rss><channel></channel></rss>'));
    assert.equal(got.items.length,published==='2026-10-25T10:00:00Z'?1:0);
    assert.equal(got.failed.includes('apple'),published===null);
  }
});
test('collection uses only fixed endpoints, refuses redirects and reports outages',async()=>{
  const visited=[];
  const got=await collectNews(window,async(url,options)=>{
    assert.equal(options.redirect,'manual');visited.push(url);
    if(url!==NEWS_SOURCES[0].feed)throw Error('unavailable');
    return new Response(rss().replace('</channel>',rss().match(/<item>[\s\S]*<\/item>/)[0]+'</channel>'));
  });
  assert.deepEqual(visited,NEWS_SOURCES.map(x=>x.feed));
  assert.equal(got.items.length,1);assert.equal(got.failed.length,3);
});
test('oversize feed is rejected, without accepting partial entries',async()=>{
  const got=await collectNews(window,async()=>new Response('<rss>'+ 'x'.repeat(2_000_001)+'</rss>'));
  assert.equal(got.successful,0);assert.equal(got.items.length,0);
});
test('citation URLs and dates come from publisher metadata, not model output',()=>{
  const parts=renderNews(output,collection,window);
  assert.match(parts[1],/https:\/\/openai.com\/index\/synthetic/);
  assert.match(parts[1],/2026-10-25/);
  assert.match(parts[1],/AI 編輯評估/);
  for(const patch of [{index:99},{index:0,summary:'https://evil.invalid'},{importance:6},{category:'other'}]) {
    const data=JSON.parse(output);Object.assign(data.items[0],patch);
    assert.throws(()=>renderNews(JSON.stringify(data),collection,window));
  }
  const data=JSON.parse(output);data.items.push(data.items[0]);
  assert.throws(()=>renderNews(JSON.stringify(data),collection,window));
});
test('empty day with a source failure does not claim no major news exists',()=>{
  const parts=renderNews('{"items":[]}',{items:[],successful:3,failed:['google']},window).join('\n');
  assert.match(parts,/不代表整個科技圈/);assert.match(parts,/google/);
});
test('disabled and outside-window jobs have no database or network effects',async()=>{
  assert.equal((await runDailyNews({})).status,'disabled');
  assert.equal((await runDailyNews({DAILY_NEWS_ENABLED:'true'},{now:NOW-3_600_000})).status,'outside-window');
});
test('invalid owner and missing migration fail closed before fetching',async()=>{
  const {db,env}=await setup();
  try{
    await assert.rejects(runDailyNews({...env,ALLOWED_USER_ID:String(-100)},{now:NOW,generate:async()=>output}));
    db.sqlite.exec('DROP TABLE aura_daily_news');
    await assert.rejects(runDailyNews(env,{now:NOW,generate:async()=>output}));
  }finally{db.close();}
});
test('concurrent scheduler ticks generate and send only one digest',async()=>{
  const {db,env}=await setup();const {fetcher,messages}=network();let generations=0;
  try{
    const results=await Promise.all(Array.from({length:8},()=>runDailyNews(env,{now:NOW,fetcher,generate:async()=>{generations++;return output;}})));
    assert.equal(results.filter(x=>x.status==='sent').length,1);assert.equal(generations,1);
    assert.equal(messages.length,2);assert.ok(messages.every(x=>x.chat_id==='100'&&!x.parse_mode));
    const row=db.sqlite.prepare('SELECT * FROM aura_daily_news').get();
    assert.equal(row.status,'sent');assert.equal(row.sent_parts,2);
    assert.equal((await runDailyNews(env,{now:NOW+300_000,fetcher,generate:async()=>output})).status,'already-claimed');
    assert.equal(messages.length,2);
  }finally{db.close();}
});
test('all sources unavailable produces no misleading notification and no repeated calls',async()=>{
  const {db,env}=await setup();const {fetcher,messages}=network({failFeeds:true});
  try{
    await assert.rejects(runDailyNews(env,{now:NOW,fetcher,generate:async()=>{throw Error('must not call model');}}));
    assert.equal(db.sqlite.prepare('SELECT status FROM aura_daily_news').get().status,'failed');
    assert.equal(messages.length,0);
    assert.equal((await runDailyNews(env,{now:NOW,fetcher,generate:async()=>output})).status,'already-claimed');
  }finally{db.close();}
});
test('publisher content is untrusted input and never includes personal tasks or recipient',async()=>{
  const {db,env}=await setup();const {fetcher}=network();
  try{
    await runDailyNews(env,{now:NOW,fetcher,generate:async payload=>{
      const text=payload.contents[0].parts[0].text;
      assert.match(text,/不可信來源/);assert.ok(!text.includes(env.TELEGRAM_BOT_TOKEN));
      assert.ok(!text.includes('owner_id'));assert.ok(!text.includes('chat_id'));return output;
    }});
  }finally{db.close();}
});
test('invalid model output falls back to source text without sending invalid content',async()=>{
  const {db,env}=await setup();const {fetcher,messages}=network();
  try{
    await runDailyNews(env,{now:NOW,fetcher,generate:async()=>'{"items":[{"index":999}]}'});
    assert.equal(messages.length,3);assert.match(messages[2].text,/未提供 AI 摘要/);
    assert.equal(db.sqlite.prepare('SELECT status FROM aura_daily_news_ai').get().status,'fallback');
  }finally{db.close();}
});
for(const fault of [{timeout:true},{badAck:true}])test('uncertain Telegram delivery is never automatically retried '+JSON.stringify(fault),async()=>{
  const {db,env}=await setup();const {fetcher,messages}=network(fault);
  try{
    await assert.rejects(runDailyNews(env,{now:NOW,fetcher,generate:async()=>output}),/needs review/);
    assert.equal(db.sqlite.prepare('SELECT status FROM aura_daily_news').get().status,'unknown');
    await runDailyNews(env,{now:NOW,fetcher,generate:async()=>output});assert.equal(messages.length,1);
  }finally{db.close();}
});
test('a lost receipt after delivery also stops the remaining messages',async()=>{
  const {db,env}=await setup();const {fetcher,messages}=network();
  db.sqlite.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE UPDATE OF sent_parts ON aura_daily_news BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  try{
    await assert.rejects(runDailyNews(env,{now:NOW,fetcher,generate:async()=>output}));
    assert.equal(messages.length,1);assert.equal(db.sqlite.prepare('SELECT status FROM aura_daily_news').get().status,'unknown');
  }finally{db.close();}
});
test('Telegram HTTP 200 with ok=false is not reported as delivery success',async()=>{
  await assert.rejects(sendNewsPart({ALLOWED_USER_ID:String(100),TELEGRAM_BOT_TOKEN:fixture('bot')},'test',async()=>Response.json({ok:false})));
});
test('default source-only mode needs no model key and cannot call the model',async()=>{
  const {db,env}=await setup(); const {fetcher,messages}=network();
  delete env.DAILY_NEWS_USE_AI;delete env.GEMINI_API_KEY;
  try{
    const result=await runDailyNews(env,{now:NOW,fetcher,generate:async()=>{throw Error('Model must not be called');}});
    assert.equal(result.status,'sent');assert.equal(messages.length,2);
    assert.match(messages[0].text,/未呼叫 AI/);assert.match(messages[1].text,/Synthetic publisher description/);
    assert.match(messages[1].text,/本模式未評估/);assert.ok(!messages[1].text.includes('AI 編輯評估'));
  }finally{db.close();}
});
test('only explicit string true enables AI; source-only manual preview needs no D1',async()=>{
  for(const value of [undefined,'false','TRUE',true,'1']){
    const {fetcher}=network();
    const parts=await buildNewsDigest({DAILY_NEWS_USE_AI:value},{now:NOW,fetcher,generate:async()=>{throw Error('must not call');}});
    assert.match(parts[0],/未呼叫 AI/);
  }
});

// Live staging run 2026-10-26: the model answered (448 in / 75 out tokens) but the digest was
// rejected with an unrecorded reason. The prompt never listed the exact category strings.
test('prompt lists every accepted category verbatim', async () => {
  const { newsPrompt } = await import('../src/daily-news.js');
  const text = newsPrompt([article]).contents[0].parts[0].text;
  for (const category of ['AI 模型與研究', '科技產品與發表會', 'AI 晶片與硬體']) assert.ok(text.includes('"' + category + '"'), category);
});
test('render failures carry a specific, non-sensitive reason code', () => {
  const cases = [
    ['not json', 'render-json'],
    [JSON.stringify({ items: 'x' }), 'render-shape'],
    [JSON.stringify({ items: [{ ...JSON.parse(output).items[0], index: 99 }] }), 'render-index'],
    [JSON.stringify({ items: [{ ...JSON.parse(output).items[0], category: 'AI 晶片硬體' }] }), 'render-category'],
    [JSON.stringify({ items: [{ ...JSON.parse(output).items[0], importance: '3' }] }), 'render-importance'],
    [JSON.stringify({ items: [{ ...JSON.parse(output).items[0], summary: 'https://x.invalid' }] }), 'render-text']
  ];
  for (const [raw, code] of cases) {
    assert.throws(() => renderNews(raw, collection, window), error => error.code === code, code);
  }
});
