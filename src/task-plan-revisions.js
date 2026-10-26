import { ActionError } from './task-plan-actions.js';

const TYPE = 'task.plan.revise';
const TTL = 600000;
// Same single integer-ms database clock as task-plan-actions.js (see comment there).
const NOW = "CAST(((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message = '修改預覽無效或資料已變更，請重新產生修改預覽。', code) {
  throw new ActionError(message, code);
}
// Same reason codes as task-plan-actions.js; only the code is ever logged.
const REJECTION_MESSAGES = {
  not_pending: '這份修改已取消或失效，請重新提出修改。',
  expired: '修改預覽已超過 10 分鐘，請重新提出修改。',
  data_changed: '主任務或步驟在預覽後已變更，這次沒有修改。請查看計畫後重新提出修改。',
  unknown: '未能確認修改成功，原因不明（可能是暫時性錯誤）。請先查看計畫；若沒有變更，' +
    '可在 10 分鐘內再傳一次同一個「確認修改計畫 修改ID」。'
};
function parentSnapshot(parent) {
  if (!parent || typeof parent.id !== 'string' || !parent.id ||
      typeof parent.title !== 'string' || !parent.title || parent.title.length > 200 ||
      !['todo', 'in_progress'].includes(parent.status) ||
      !['low', 'normal', 'high'].includes(parent.priority) ||
      typeof parent.updated_at !== 'string' || !parent.updated_at ||
      (parent.due_at != null && typeof parent.due_at !== 'string')) fail();
  return { title: parent.title, status: parent.status, priority: parent.priority,
    dueAt: parent.due_at ?? null, updatedAt: parent.updated_at };
}
function stepSnapshots(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10) {
    fail('修改計畫需有 1 至 10 個既有步驟；本次沒有建立修改預覽。');
  }
  const result = rows.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 200 ||
        !Number.isSafeInteger(row.step_order) || row.step_order < 0 || row.step_order > 100000 ||
        typeof row.title !== 'string' || !row.title || row.title.length > 150 ||
        !['todo', 'in_progress', 'done'].includes(row.status) ||
        typeof row.updated_at !== 'string' || !row.updated_at) fail();
    return { id: row.id, stepOrder: row.step_order, title: row.title,
      status: row.status, updatedAt: row.updated_at };
  }).sort((a, b) => a.stepOrder - b.stepOrder);
  if (new Set(result.map(x => x.id)).size !== result.length ||
      new Set(result.map(x => x.stepOrder)).size !== result.length) {
    fail('現有步驟編號不唯一，請先檢查計畫；本次沒有建立修改預覽。');
  }
  return result;
}
function normalizedRevision(snapshot, proposal) {
  if (!proposal || typeof proposal.summary !== 'string' ||
      !Array.isArray(proposal.renames) || !Array.isArray(proposal.additions) ||
      proposal.summary.length > 300 ||
      proposal.renames.length + proposal.additions.length < 1 ||
      proposal.renames.length + proposal.additions.length > 3 ||
      snapshot.length + proposal.additions.length > 10) fail();
  const renames = proposal.renames.map(item => {
    const original = snapshot.find(step => step.stepOrder === item?.stepOrder);
    if (!original || original.status !== 'todo' || typeof item.newTitle !== 'string') fail();
    const newTitle = item.newTitle.trim();
    if (!newTitle || newTitle.length > 150 || newTitle === original.title) fail();
    return { id: original.id, stepOrder: original.stepOrder,
      originalTitle: original.title, newTitle };
  });
  if (new Set(renames.map(x => x.id)).size !== renames.length) fail();
  const additions = proposal.additions.map(title => {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 150) fail();
    return title.trim();
  });
  return { summary: proposal.summary.trim(), renames, additions };
}
async function hash(text) {
  const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function validIdentity(owner, id) {
  if (!String(owner || '') || !UUID.test(id || '')) {
    fail('請複製預覽中的完整指令：「確認修改計畫 修改ID」或「取消修改計畫 修改ID」。');
  }
}
async function load(db, owner, id) {
  validIdentity(owner, id);
  const row = await db.prepare('SELECT * FROM aura_task_plan_revisions WHERE action_id = ? AND owner_id = ?')
    .bind(id.toLowerCase(), String(owner)).first();
  if (!row) fail('找不到屬於你的這份修改預覽，請重新提出修改。');
  if (row.action_type !== TYPE || typeof row.target_id !== 'string' ||
      typeof row.payload_json !== 'string' || row.payload_json.length > 16000 ||
      !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.expires_at) ||
      row.expires_at - row.created_at !== TTL ||
      row.payload_hash !== await hash(row.payload_json)) fail();
  let raw;
  try { raw = JSON.parse(row.payload_json); } catch { fail(); }
  if (!raw || raw.schemaVersion !== 1 || raw.type !== TYPE ||
      raw.ownerId !== String(owner) || raw.targetId !== row.target_id || !raw.parent || !Array.isArray(raw.snapshot)) fail();
  const parent = parentSnapshot({ id: row.target_id, title: raw.parent.title,
    status: raw.parent.status, priority: raw.parent.priority, due_at: raw.parent.dueAt,
    updated_at: raw.parent.updatedAt });
  const snapshot = stepSnapshots(raw.snapshot?.map(x => ({ id: x?.id, step_order: x?.stepOrder,
    title: x?.title, status: x?.status, updated_at: x?.updatedAt })));
  const revision = normalizedRevision(snapshot, raw.revision);
  const payload = { schemaVersion: 1, type: TYPE, ownerId: String(owner),
    targetId: row.target_id, parent, snapshot, revision };
  if (JSON.stringify(payload) !== row.payload_json) fail();
  return { row, payload };
}

// Field snapshots guard visible state; they do not provide an ABA-proof version counter.
function dataGuard(target, owner, parent, snapshot) {
  const steps = snapshot.map(() => '(id = ? AND step_order = ? AND title = ? AND status = ? AND updated_at = ?)').join(' OR ');
  return {
    sql: 'EXISTS (SELECT 1 FROM tasks WHERE id = ? AND chat_id = ? ' +
      'AND title = ? AND status = ? AND priority = ? AND due_at IS ? AND updated_at = ?) ' +
      'AND (SELECT COUNT(*) FROM task_steps WHERE task_id = ?) = ? ' +
      `AND (SELECT COUNT(*) FROM task_steps WHERE task_id = ? AND (${steps})) = ?`,
    values: [target, String(owner), parent.title, parent.status, parent.priority,
      parent.dueAt, parent.updatedAt, target, snapshot.length, target,
      ...snapshot.flatMap(x => [x.id, x.stepOrder, x.title, x.status, x.updatedAt]), snapshot.length]
  };
}
// One read that re-evaluates the confirmation guard condition by condition (see actions).
async function rejectionReason(db, row, owner, payload) {
  try {
    const data = dataGuard(row.target_id, owner, payload.parent, payload.snapshot);
    const check = await db.prepare(`SELECT status, (expires_at <= ${NOW} OR created_at > ${NOW}) AS expired, ` +
      `(${data.sql}) AS data_intact FROM aura_task_plan_revisions WHERE action_id = ? AND owner_id = ?`
    ).bind(...data.values, row.action_id, String(owner)).first();
    if (!check || check.status !== 'pending') return 'not_pending';
    if (check.expired) return 'expired';
    if (!check.data_intact) return 'data_changed';
  } catch {
    // Best effort only.
  }
  return 'unknown';
}
function receipt(row, payload, alreadyApplied) {
  return { actionId: row.action_id, title: payload.parent.title,
    renamed: payload.revision.renames.length, added: payload.revision.additions.length, alreadyApplied };
}
export async function createTaskPlanRevision(db, owner, task, rows, proposal) {
  if (!String(owner || '')) fail();
  const parent = parentSnapshot(task);
  const snapshot = stepSnapshots(rows);
  const revision = normalizedRevision(snapshot, proposal);
  const payload = JSON.stringify({ schemaVersion: 1, type: TYPE, ownerId: String(owner),
    targetId: task.id, parent, snapshot, revision });
  if (payload.length > 16000) fail();
  const actionId = crypto.randomUUID();
  const guard = dataGuard(task.id, owner, parent, snapshot);
  const cleanup = await db.prepare('DELETE FROM aura_task_plan_revisions WHERE expires_at <= ?')
    .bind(Date.now() - 86400000).run();
  if (!cleanup.success) throw new Error('RevisionCleanupFailed');
  const result = await db.prepare('INSERT INTO aura_task_plan_revisions ' +
    '(action_id, owner_id, action_type, target_id, payload_json, payload_hash, created_at, expires_at, status) ' +
    "SELECT ?, ?, ?, ?, ?, ?, clock.now_ms, clock.now_ms + ?, 'pending' " +
    `FROM (SELECT ${NOW} AS now_ms) AS clock WHERE ${guard.sql} RETURNING expires_at`
  ).bind(actionId, String(owner), TYPE, task.id, payload, await hash(payload), TTL, ...guard.values).all();
  if (!result.success || result.results?.length !== 1) fail('主任務或步驟已變更，沒有建立這份修改預覽，請重新提出修改。');
  return { actionId, title: parent.title, revision, expiresAt: result.results[0].expires_at };
}
export async function confirmTaskPlanRevision(db, owner, id) {
  const { row, payload } = await load(db, owner, id);
  if (row.status === 'succeeded') return receipt(row, payload, true);
  if (row.status !== 'pending') fail(REJECTION_MESSAGES.not_pending, 'not_pending');
  if (row.expires_at <= Date.now()) fail(REJECTION_MESSAGES.expired, 'expired');
  const data = dataGuard(row.target_id, owner, payload.parent, payload.snapshot);
  const guard = db.prepare('SELECT CASE WHEN EXISTS (SELECT 1 FROM aura_task_plan_revisions ' +
    "WHERE action_id = ? AND owner_id = ? AND action_type = ? AND target_id = ? AND status = 'pending' " +
    'AND payload_json = ? AND payload_hash = ? ' +
    `AND created_at <= ${NOW} AND expires_at > ${NOW}) AND ${data.sql} ` +
    "THEN 1 ELSE json('AURA_REVISION_REJECTED') END AS valid"
  ).bind(row.action_id, String(owner), TYPE, row.target_id, row.payload_json, row.payload_hash, ...data.values);
  const { renames, additions } = payload.revision;
  const maxOrder = Math.max(...payload.snapshot.map(x => x.stepOrder));
  const statements = [guard,
    ...renames.map(change => db.prepare('UPDATE task_steps SET title = ?, updated_at = CURRENT_TIMESTAMP ' +
      "WHERE id = ? AND task_id = ? AND status = 'todo' AND title = ?"
    ).bind(change.newTitle, change.id, row.target_id, change.originalTitle)),
    ...additions.map((title, n) => db.prepare('INSERT INTO task_steps (id,task_id,title,step_order) VALUES (?,?,?,?)')
      .bind(crypto.randomUUID(), row.target_id, title, maxOrder + n + 1)),
    db.prepare(`UPDATE aura_task_plan_revisions SET status = 'succeeded', completed_at = ${NOW} ` +
      "WHERE action_id = ? AND owner_id = ? AND status = 'pending'").bind(row.action_id, String(owner))];
  // A committed batch passed the pending guard in its own transaction, so it is this save.
  let committed = false;
  try {
    const results = await db.batch(statements);
    committed = results.length === statements.length && results.every(x => x.success);
    if (!committed || results.slice(1).some(x => x.meta?.changes !== 1)) throw new Error('RevisionBatchFailed');
  } catch {
    const latest = await load(db, owner, id);
    if (latest.row.status === 'succeeded') return receipt(latest.row, latest.payload, !committed);
    const code = await rejectionReason(db, row, owner, payload);
    fail(REJECTION_MESSAGES[code], code);
  }
  return receipt(row, payload, false);
}
export async function cancelTaskPlanRevision(db, owner, id) {
  const { row } = await load(db, owner, id);
  if (row.status !== 'pending') return { actionId: row.action_id, status: row.status };
  const result = await db.prepare(`UPDATE aura_task_plan_revisions SET status = CASE WHEN expires_at <= ${NOW} ` +
    `THEN 'expired' ELSE 'cancelled' END, completed_at = ${NOW} ` +
    "WHERE action_id = ? AND owner_id = ? AND status = 'pending'").bind(row.action_id, String(owner)).run();
  if (!result.success) throw new Error('RevisionCancellationFailed');
  const latest = await load(db, owner, id);
  return { actionId: latest.row.action_id, status: latest.row.status };
}
