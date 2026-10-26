// Test-only diagnostic: evaluates each ledger guard condition separately and returns
// booleans only (no payload, owner, task or action identifiers leave this function).
// Uses the same clock expression the module under test uses, passed in by the caller.
export function guardBreakdown(db, table, actionId, nowExpr) {
  return db.sqlite.prepare(
    `SELECT status = 'pending' AS pending, ` +
    `created_at <= ${nowExpr} AS not_future, expires_at > ${nowExpr} AS not_expired, ` +
    `expires_at - created_at = 600000 AS ttl_intact FROM ${table} WHERE action_id = ?`
  ).get(actionId);
}
