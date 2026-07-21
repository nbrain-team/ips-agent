/**
 * create_task — record a follow-up task/reminder in agent_background_jobs.
 * ⚠️ TODO: wire to IPS's real task/FSM system once identified (Part 11
 * pattern 3: API-as-a-tool).
 */

module.exports = {
  name: 'create_task',
  description: `Create a follow-up task or reminder. Currently records the task in the platform's own task table (not yet integrated with an external IPS system).

WHEN TO USE: the user says "remind me", "create a task", "add a to-do", "follow up on".`,
  category: 'actions',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short task title.' },
      description: { type: 'string', description: 'Task details.' },
      due_date: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD).' },
    },
    required: ['title'],
  },
  async execute(params, context) {
    try {
      const res = await context.dbPool.query(
        `INSERT INTO agent_background_jobs (user_id, job_type, payload, status, run_at)
         VALUES ($1, 'user_task', $2, 'pending', $3)
         RETURNING id`,
        [
          context.userId || null,
          JSON.stringify({ title: params.title, description: params.description || '' }),
          params.due_date ? new Date(params.due_date) : null,
        ]
      );
      return {
        success: true,
        data: { taskId: res.rows[0].id, title: params.title, due: params.due_date || null },
        summary: `Task created: "${params.title}"`,
        confidence: 0.95,
        source_type: 'task_system',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
