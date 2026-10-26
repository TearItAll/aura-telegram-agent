import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDatabase} from './helpers/sqlite-d1.mjs';
import {budgetNewsAI,callNewsModel,NEWS_INPUT_LIMIT,NEWS_OUTPUT_LIMIT} from '../src/news-ai.js';
const fixture=name=>'synthetic-'+name;
const payload={contents:[{role:'user',parts:[{text:'synthetic public news only'}]}]};
const window={date:'2026-10-25'};
const fallback=reason=>['source-only '+reason];
async function setup(){const db=await createDatabase();db.sqlite.exec(await readFile(new URL('../migrations/0005_daily_news_ai_budget.sql',import.meta.url),'utf8'));return {db,env:{AURA_TASKS_DB:db,ALLOWED_USER_ID:String(100),GEMINI_API_KEY:fixture('key'),DAILY_NEWS_AI_FREE_VERIFIED:'true'}};}
function provider({count=3000,status=200,finish='STOP',thought=false}={}){
  const calls=[];
  return {calls,fetcher:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});assert.equal(options.redirect,'manual');
    if(url.endsWith(':countTokens'))return Response.json({totalTokens:count});
    assert.equal(body.generationConfig.maxOutputTokens,NEWS_OUTPUT_LIMIT);
    if(status!==200)return new Response('private upstream error must not be exposed',{status});
    return Response.json({candidates:[{finishReason:finish,content:{parts:[{text:'private reasoning',thought:true},{text:'{"items":[]}'}]}}],usageMetadata:{promptTokenCount:3000,candidatesTokenCount:1200,thoughtsTokenCount:40,totalTokenCount:4240}});
  }};
}
test('token count enforces 6000 input and 2000 output, while ignoring model thoughts',async()=>{
  const {calls,fetcher}=provider();const result=await callNewsModel({GEMINI_API_KEY:fixture('key')},payload,fetcher);
  assert.equal(calls.length,2);assert.equal(result.text,'{"items":[]}');assert.equal(result.usage.total,4240);assert.equal(result.usage.thoughts,40);
  assert.equal(calls[0].body.contents[0].parts[0].text,payload.contents[0].parts[0].text);
});
test('oversized or missing count never starts generation',async()=>{
  for(const count of [NEWS_INPUT_LIMIT+1,null]){
    const p=provider({count});await assert.rejects(callNewsModel({GEMINI_API_KEY:fixture('key')},payload,p.fetcher));assert.equal(p.calls.length,1);
  }
});
test('429 and 5xx are not retried; errors contain no upstream body',async()=>{
  for(const status of [429,500]){
    const p=provider({status});await assert.rejects(callNewsModel({GEMINI_API_KEY:fixture('key')},payload,p.fetcher),error=>!error.message.includes('private upstream'));
    assert.equal(p.calls.length,2);
  }
});
test('truncation preserves observed usage and refuses incomplete JSON',async()=>{
  const p=provider({finish:'MAX_TOKENS'});
  await assert.rejects(callNewsModel({GEMINI_API_KEY:fixture('key')},payload,p.fetcher),error=>error.code==='generation-incomplete'&&error.usage.total===4240);
});
test('unverified billing never accesses budget storage or generation',async()=>{
  const parts=await budgetNewsAI({},window,payload,fallback,()=>[],async()=>{throw Error('must not run');});assert.match(parts[0],/free-tier-unverified/);
});
test('parallel manual and scheduled jobs share one daily attempt and cache results',async()=>{
  const {db,env}=await setup();let calls=0;const generate=async()=>{calls++;return {text:'valid',usage:{countedInput:2000,input:2000,candidates:900,thoughts:0,total:2900}};};
  try{
    const all=await Promise.all(Array.from({length:8},()=>budgetNewsAI(env,window,payload,fallback,()=>['digest'],generate)));
    assert.equal(calls,1);assert.ok(all.some(x=>x[0]==='digest'));
    assert.deepEqual(await budgetNewsAI(env,window,payload,fallback,()=>[],generate),['digest']);assert.equal(calls,1);
    const row=db.sqlite.prepare('SELECT * FROM aura_daily_news_ai').get();assert.equal(row.total_tokens,2900);assert.equal(row.status,'succeeded');
  }finally{db.close();}
});
test('quota exhaustion falls back once and cannot spend again that day',async()=>{
  const {db,env}=await setup();let calls=0;
  try{
    const generate=async()=>{calls++;throw Object.assign(Error('synthetic'),{code:'quota',usage:{countedInput:2000}});};
    assert.match((await budgetNewsAI(env,window,payload,fallback,()=>[],generate))[0],/quota/);
    await budgetNewsAI(env,window,payload,fallback,()=>[],generate);assert.equal(calls,1);
    const row=db.sqlite.prepare('SELECT * FROM aura_daily_news_ai').get();assert.equal(row.status,'fallback');assert.equal(row.total_tokens,null);
  }finally{db.close();}
});
test('absent migration fails closed without calling AI',async()=>{
  const {db,env}=await setup();db.sqlite.exec('DROP TABLE aura_daily_news_ai');
  try{assert.match((await budgetNewsAI(env,window,payload,fallback,()=>[],async()=>assert.fail('must not call')))[0],/budget-store/);}finally{db.close();}
});
test('lost usage receipt still consumes the daily claim',async()=>{
  const {db,env}=await setup();let calls=0;
  db.sqlite.exec("CREATE TRIGGER synthetic_receipt BEFORE UPDATE ON aura_daily_news_ai BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  try{
    const generate=async()=>{calls++;return {text:'valid',usage:{total:1000}};};
    await budgetNewsAI(env,window,payload,fallback,()=>['digest'],generate);
    await budgetNewsAI(env,window,payload,fallback,()=>['digest'],generate);
    assert.equal(calls,1);assert.equal(db.sqlite.prepare('SELECT status FROM aura_daily_news_ai').get().status,'claimed');
  }finally{db.close();}
});

test('a rejected digest records which check failed instead of a generic reason', async () => {
  const { db, env } = await setup();
  try {
    const parts = await budgetNewsAI(env, window, payload, fallback,
      () => { throw Object.assign(new Error('Invalid news citation'), { code: 'render-category' }); },
      async () => ({ text: '{"items":[]}', usage: { countedInput: 448, input: 448, candidates: 75, thoughts: null, total: 523 } }));
    assert.deepEqual(parts, ['source-only render-category']);
    const row = db.sqlite.prepare('SELECT status, reason, input_tokens, candidate_tokens FROM aura_daily_news_ai').get();
    assert.equal(row.status, 'fallback'); assert.equal(row.reason, 'render-category');
    assert.equal(row.input_tokens, 448); assert.equal(row.candidate_tokens, 75);
  } finally { db.close(); }
});
