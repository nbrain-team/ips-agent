/**
 * AgenticOrchestrator — the brain (Part 5.3).
 *
 * Modes:
 *  - TOOL_USE (default): multi-turn Claude tool-use loop (max 15 tool calls,
 *    1.5s cooldown between iterations, stop after 3 consecutive empty results).
 *    Intermediate "thinking" text is discarded; only the final turn streams.
 *  - PLAN: explicit action tasks (send email / create document / generate pdf /
 *    create task) — generate a JSON plan, execute steps, synthesize.
 *  - DEEP RESEARCH: decompose → research each sub-question → synthesize.
 *
 * Every Anthropic call is wrapped in withRetry + sanitizeAnthropicParams.
 * Data-source-agnostic: client identity lives in client-config.js.
 */
const Anthropic = require('@anthropic-ai/sdk');
const clientConfig = require('../config/client-config');
const agentFlags = require('../config/agentFlags');
const ModelRouter = require('./modelRouter');
const LongTermMemory = require('./longTermMemory');
const SmartDatabaseTool = require('../tools/smartDatabaseTool');
const deepResearch = require('./deepResearch');
const { analyzeQuery } = require('./queryAnalyzer');
const { validateOutput } = require('./outputValidators');
const { scoreResponse } = require('./confidenceScoring');
const { recordTrace } = require('./agentTrace');
const { withRetry, sanitizeAnthropicParams, isRetryable } = require('../utils/anthropicRetry');
const { llmHttpsAgent } = require('../utils/httpAgent');

const MAX_TOOL_CALLS = 15;
const MAX_CONSECUTIVE_EMPTY = 3;
const TOOL_LOOP_COOLDOWN_MS = 1500;
const HARD_TOKEN_CAP = 32000;

const PLAN_TRIGGERS = [
  /\bsend (an |a )?email\b/i,
  /\bcreate (a |an )?(document|doc|proposal|sow|report)\b/i,
  /\bgenerate (a |an )?pdf\b/i,
  /\bcreate (a |an )?task\b/i,
  /\bschedule (a |an )?meeting\b/i,
];

class AgenticOrchestrator {
  constructor(dbPool, toolRegistry, { billingDbPool = null } = {}) {
    this.dbPool = dbPool;
    this.billingDbPool = billingDbPool;
    this.toolRegistry = toolRegistry;
    this.modelRouter = new ModelRouter();
    this.memory = new LongTermMemory(dbPool, this.modelRouter);
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      httpAgent: llmHttpsAgent,
      maxRetries: 0,
    });
    this.model = clientConfig.AI_MODEL.primary;

    // Class-based tools get instantiated here and registered like object tools
    const smartDb = new SmartDatabaseTool(dbPool);
    this.toolRegistry.register(smartDb.asTool());
    if (billingDbPool) {
      const billingDb = new SmartDatabaseTool(billingDbPool, {
        sourceTag: 'billing',
        metadataPool: dbPool,
        name: 'query_billing_database',
        description: `Query the IPS Billing/accounting platform database (READ-ONLY) using natural language.

WHEN TO USE: any question about billing, invoices, invoicing, accounts receivable (AR), accounts payable (AP), payments, revenue, customers' balances, or accounting records.
Examples: "total invoiced last month", "which customers have unpaid invoices?", "revenue by customer this year".

Do NOT use for operational questions (jobs, crews, equipment, safety) — use query_operational_database for those.
Provide a natural-language query; table discovery and SQL generation are automatic.`,
      });
      this.toolRegistry.register(billingDb.asTool());
    }
  }

  // ==========================================================================
  // Entry point
  // ==========================================================================
  async processQuery({
    userMessage,
    conversationHistory = [],
    sessionId,
    userId,
    user = null, // { id, email, role } — used for permission-scoped tools (email)
    clientId = clientConfig.CLIENT_ID,
    projectId = null,
    streamCallback = () => {},
    imageAttachments = [],
    documentAttachments = [],
  }) {
    const startedAt = Date.now();

    // 1. Complexity → token budget
    const analysis = analyzeQuery(userMessage);
    streamCallback({ type: 'analysis', data: analysis });

    // 2. Output guidance (global + per-user output templates)
    const outputGuidance = await this.getOutputGuidance(userId).catch(() => '');

    const context = {
      userMessage, conversationHistory, sessionId, userId, user, clientId, projectId,
      streamCallback, imageAttachments, documentAttachments,
      analysis, outputGuidance, startedAt,
    };

    // 3. Route
    try {
      if (this.isLegacyPlanQuery(userMessage)) {
        return await this.processWithPlan(context);
      }
      if (agentFlags.deepResearchEnabled() && deepResearch.shouldTrigger(userMessage)) {
        return await this.processDeepResearch(context);
      }
      return await this.processWithToolUse(context);
    } catch (err) {
      console.error('Orchestrator error:', err);
      const status = err?.status || err?.statusCode;
      const retryable = isRetryable(err);
      const friendly =
        status === 429 || status === 529
          ? 'The AI service is at capacity right now.'
          : retryable
            ? 'A temporary connection issue interrupted the response.'
            : `Something went wrong: ${err.message}`;
      streamCallback({
        type: 'error',
        data: { error: friendly, errorType: status === 429 ? 'rate_limit' : 'server', retryable, retryAfterSec: retryable ? 15 : undefined },
      });
      return { success: false, error: friendly, retryable };
    }
  }

  isLegacyPlanQuery(message) {
    return PLAN_TRIGGERS.some((p) => p.test(String(message)));
  }

  // ==========================================================================
  // TOOL_USE mode — the workhorse
  // ==========================================================================
  async processWithToolUse(ctx) {
    const {
      userMessage, conversationHistory, sessionId, userId,
      streamCallback, imageAttachments, documentAttachments, analysis, startedAt,
    } = ctx;

    // Long-term memory recall (flag-gated, best-effort)
    let memories = [];
    if (agentFlags.memoryEnabled() && userId) {
      memories = await this.memory.recall(userId, userMessage);
    }

    const systemPrompt = this.buildToolUseSystemPrompt({ memories, outputGuidance: ctx.outputGuidance });
    const tools = this.toolRegistry.getToolSchemas();
    const maxTokens = Math.min(analysis.token_allocation, HARD_TOKEN_CAP);

    // Build message list: history + current message (with vision/doc blocks)
    const messages = conversationHistory
      .slice(-20)
      .filter((m) => m.content)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));

    const userContent = [];
    for (const img of imageAttachments || []) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      });
    }
    let messageText = userMessage;
    if (documentAttachments?.length) {
      const docBlocks = documentAttachments
        .map((d) => `\n\n=== ATTACHED DOCUMENT: ${d.filename} ===\n${String(d.text).slice(0, 40000)}`)
        .join('');
      messageText = `${userMessage}${docBlocks}`;
    }
    userContent.push({ type: 'text', text: messageText || '(see attachments)' });
    messages.push({ role: 'user', content: userContent });

    // ---- Multi-turn tool-use loop ----
    let toolCallCount = 0;
    let consecutiveEmpty = 0;
    let tokensUsed = 0;
    const toolResults = [];
    const sources = [];
    let finalText = '';
    let iteration = 0;

    while (true) {
      iteration++;
      const isFirstIteration = iteration === 1;

      const params = sanitizeAnthropicParams({
        model: this.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        tools,
      });

      // Stream every turn's text; if the model then decides to call tools we
      // discard what we streamed via a reset event? No — we buffer: only
      // stream when we know it's the final turn. Strategy: stream tokens
      // live, and if the turn ends in tool_use, emit nothing further from
      // that turn (its text was "thinking" — suppress by buffering).
      const { response, streamedText } = await this._streamTurn(params, streamCallback, {
        // Only stream live if this could plausibly be the final answer:
        // we optimistically stream and reset if tool_use follows.
        allowStreaming: true,
      });
      tokensUsed += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

      if (response.stop_reason === 'tool_use' && toolCallCount < MAX_TOOL_CALLS) {
        // Discard intermediate thinking text (Part 14)
        if (streamedText) streamCallback({ type: 'response_reset', data: {} });

        messages.push({ role: 'assistant', content: response.content });
        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        const resultBlocks = [];

        for (const tu of toolUses) {
          toolCallCount++;
          streamCallback({
            type: 'progress',
            data: { step: toolCallCount, total: MAX_TOOL_CALLS, tool: tu.name, status: 'running' },
          });
          const tool = this.toolRegistry.get(tu.name);
          let result;
          if (!tool) {
            result = { success: false, error: `Unknown tool: ${tu.name}` };
          } else {
            try {
              result = await tool.execute(tu.input, {
                userId, clientId: ctx.clientId, projectId: ctx.projectId, sessionId, dbPool: this.dbPool,
                userEmail: ctx.user?.email, userRole: ctx.user?.role,
              });
            } catch (err) {
              result = { success: false, error: err.message };
            }
          }
          toolResults.push({ tool: tu.name, success: !!result.success, confidence: result.confidence });

          if (result.success && result.source_type) {
            sources.push({
              type: result.source_type,
              tool: tu.name,
              confidence: result.confidence ?? null,
              summary: result.source_summary || null,
            });
          }

          const isEmpty =
            !result.success ||
            (result.data &&
              ((Array.isArray(result.data) && result.data.length === 0) ||
                result.data.rowCount === 0 ||
                result.data.count === 0));
          consecutiveEmpty = isEmpty ? consecutiveEmpty + 1 : 0;

          streamCallback({
            type: result.success ? 'tool_result' : 'tool_error',
            data: {
              step: toolCallCount,
              tool: tu.name,
              success: !!result.success,
              summary: result.success
                ? (result.summary || `Returned ${result.data?.rowCount ?? 'results'}`)
                : undefined,
              error: result.success ? undefined : result.error,
            },
          });

          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result.success ? (result.formatted || result.data || result) : { error: result.error }).slice(0, 60000),
            is_error: !result.success,
          });
        }

        messages.push({ role: 'user', content: resultBlocks });

        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          // Force a final answer describing what was tried
          messages.push({
            role: 'user',
            content:
              '[SYSTEM: Several consecutive tool calls returned no results. STOP calling tools now. Tell the user what you tried, what came back empty, and present any partial results you did find.]',
          });
        }

        // Cooldown between iterations to avoid rate-limit exhaustion (Part 14)
        await new Promise((r) => setTimeout(r, TOOL_LOOP_COOLDOWN_MS));
        continue;
      }

      // Final turn — its text is the answer
      finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!streamedText) {
        // Text wasn't streamed live (retry path) — emit it now
        streamCallback({ type: 'response_chunk', data: { content: finalText } });
      }
      break;
    }

    return this._finalizeTurn(ctx, {
      mode: 'tool_use',
      finalText, toolResults, sources, tokensUsed, toolCallCount, memories,
      streamCallback, startedAt,
    });
  }

  /**
   * Stream one Anthropic turn. Emits response_chunk events for text deltas.
   * Retries transient connection drops ONLY if no text has been emitted yet.
   */
  async _streamTurn(params, streamCallback, { allowStreaming = true } = {}) {
    let attempts = 0;
    while (true) {
      attempts++;
      let streamedText = '';
      try {
        const stream = this.anthropic.messages.stream(params);
        stream.on('text', (delta) => {
          streamedText += delta;
          if (allowStreaming) streamCallback({ type: 'response_chunk', data: { content: delta } });
        });
        const response = await stream.finalMessage();
        return { response, streamedText };
      } catch (err) {
        const canRetry = isRetryable(err) && streamedText.length === 0 && attempts < 4;
        if (!canRetry) throw err;
        const delay = Math.min(3000 * attempts, 15000);
        console.warn(`Stream attempt ${attempts} failed (${err.message}); retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // ==========================================================================
  // PLAN mode — explicit action tasks
  // ==========================================================================
  async processWithPlan(ctx) {
    const { userMessage, streamCallback, startedAt } = ctx;

    const plan = await this.generateExecutionPlan(userMessage);
    streamCallback({ type: 'plan', data: { ...plan, mode: 'plan' } });

    const stepResults = [];
    const toolResults = [];
    const sources = [];
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      streamCallback({
        type: 'progress',
        data: { step: i + 1, total: plan.steps.length, tool: step.tool, status: 'running' },
      });
      const tool = this.toolRegistry.get(step.tool);
      let result;
      if (!tool) {
        result = { success: false, error: `Unknown tool: ${step.tool}` };
      } else {
        try {
          result = await tool.execute(step.input || {}, {
            userId: ctx.userId, clientId: ctx.clientId, projectId: ctx.projectId,
            sessionId: ctx.sessionId, dbPool: this.dbPool,
            userEmail: ctx.user?.email, userRole: ctx.user?.role,
          });
        } catch (err) {
          result = { success: false, error: err.message };
        }
      }
      toolResults.push({ tool: step.tool, success: !!result.success, confidence: result.confidence });
      if (result.success && result.source_type) {
        sources.push({ type: result.source_type, tool: step.tool, confidence: result.confidence ?? null });
      }
      stepResults.push({ step, result });
      streamCallback({
        type: result.success ? 'tool_result' : 'tool_error',
        data: { step: i + 1, tool: step.tool, success: !!result.success, summary: result.summary, error: result.error },
      });
    }

    const finalText = await this.synthesizeResponse(userMessage, plan, stepResults);
    streamCallback({ type: 'response_chunk', data: { content: finalText } });

    return this._finalizeTurn(ctx, {
      mode: 'plan',
      finalText, toolResults, sources,
      tokensUsed: 0, toolCallCount: toolResults.length,
      memories: [], plan, streamCallback, startedAt,
    });
  }

  async generateExecutionPlan(userMessage) {
    const toolList = this.toolRegistry
      .getAll()
      .map((t) => `- ${t.name}: ${String(t.description || '').split('\n')[0]}`)
      .join('\n');
    const params = sanitizeAnthropicParams({
      model: this.model,
      max_tokens: 1500,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: `Create an execution plan for this request: "${userMessage}"

AVAILABLE TOOLS:
${toolList}

Return ONLY JSON: {"goal": "...", "steps": [{"tool": "tool_name", "description": "...", "input": {...}}]}. 1-5 steps.`,
        },
      ],
    });
    const res = await withRetry(() => this.anthropic.messages.create(params), { label: 'plan-gen' });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { goal: userMessage, steps: [] };
    try {
      const plan = JSON.parse(match[0]);
      plan.steps = Array.isArray(plan.steps) ? plan.steps.slice(0, 5) : [];
      return plan;
    } catch (_e) {
      return { goal: userMessage, steps: [] };
    }
  }

  async synthesizeResponse(userMessage, plan, stepResults) {
    const resultsBlock = stepResults
      .map(
        (sr, i) =>
          `STEP ${i + 1} (${sr.step.tool}): ${sr.result.success ? 'OK' : 'FAILED'}\n${JSON.stringify(sr.result.data || sr.result.error || {}).slice(0, 4000)}`
      )
      .join('\n\n');
    const { text } = await this.modelRouter.generateText({
      taskType: 'synthesis',
      maxTokens: 4000,
      system: clientConfig.getSystemPrompt('orchestrator_base'),
      prompt: `The user asked: "${userMessage}"\n\nAn execution plan ran with these results:\n${resultsBlock}\n\nWrite the final response to the user. Confirm what was done, surface any failures honestly, and include relevant details.`,
    });
    return text;
  }

  // ==========================================================================
  // DEEP RESEARCH mode
  // ==========================================================================
  async processDeepResearch(ctx) {
    const { userMessage, streamCallback, startedAt } = ctx;

    const subQuestions = await deepResearch.decompose(this.modelRouter, userMessage);
    streamCallback({
      type: 'plan',
      data: {
        mode: 'deep_research',
        goal: userMessage,
        steps: subQuestions.map((q, i) => ({ tool: 'research', description: q, step: i + 1 })),
      },
    });

    const toolResults = [];
    const sources = [];
    const findings = [];

    // Research sub-questions sequentially (each is itself a tool loop) to
    // stay under rate limits; parallelism trades reliability for speed here.
    for (let i = 0; i < subQuestions.length; i++) {
      streamCallback({
        type: 'progress',
        data: { step: i + 1, total: subQuestions.length, tool: 'research', status: `Researching: ${subQuestions[i]}` },
      });
      const sub = await this._researchSubQuestion(subQuestions[i], ctx, toolResults, sources);
      findings.push({ question: subQuestions[i], answer: sub });
      streamCallback({
        type: 'tool_result',
        data: { step: i + 1, tool: 'research', success: true, summary: `Completed: ${subQuestions[i]}` },
      });
    }

    // Synthesize
    const findingsBlock = findings
      .map((f, i) => `### Sub-question ${i + 1}: ${f.question}\n${f.answer}`)
      .join('\n\n');
    const params = sanitizeAnthropicParams({
      model: this.model,
      max_tokens: HARD_TOKEN_CAP,
      system: this.buildToolUseSystemPrompt({ memories: [], outputGuidance: ctx.outputGuidance }),
      messages: [
        {
          role: 'user',
          content: `Original research request: "${userMessage}"\n\nResearch findings:\n\n${findingsBlock}\n\nSynthesize a comprehensive, well-structured final answer. Use artifacts for any charts/diagrams that help.`,
        },
      ],
    });
    const { response } = await this._streamTurn(params, streamCallback, { allowStreaming: true });
    const finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

    return this._finalizeTurn(ctx, {
      mode: 'deep_research',
      finalText, toolResults, sources,
      tokensUsed: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      toolCallCount: toolResults.length,
      memories: [], subQuestions, streamCallback, startedAt,
    });
  }

  /** A bounded mini tool-loop for one sub-question (max 5 tool calls, no streaming). */
  async _researchSubQuestion(question, ctx, toolResults, sources) {
    const tools = this.toolRegistry.getToolSchemas();
    const messages = [{ role: 'user', content: question }];
    let calls = 0;

    while (calls < 5) {
      const params = sanitizeAnthropicParams({
        model: this.model,
        max_tokens: 4000,
        system: this.buildToolUseSystemPrompt({ memories: [], outputGuidance: '' }),
        messages,
        tools,
      });
      const response = await withRetry(() => this.anthropic.messages.create(params), { label: 'deep-research' });

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        const resultBlocks = [];
        for (const tu of response.content.filter((b) => b.type === 'tool_use')) {
          calls++;
          const tool = this.toolRegistry.get(tu.name);
          let result;
          try {
            result = tool
              ? await tool.execute(tu.input, {
                  userId: ctx.userId, clientId: ctx.clientId, projectId: ctx.projectId,
                  sessionId: ctx.sessionId, dbPool: this.dbPool,
                  userEmail: ctx.user?.email, userRole: ctx.user?.role,
                })
              : { success: false, error: `Unknown tool: ${tu.name}` };
          } catch (err) {
            result = { success: false, error: err.message };
          }
          toolResults.push({ tool: tu.name, success: !!result.success, confidence: result.confidence });
          if (result.success && result.source_type) {
            sources.push({ type: result.source_type, tool: tu.name, confidence: result.confidence ?? null });
          }
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result.success ? (result.formatted || result.data || result) : { error: result.error }).slice(0, 40000),
            is_error: !result.success,
          });
        }
        messages.push({ role: 'user', content: resultBlocks });
        await new Promise((r) => setTimeout(r, TOOL_LOOP_COOLDOWN_MS));
        continue;
      }
      return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    return '(sub-question research hit its tool-call limit; partial findings above)';
  }

  // ==========================================================================
  // Shared finalization: confidence, validators, persistence, trace, memory
  // ==========================================================================
  async _finalizeTurn(ctx, state) {
    const {
      mode, finalText, toolResults, sources, tokensUsed, toolCallCount,
      memories, plan = null, subQuestions = [], startedAt,
    } = state;
    const { sessionId, userId, userMessage, analysis } = ctx;

    const confidence = scoreResponse({ responseText: finalText, toolResults, sources });

    let validation = null;
    if (agentFlags.validatorsEnabled()) {
      validation = validateOutput(finalText, { toolCallCount, sources });
    }

    // Persist user + assistant messages
    let assistantMessageId = null;
    try {
      await this.dbPool.query(
        `INSERT INTO agent_chat_messages (session_id, role, content, created_at) VALUES ($1, 'user', $2, NOW())`,
        [sessionId, userMessage]
      );
      const saved = await this.dbPool.query(
        `INSERT INTO agent_chat_messages
           (session_id, role, content, model_used, tokens_used, plan_json, tool_calls, sources, complexity_level, confidence_score)
         VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          sessionId, finalText, this.model, tokensUsed,
          plan ? JSON.stringify(plan) : null,
          JSON.stringify(toolResults),
          JSON.stringify(sources),
          analysis.complexity,
          confidence,
        ]
      );
      assistantMessageId = saved.rows[0].id;
      await this.dbPool.query(`UPDATE agent_chat_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
    } catch (err) {
      console.warn('Message persistence failed:', err.message);
    }

    const processingTime = Date.now() - startedAt;

    // Observability trace (flag-gated, best-effort)
    if (agentFlags.traceEnabled()) {
      recordTrace(this.dbPool, {
        sessionId, userId, mode, userMessage,
        subQuestions,
        toolsUsed: toolResults,
        memoryHits: memories.length,
        validatorIssues: validation?.issues || [],
        confidenceScore: confidence,
        tokensUsed,
        latencyMs: processingTime,
      });
    }

    // Durable memory extraction (async, best-effort)
    if (agentFlags.memoryEnabled() && userId) {
      this.memory.extract(userId, userMessage, finalText).catch(() => {});
    }

    return {
      success: true,
      response: finalText,
      assistantMessageId,
      plan,
      sources,
      tokensUsed,
      complexity: analysis.complexity,
      confidence,
      validation,
      processingTime,
      mode,
    };
  }

  // ==========================================================================
  // Prompt assembly
  // ==========================================================================
  buildToolUseSystemPrompt({ memories = [], outputGuidance = '' } = {}) {
    const parts = [clientConfig.getSystemPrompt('orchestrator_base')];

    if (memories.length) {
      parts.push(
        `WHAT YOU REMEMBER ABOUT THIS USER (from previous sessions):\n${memories
          .map((m) => `- [${m.memory_type}] ${m.content}`)
          .join('\n')}`
      );
    }

    if (outputGuidance) {
      parts.push(`OUTPUT FORMAT GUIDANCE (apply when relevant):\n${outputGuidance}`);
    }

    // AVAILABLE DATA — reflects what is actually wired today (Part 11).
    const dataLines = [
      'AVAILABLE DATA:',
      '- query_operational_database → the AI platform Postgres. Contains meeting_transcripts (Read.ai meetings: title, dates, participants, summaries, action items, full transcript text).',
    ];
    if (this.billingDbPool) {
      dataLines.push(
        `- query_billing_database → the IPS Billing platform (READ-ONLY). This holds nearly ALL IPS business data:
  • Field tickets & billing: ips_cb.field_tickets, ips_cb.field_ticket_lines, ips_cb.invoices (SAP doc numbers, PO/AFE, totals, paid status), ips_cb.exceptions (AI-classified billing exceptions), ips_cb.customers (SAP card codes, portal type e.g. Ariba)
  • Fleet/GPS (Motive): ips_cb.motive_driving_periods (vehicle_unit, driver_name, origins/destinations, miles), ips_cb.gps_snapshots
  • Payroll/time (Paycom): paycom_time_entries, ips_cb.payroll_dsr_truth (GPS vs DSR minutes by crew/day)
  • Safety (KPA): ips_cb.jsa_records (job sites, hazards, PPE, employees)
  • People/crews: ips_cb.persons, ips_cb.crews, ips_cb.crew_members, ips_cb.employee_vehicle_map`
      );
      dataLines.push(
        'ROUTING: field tickets, invoices, billing, customers, fleet/Motive/vehicles, payroll/Paycom/hours, safety/JSA, crews → query_billing_database. Meeting/transcript questions → search the knowledge base (hybrid_search) first, or query_operational_database meeting_transcripts for date/participant filters.'
      );
    }
    dataLines.push('- hybrid_search / vector_search → the IPS knowledge base (ipsaecorp.com content, meeting transcripts, uploaded documents).');
    dataLines.push('- search_user_emails → the asking user\'s synced Microsoft 365 email (admins can search all mailboxes).');
    parts.push(dataLines.join('\n'));

    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    parts.push(`CURRENT DATE: ${today}`);

    return parts.join('\n\n');
  }

  /** Matches active output templates (global + per-user format rules). */
  async getOutputGuidance(userId) {
    const res = await this.dbPool.query(
      `SELECT name, instructions FROM agent_output_templates
       WHERE is_active = true AND (user_id IS NULL OR user_id = $1)
       ORDER BY user_id NULLS FIRST`,
      [userId || null]
    );
    if (!res.rows.length) return '';
    return res.rows.map((r) => `[${r.name}] ${r.instructions}`).join('\n');
  }
}

module.exports = AgenticOrchestrator;
