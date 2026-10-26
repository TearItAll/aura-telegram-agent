// Local workerd + simulated D1 only; never deploy this inline harness.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { newsWindow, NEWS_SOURCES } from '../src/daily-news.js';
const require = createRequire(import.meta.url);
process.env.MINIFLARE_WORKERD_PATH = require('workerd').default;
const root=fileURLToPath(new URL('../',import.meta.url));
const now=Date.parse('2026-10-26T09:00:00+08:00');
let feedDate=newsWindow(now).start+3600000, failFeeds=false, badAck=false;
const messages=[];
const output=JSON.stringify({items:[{index:0,category:'AI 模型與研究',summary:'合成研究摘要',difference:'來源摘要未提供可核對的技術比較',importance:3}]});
const fixture=name=>'synthetic-'+name;
const mf=new Miniflare({
  compatibilityDate:'2026-10-19',modulesRoot:root,host:'127.0.0.1',port:0,cf:false,log:new Log(LogLevel.ERROR),
  modules:[{type:'ESModule',path:root+'/news-local-harness.mjs',contents:`
    import {runDailyNews,collectNews,newsWindow} from './src/daily-news.js';
    export default {async fetch(request,env){const input=await request.json();try{
      if(input.inspect)return Response.json(await collectNews(newsWindow(input.now)));
      return Response.json(await runDailyNews({...env,DAILY_NEWS_ENABLED:input.disabled?'false':'true',DAILY_NEWS_USE_AI:input.noAI?'false':'true',GEMINI_API_KEY:input.noAI?undefined:env.GEMINI_API_KEY},
        {now:input.now,generate:async()=>{if(input.noAI)throw Error('AI must not run');return input.invalid?'invalid':${JSON.stringify(output)};}}));
    }catch(error){return Response.json({status:'failed',diagnostic:error.message},{status:500});}}};`
  },{type:'ESModule',path:root+'/src/daily-news.js',contents:await readFile(new URL('../src/daily-news.js',import.meta.url),'utf8')},{type:'ESModule',path:root+'/src/news-ai.js',contents:await readFile(new URL('../src/news-ai.js',import.meta.url),'utf8')}],
  d1Databases:{AURA_TASKS_DB:'local-news-only'},
  bindings:{ALLOWED_USER_ID:String(100),TELEGRAM_BOT_TOKEN:fixture('bot'),GEMINI_API_KEY:fixture('model'),DAILY_NEWS_USE_AI:'true',DAILY_NEWS_AI_FREE_VERIFIED:'true'},
  outboundService:async request=>{
    const url=new URL(request.url);
    if(NEWS_SOURCES.some(s=>s.feed===url.href)){
      if(failFeeds)return new Response('unavailable',{status:503});
      return new Response(url.hostname==='openai.com'?`<rss><channel><item><title>Synthetic AI</title><link>https://openai.com/index/synthetic</link><pubDate>${new Date(feedDate).toUTCString()}</pubDate><description>Test</description></item></channel></rss>`:'<rss><channel></channel></rss>');
    }
    assert.equal(url.hostname,'api.telegram.org');messages.push(await request.json());
    return Response.json(badAck?{ok:false}:{ok:true,result:{message_id:messages.length}});
  }
});
try{
  const db=await mf.getD1Database('AURA_TASKS_DB');
  // D1 exec does not accept multiline SQL in all local versions; prepare preserves the statement.
  await db.prepare(await readFile(new URL('../migrations/0004_daily_news.sql',import.meta.url),'utf8')).run();
  await db.prepare(await readFile(new URL('../migrations/0005_daily_news_ai_budget.sql',import.meta.url),'utf8')).run();
  const invoke=async(time,extra={})=>(await mf.dispatchFetch('https://local.test/news',{method:'POST',body:JSON.stringify({now:time,...extra})})).json();
  const results=await Promise.all(Array.from({length:8},()=>invoke(now)));
  if (!results.some(x=>x.status==='sent')) console.log(JSON.stringify({results,collection:await invoke(now,{inspect:true}),ledger:await db.prepare('SELECT status,total_parts,sent_parts FROM aura_daily_news').all(),messages:messages.length}));
  assert.equal(results.filter(x=>x.status==='sent').length,1);assert.equal(messages.length,2);
  let row=await db.prepare('SELECT status,sent_parts FROM aura_daily_news').first();
  assert.equal(row.status,'sent');assert.equal(row.sent_parts,2);
  assert.equal((await invoke(now+300000)).status,'already-claimed');assert.equal(messages.length,2);
  assert.equal((await invoke(now,{disabled:true})).status,'disabled');
  assert.equal((await invoke(now-3600000)).status,'outside-window');
  failFeeds=true;
  await invoke(now+86400000);
  row=await db.prepare('SELECT status FROM aura_daily_news WHERE news_date=?').bind(newsWindow(now+86400000).date).first();
  assert.equal(row.status,'failed');assert.equal(messages.length,2);
  failFeeds=false;feedDate=newsWindow(now+2*86400000).start+3600000;
  // N3: the failed day is reported once, as the first message of the next digest.
  await invoke(now+2*86400000,{invalid:true});assert.equal(messages.length,6);
  assert.match(messages[2].text,new RegExp(newsWindow(now+86400000).date+'.*準備失敗'));
  row=await db.prepare('SELECT status FROM aura_daily_news WHERE news_date=?').bind(newsWindow(now+2*86400000).date).first();
  assert.equal(row.status,'sent');
  feedDate=newsWindow(now+3*86400000).start+3600000;badAck=true;
  await invoke(now+3*86400000);
  row=await db.prepare('SELECT status FROM aura_daily_news WHERE news_date=?').bind(newsWindow(now+3*86400000).date).first();
  assert.equal(row.status,'unknown');assert.equal(messages.length,7);
  await invoke(now+3*86400000);assert.equal(messages.length,7);
  badAck=false;feedDate=newsWindow(now+4*86400000).start+3600000;
  assert.equal((await invoke(now+4*86400000,{noAI:true})).status,'sent');
  assert.equal(messages.length,10);assert.match(messages[7].text,/傳送中斷：已確認送出 0\/\d+ 段/);
  assert.match(messages[8].text,/未呼叫 AI/);
  console.log(JSON.stringify({runtime:'workerd',compatibilityDate:'2026-10-19',checks:9,result:'passed',externalNetwork:false,cloudChanged:false}));
}finally{await mf.dispose();}
