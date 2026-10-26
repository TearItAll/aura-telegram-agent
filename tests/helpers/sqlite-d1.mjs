import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

// Local SQLite execution with D1-shaped results and transactional batch behavior.
// This is NOT the Cloudflare runtime. Every SQL statement is actually executed.
// Julian day of the Unix epoch in ms (2440587.5 days), as SQLite's iJD uses.
const UNIX_EPOCH_JD_MS = 2440587.5 * 86400000;

export async function createDatabase({ uniqueSteps = true, dbClock = null } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  if (dbClock) {
    // Test-only database clock. Mirrors SQLite's own conversion (integer unix ms ->
    // julian day as a double), so float rounding of DB_NOW is reproduced, not hidden.
    sqlite.function('julianday', { deterministic: false }, arg => {
      if (arg !== 'now') throw new Error('Test clock only supports julianday(now)');
      return (dbClock() + UNIX_EPOCH_JD_MS) / 86400000;
    });
  }
  let schema = await readFile(new URL('../../examples/schema.local.sql', import.meta.url), 'utf8');
  if (!uniqueSteps) schema = schema.replace(',\n  UNIQUE (task_id, step_order)', '');
  sqlite.exec(schema);
  sqlite.exec(await readFile(new URL('../../migrations/0001_task_plan_actions.sql', import.meta.url), 'utf8'));
  sqlite.exec(await readFile(new URL('../../migrations/0002_task_plan_revisions.sql', import.meta.url), 'utf8'));
  sqlite.exec(await readFile(new URL('../../migrations/0003_task_plan_status_final.sql', import.meta.url), 'utf8'));
  sqlite.exec(await readFile(new URL('../../migrations/0006_telegram_updates.sql', import.meta.url), 'utf8'));
  const db = {
    sqlite,
    beforeBatch: null,
    prepare(sql) {
      function statement(values) {
        return { sql, values,
          bind(...next) { return statement(next); },
          async first() { return db.execute(sql, values, 'first'); },
          async all() { return db.execute(sql, values, 'all'); },
          async run() { return db.execute(sql, values, 'run'); }
        };
      }
      return statement([]);
    },
    execute(sql, values, mode) {
      const indexes = [];
      const normalized = sql.replace(/\?(\d+)/g, (_, index) => {
        indexes.push(Number(index) - 1);
        return '?';
      });
      const bindings = indexes.length ? indexes.map(index => values[index]) : values;
      const compiled = sqlite.prepare(normalized);
      if (mode === 'first') return compiled.get(...bindings) ?? null;
      if (mode === 'all') return { success: true, results: compiled.all(...bindings) };
      return { success: true, meta: { changes: Number(compiled.run(...bindings).changes) } };
    },
    async batch(statements) {
      const intercept = db.beforeBatch;
      db.beforeBatch = null;
      if (intercept) intercept();
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(stmt => db.execute(stmt.sql, stmt.values,
          /^\s*SELECT\b/i.test(stmt.sql) ? 'all' : 'run'));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    close() { sqlite.close(); }
  };
  return db;
}
