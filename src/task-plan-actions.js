const TYPE = 'task.plan.create';
const TTL_MS = 10 * 60 * 1000;
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Single authoritative clock: the database, quantised to integer ms. created_at and
// expires_at are stamped with it and every expiry/future check reads it, so the
// Worker clock and float rounding of julianday() can no longer disagree.
// CAST (floor) is monotonic; ROUND is not safe here (it can round above a later read).
const DB_NOW = "CAST(((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

// code is one of a fixed set of reason codes (see REJECTION_MESSAGES) and is safe to log:
// it never carries payload, owner, task or action identifiers.
export class ActionError extends Error {
  constructor(message, code) {
    super(message);
    if (code) this.code = code;
  }
}

function fail(message = '計畫預覽無效或資料已變更，請重新規劃。', code) {
  throw new ActionError(message, code);
}

const REJECTION_MESSAGES = {
  not_pending: '這份計畫已取消或失效，請重新規劃。',
  expired: '這份計畫預覽已超過 10 分鐘，請重新規劃。',
  data_changed: '主任務或子任務在預覽後已變更，這次沒有儲存。請查看計畫後重新規劃。',
  unknown: '未能確認儲存成功，原因不明（可能是暫時性錯誤）。請先查看計畫；若沒有新增子任務，' +
    '可在 10 分鐘內再傳一次同一個「確認計畫 計畫ID」。'
};

// Re-evaluates the confirmation guard's conditions one by one with a single read, so a
// rejected batch can be explained. Order matters: a finished or expired preview is
// reported as such even if the task also changed.
async function rejectionReason(db, row, ownerId, p) {
  try {
    const check = await db.prepare(
      `SELECT status, (expires_at <= ${DB_NOW} OR created_at > ${DB_NOW}) AS expired, ` +
      'EXISTS (SELECT 1 FROM tasks WHERE id = ? AND chat_id = ? AND title = ? AND status = ? ' +
      'AND priority = ? AND due_at IS ? AND updated_at = ?) AS task_intact, ' +
      'EXISTS (SELECT 1 FROM task_steps WHERE task_id = ?) AS has_steps ' +
      'FROM aura_task_plan_actions WHERE action_id = ? AND owner_id = ?'
    ).bind(row.target_id, String(ownerId), p.title, p.status, p.priority, p.dueAt, p.updatedAt,
      row.target_id, row.action_id, String(ownerId)).first();
    if (!check || check.status !== 'pending') return 'not_pending';
    if (check.expired) return 'expired';
    if (!check.task_intact || check.has_steps) return 'data_changed';
  } catch {
    // The diagnosis is best effort; fall through to unknown.
  }
  return 'unknown';
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 10) fail();
  const titles = steps.map(step => typeof step === 'string' ? step.trim() : '');
  if (titles.some(title => !title || title.length > 150)) fail();
  return titles;
}

function parentSnapshot(parent) {
  if (!parent || typeof parent.id !== 'string' || !parent.id ||
      typeof parent.title !== 'string' || !parent.title || parent.title.length > 200 ||
      !['todo', 'in_progress'].includes(parent.status) ||
      !['low', 'normal', 'high'].includes(parent.priority) ||
      typeof parent.updated_at !== 'string' || !parent.updated_at ||
      (parent.due_at != null && typeof parent.due_at !== 'string')) fail();
  return {
    title: parent.title, status: parent.status, priority: parent.priority,
    dueAt: parent.due_at ?? null, updatedAt: parent.updated_at
  };
}

async function hashPayload(payload) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validIdentity(ownerId, actionId) {
  if (!String(ownerId || '') || !ID_PATTERN.test(actionId || '')) {
    fail('請複製預覽中完整的「確認計畫 計畫ID」或「取消計畫 計畫ID」。');
  }
}

async function loadAction(db, ownerId, actionId) {
  validIdentity(ownerId, actionId);
  const row = await db.prepare(
    'SELECT * FROM aura_task_plan_actions WHERE action_id = ? AND owner_id = ?'
  ).bind(actionId.toLowerCase(), String(ownerId)).first();
  if (!row) fail('找不到屬於你的這份計畫預覽，請重新規劃。');
  if (row.action_type !== TYPE || row.target_id == null ||
      typeof row.payload_json !== 'string' || row.payload_json.length > 12000 ||
      !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.expires_at) ||
      row.expires_at - row.created_at !== TTL_MS ||
      row.payload_hash !== await hashPayload(row.payload_json)) fail();
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { fail(); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.schemaVersion !== 1 || payload.type !== TYPE ||
      payload.ownerId !== String(ownerId) || payload.targetId !== row.target_id ||
      !payload.parent) fail();
  const steps = normalizeSteps(payload.steps);
  const parent = parentSnapshot({ id: row.target_id, title: payload.parent.title,
    status: payload.parent.status, priority: payload.parent.priority,
    due_at: payload.parent.dueAt, updated_at: payload.parent.updatedAt });
  // Enforce the same canonical representation used to build the user's preview.
  const canonical = JSON.stringify({ schemaVersion: 1, type: TYPE,
    ownerId: String(ownerId), targetId: row.target_id, parent, steps });
  if (canonical !== row.payload_json) fail();
  return { row, payload: { ...payload, parent, steps } };
}

function receipt(row, payload, alreadyApplied) {
  return { actionId: row.action_id, taskId: row.target_id,
    title: payload.parent.title, steps: payload.steps,
    count: payload.steps.length, alreadyApplied };
}

export async function pruneTaskPlanActions(db) {
  // Opportunistic cleanup only; an inactive service needs scheduled maintenance.
  const result = await db.prepare('DELETE FROM aura_task_plan_actions WHERE expires_at <= ?')
    .bind(Date.now() - RECEIPT_RETENTION_MS).run();
  if (!result.success) throw new Error('ActionCleanupFailed');
}

export async function createTaskPlanAction(db, ownerId, parent, steps) {
  if (!String(ownerId || '')) fail();
  const expected = parentSnapshot(parent);
  const titles = normalizeSteps(steps);
  const payload = JSON.stringify({ schemaVersion: 1, type: TYPE,
    ownerId: String(ownerId), targetId: parent.id, parent: expected, steps: titles });
  const actionId = crypto.randomUUID();
  const hash = await hashPayload(payload);
  await pruneTaskPlanActions(db);
  const result = await db.prepare(
    'INSERT INTO aura_task_plan_actions ' +
    '(action_id, owner_id, action_type, target_id, payload_json, payload_hash, created_at, expires_at, status) ' +
    "SELECT ?, ?, ?, ?, ?, ?, clock.now_ms, clock.now_ms + ?, 'pending' " +
    `FROM tasks, (SELECT ${DB_NOW} AS now_ms) AS clock ` +
    'WHERE id = ? AND chat_id = ? AND title = ? AND status = ? AND priority = ? ' +
    'AND due_at IS ? AND updated_at = ? ' +
    'AND NOT EXISTS (SELECT 1 FROM task_steps WHERE task_id = tasks.id) ' +
    'RETURNING expires_at'
  ).bind(actionId, String(ownerId), TYPE, parent.id, payload, hash, TTL_MS,
    parent.id, String(ownerId), expected.title, expected.status, expected.priority,
    expected.dueAt, expected.updatedAt).all();
  if (!result.success || result.results?.length !== 1) {
    fail('主任務或計畫已變更，這次沒有儲存預覽，請重新規劃。');
  }
  return { actionId, title: expected.title, steps: titles, expiresAt: result.results[0].expires_at };
}

export async function confirmTaskPlanAction(db, ownerId, actionId) {
  const { row, payload } = await loadAction(db, ownerId, actionId);
  if (row.status === 'succeeded') return receipt(row, payload, true);
  if (row.status !== 'pending') fail(REJECTION_MESSAGES.not_pending, 'not_pending');
  if (row.expires_at <= Date.now()) fail(REJECTION_MESSAGES.expired, 'expired');
  const p = payload.parent;
  const guard = db.prepare(
    'SELECT CASE WHEN EXISTS (SELECT 1 FROM aura_task_plan_actions ' +
    "WHERE action_id = ? AND owner_id = ? AND action_type = ? AND target_id = ? AND status = 'pending' " +
    'AND payload_hash = ? AND payload_json = ? ' +
    `AND created_at <= ${DB_NOW} AND expires_at > ${DB_NOW}) ` +
    'AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND chat_id = ? ' +
    'AND title = ? AND status = ? AND priority = ? AND due_at IS ? AND updated_at = ?) ' +
    'AND NOT EXISTS (SELECT 1 FROM task_steps WHERE task_id = ?) ' +
    "THEN 1 ELSE json('AURA_TASK_PLAN_REJECTED') END AS valid"
  ).bind(row.action_id, String(ownerId), TYPE, row.target_id, row.payload_hash, row.payload_json,
    row.target_id, String(ownerId), p.title, p.status, p.priority, p.dueAt, p.updatedAt, row.target_id);
  const statements = [guard, ...payload.steps.map((title, index) => db.prepare(
    'INSERT INTO task_steps (id, task_id, title, step_order) VALUES (?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), row.target_id, title, index + 1)), db.prepare(
    `UPDATE aura_task_plan_actions SET status = 'succeeded', completed_at = ${DB_NOW} ` +
    "WHERE action_id = ? AND owner_id = ? AND status = 'pending'"
  ).bind(row.action_id, String(ownerId))];
  // Set only when D1 reports every statement of this batch as successful. The guard
  // requires status = 'pending' inside the same transaction, so a committed batch is
  // this call's own save even if change counts are missing from the response.
  let committed = false;
  try {
    // D1 batch is one transaction: guard, all steps and authorization consumption.
    const results = await db.batch(statements);
    committed = results.length === statements.length && results.every(result => result.success);
    if (!committed || results.slice(1).some(result => result.meta?.changes !== 1)) {
      throw new Error('ActionBatchFailed');
    }
  } catch {
    // Concurrent confirmation / ambiguous transport outcome: reread the receipt.
    const latest = await loadAction(db, ownerId, actionId);
    if (latest.row.status === 'succeeded') return receipt(latest.row, latest.payload, !committed);
    const code = await rejectionReason(db, row, ownerId, p);
    fail(REJECTION_MESSAGES[code], code);
  }
  return receipt(row, payload, false);
}

export async function cancelTaskPlanAction(db, ownerId, actionId) {
  const { row } = await loadAction(db, ownerId, actionId);
  if (row.status !== 'pending') return { actionId: row.action_id, status: row.status };
  const result = await db.prepare(
    `UPDATE aura_task_plan_actions SET status = CASE WHEN expires_at <= ${DB_NOW} ` +
    `THEN 'expired' ELSE 'cancelled' END, completed_at = ${DB_NOW} ` +
    "WHERE action_id = ? AND owner_id = ? AND status = 'pending'"
  ).bind(row.action_id, String(ownerId)).run();
  if (!result.success) throw new Error('ActionCancellationFailed');
  const latest = await loadAction(db, ownerId, actionId);
  return { actionId: latest.row.action_id, status: latest.row.status };
}
