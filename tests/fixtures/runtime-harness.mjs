// LOCAL TEST ENTRY ONLY. Never deploy this file or expose its helper routes.
// Production's Wrangler main remains worker.js, which has no __test route.
import worker from '../../worker.js';
import { createTaskPlanAction, confirmTaskPlanAction, cancelTaskPlanAction, ActionError } from '../../src/task-plan-actions.js';
import { createTaskPlanRevision, confirmTaskPlanRevision, cancelTaskPlanRevision } from '../../src/task-plan-revisions.js';

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/__test/revision') {
      const input = await request.json();
      try {
        let result;
        if (input.operation === 'preview') {
          const parent = await env.AURA_TASKS_DB.prepare('SELECT * FROM tasks WHERE id = ? AND chat_id = ?')
            .bind(input.taskId, String(input.owner)).first();
          const rows = await env.AURA_TASKS_DB.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_order,id')
            .bind(input.taskId).all();
          result = await createTaskPlanRevision(env.AURA_TASKS_DB, input.owner, parent, rows.results, input.proposal);
        } else if (input.operation === 'confirm') {
          result = await confirmTaskPlanRevision(env.AURA_TASKS_DB, input.owner, input.actionId);
        } else if (input.operation === 'cancel') {
          result = await cancelTaskPlanRevision(env.AURA_TASKS_DB, input.owner, input.actionId);
        } else return Response.json({ ok: false }, { status: 400 });
        return Response.json({ ok: true, result });
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof ActionError ? error.message : 'RuntimeTestError' }, { status: 409 });
      }
    }
    if (new URL(request.url).pathname !== '/__test/action') return worker.fetch(request, env, ctx);
    const input = await request.json();
    try {
      let result;
      if (input.operation === 'preview') {
        const parent = await env.AURA_TASKS_DB.prepare('SELECT * FROM tasks WHERE id = ? AND chat_id = ?')
          .bind(input.taskId, String(input.owner)).first();
        result = await createTaskPlanAction(env.AURA_TASKS_DB, input.owner, parent, input.steps);
      } else if (input.operation === 'confirm') {
        result = await confirmTaskPlanAction(env.AURA_TASKS_DB, input.owner, input.actionId);
      } else if (input.operation === 'cancel') {
        result = await cancelTaskPlanAction(env.AURA_TASKS_DB, input.owner, input.actionId);
      } else {
        return Response.json({ ok: false }, { status: 400 });
      }
      return Response.json({ ok: true, result });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof ActionError ? error.message : 'RuntimeTestError' }, { status: 409 });
    }
  }
};
