// News-only limits. Existing interactive Gemini behavior is deliberately untouched.
export const NEWS_MODEL = 'gemini-3.5-flash-lite';
export const NEWS_INPUT_LIMIT = 6000;
export const NEWS_OUTPUT_LIMIT = 2000;
function failure(code, usage = null) { return Object.assign(new Error('News AI unavailable'), { code, usage }); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
export async function callNewsModel(env, payload, fetcher = fetch) {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${NEWS_MODEL}`;
  const options = body => ({method:'POST',redirect:'manual',headers:{'Content-Type':'application/json','x-goog-api-key':env.GEMINI_API_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  let counted;
  try {
    const count = await fetcher(base + ':countTokens', options({contents:payload.contents}));
    if (!count.ok) throw failure(count.status === 429 ? 'quota' : 'count-failed');
    counted = integer((await count.json()).totalTokens);
    if (counted === null) throw failure('count-invalid');
    if (counted > NEWS_INPUT_LIMIT) throw failure('input-limit', {countedInput:counted});
  } catch (error) { throw failure(error.code || 'count-failed', error.usage); }
  // Exactly one generation attempt: never retry 429, 5xx or ambiguous timeouts.
  let response;
  try {
    response = await fetcher(base + ':generateContent', options({...payload,
      generationConfig:{responseMimeType:'application/json',temperature:0.1,maxOutputTokens:NEWS_OUTPUT_LIMIT}}));
  } catch { throw failure('generation-unknown', {countedInput:counted}); }
  if (!response.ok) throw failure(response.status === 429 ? 'quota' : 'generation-failed', {countedInput:counted});
  let data;
  try { data = await response.json(); } catch { throw failure('generation-invalid', {countedInput:counted}); }
  const meta = data.usageMetadata || {};
  const usage = {countedInput:counted,input:integer(meta.promptTokenCount),
    candidates:integer(meta.candidatesTokenCount),thoughts:integer(meta.thoughtsTokenCount),total:integer(meta.totalTokenCount)};
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason !== 'STOP') throw failure('generation-incomplete', usage);
  const text = (candidate.content?.parts || []).filter(x => x.thought !== true && typeof x.text === 'string').map(x => x.text).join('').trim();
  if (!text) throw failure('generation-empty',usage);
  return {text,usage};
}
async function save(db, owner, date, status, reason, parts, usage) {
  const result=await db.prepare("UPDATE aura_daily_news_ai SET status=?, reason=?, parts_json=?, counted_input_tokens=?, input_tokens=?, candidate_tokens=?, thought_tokens=?, total_tokens=?, updated_at=CURRENT_TIMESTAMP WHERE owner_id=? AND news_date=? AND status='claimed'")
    .bind(status,reason,parts ? JSON.stringify(parts) : null,usage?.countedInput ?? null,usage?.input ?? null,
      usage?.candidates ?? null,usage?.thoughts ?? null,usage?.total ?? null,owner,date).run();
  if (!result.success || result.meta?.changes !== 1) throw failure('receipt-failed');
}
export async function budgetNewsAI(env, window, payload, fallback, render, generate) {
  if (env.DAILY_NEWS_AI_FREE_VERIFIED !== 'true') return fallback('free-tier-unverified');
  const db=env.AURA_TASKS_DB, owner=String(env.ALLOWED_USER_ID || '');
  if (!db || !/^\d{1,16}$/.test(owner) || !env.GEMINI_API_KEY) return fallback('configuration');
  try {
    const claim=await db.prepare("INSERT INTO aura_daily_news_ai(owner_id,news_date,model,status) VALUES(?,?,?,'claimed') ON CONFLICT(owner_id,news_date) DO NOTHING")
      .bind(owner,window.date,NEWS_MODEL).run();
    if (!claim.success) return fallback('budget-store-unavailable');
    if (claim.meta?.changes !== 1) {
      const cached=await db.prepare('SELECT status,parts_json FROM aura_daily_news_ai WHERE owner_id=? AND news_date=?').bind(owner,window.date).first();
      if (cached?.status==='succeeded') {
        const parts=JSON.parse(cached.parts_json);
        if (Array.isArray(parts) && parts.length>0 && parts.length<=7 && parts.every(x=>typeof x==='string'&&x.length<=3500)) return parts;
      }
      return fallback('daily-attempt-used');
    }
  } catch { return fallback('budget-store-unavailable'); }
  let usage;
  try {
    const result=await generate(payload);
    usage=result?.usage;
    // String injection is supported for offline fixtures; live adapter always returns usage metadata.
    const parts=render(typeof result==='string' ? result : result.text);
    await save(db,owner,window.date,'succeeded',null,parts,usage);
    return parts;
  } catch (error) {
    const reason=['input-limit','quota','count-failed','count-invalid','generation-unknown','generation-failed','generation-invalid','generation-incomplete','generation-empty','receipt-failed'].includes(error.code) || /^render-[a-z]+$/.test(error.code || '') ? error.code : 'generation-or-receipt-failed';
    try { await save(db,owner,window.date,'fallback',reason,null,error.usage || usage); } catch { /* Claim remains consumed even if recording the result fails. */ }
    return fallback(reason);
  }
}
