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

// NOTE: "send email" / "schedule meeting" triggers were removed — no such
// tools exist (no Graph Mail.Send / calendar-write permissions). Those
// requests now flow through TOOL_USE mode, where the agent drafts content.
const PLAN_TRIGGERS = [
  /\bcreate (a |an )?(document|doc|proposal|sow|report)\b/i,
  /\bgenerate (a |an )?pdf\b/i,
  /\bcreate (a |an )?task\b/i,
];

// Specialized agent modules (client-config SYSTEM_PROMPTS) routed by intent.
const MODULE_TRIGGERS = [
  { module: 'estimating_reviewer', pattern: /\b(bid|estimate|estimating|rfp|proposal review|review (this|the|our) (bid|proposal|sow|scope)|scope of work)\b/i },
  { module: 'qa_validator', pattern: /\b(validate|qa check|quality check|review (this|the) (content|draft|report|answer)|double-?check (this|the))\b/i },
  { module: 'email_drafter', pattern: /\b(draft|write|compose)( me)?( an?| the)? (email|reply|response to .{0,40}email)\b/i },
  { module: 'code_analyst', pattern: /\b(python|write (a )?script|analyze .{0,30}(csv|spreadsheet|data file))\b/i },
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
    this._feedbackCache = { at: 0, text: '' }; // approved-feedback guidance, cached

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
    conversationSummary = null, // rolling summary of turns older than the window
    isCancelled = () => false,  // server-side stop (client disconnected)
  }) {
    const startedAt = Date.now();

    // 1. Complexity → token budget
    const analysis = analyzeQuery(userMessage);
    streamCallback({ type: 'analysis', data: analysis });

    // 2. Output guidance (global + per-user output templates)
    const outputGuidance = await this.getOutputGuidance(userId).catch(() => '');

    // 3. Specialized agent module routing (estimating / QA / email / code)
    const agentModule = this.detectAgentModule(userMessage);

    const context = {
      userMessage, conversationHistory, sessionId, userId, user, clientId, projectId,
      streamCallback, imageAttachments, documentAttachments,
      analysis, outputGuidance, startedAt, conversationSummary, agentModule, isCancelled,
    };

    // 4. Route
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

  /** Match the message against specialized module triggers (first hit wins). */
  detectAgentModule(message) {
    const m = String(message || '');
    for (const { module, pattern } of MODULE_TRIGGERS) {
      if (pattern.test(m)) return module;
    }
    return null;
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

    // Approved feedback → standing guidance (flag-gated, cached, best-effort)
    let feedbackGuidance = '';
    if (agentFlags.feedbackLearningEnabled()) {
      feedbackGuidance = await this.getFeedbackGuidance().catch(() => '');
    }

    const systemPrompt = this.buildToolUseSystemPrompt({
      memories,
      outputGuidance: ctx.outputGuidance,
      feedbackGuidance,
      conversationSummary: ctx.conversationSummary,
      agentModule: ctx.agentModule,
    });
    const tools = this.toolRegistry.getToolSchemas();
    const maxTokens = Math.min(analysis.token_allocation, HARD_TOKEN_CAP);

    // Build message list: history + current message (with vision/doc blocks).
    // Recent assistant messages carry their structured tool results (SQL rows)
    // so follow-ups like "chart that" or "filter those" keep working.
    const recentAssistantWithData = conversationHistory
      .filter((m) => m.role === 'assistant' && m.structured_results)
      .slice(-2);
    const messages = conversationHistory
      .slice(-20)
      .filter((m) => m.content)
      .map((m) => {
        let content = String(m.content);
        if (m.role === 'assistant' && recentAssistantWithData.includes(m)) {
          try {
            const data = typeof m.structured_results === 'string'
              ? m.structured_results
              : JSON.stringify(m.structured_results);
            content += `\n\n[STRUCTURED DATA BEHIND THIS ANSWER — reuse for follow-ups instead of re-querying]\n${String(data).slice(0, 20000)}`;
          } catch (_e) { /* best-effort */ }
        }
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
      });

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
    const structuredResults = []; // retained SQL/table data for future turns
    let finalText = '';
    let iteration = 0;

    while (true) {
      iteration++;
      const isFirstIteration = iteration === 1;

      // Server-side stop: the client is gone — stop spending tokens now.
      if (ctx.isCancelled?.()) {
        return { success: false, cancelled: true, error: 'Stopped by user' };
      }

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
              // Grounded citation detail: SQL provenance / document links
              sql: result.data?.sql || null,
              tables: result.data?.tables || null,
              items: Array.isArray(result.data)
                ? result.data
                    .filter((d) => d && (d.url || d.title))
                    .slice(0, 6)
                    .map((d) => ({ title: d.title || d.url, url: d.url || null }))
                : null,
            });
          }

          // Retain structured rows so follow-up turns can reuse them
          if (result.success && result.data?.rows?.length) {
            structuredResults.push({
              tool: tu.name,
              sql: result.data.sql || null,
              tables: result.data.tables || null,
              rowCount: result.data.rowCount,
              rows: result.data.rows.slice(0, 30),
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
      structuredResults, streamCallback, startedAt,
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

    const plan = await this.generateExecutionPlan(userMessage, ctx.conversationHistory);
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

  async generateExecutionPlan(userMessage, conversationHistory = []) {
    const toolList = this.toolRegistry
      .getAll()
      .map((t) => `- ${t.name}: ${String(t.description || '').split('\n')[0]}`)
      .join('\n');
    // Recent history so "that", "it", "the report we discussed" resolve
    const historyBlock = (conversationHistory || [])
      .slice(-6)
      .filter((m) => m.content)
      .map((m) => `${m.role}: ${String(m.content).slice(0, 800)}`)
      .join('\n');
    const params = sanitizeAnthropicParams({
      model: this.model,
      max_tokens: 1500,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: `Create an execution plan for this request: "${userMessage}"
${historyBlock ? `\nRECENT CONVERSATION (for context — resolve references like "that" or "it" from here):\n${historyBlock}\n` : ''}
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

    const subQuestions = await deepResearch.decompose(this.modelRouter, userMessage, ctx.conversationHistory);
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
      if (ctx.isCancelled?.()) {
        return { success: false, cancelled: true, error: 'Stopped by user' };
      }
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
      mode, toolResults, sources, toolCallCount,
      memories, plan = null, subQuestions = [], structuredResults = [], startedAt,
    } = state;
    let { finalText, tokensUsed } = state;
    const { sessionId, userId, userMessage, analysis, streamCallback } = ctx;

    let confidence = scoreResponse({ responseText: finalText, toolResults, sources });

    let validation = null;
    if (agentFlags.validatorsEnabled()) {
      validation = validateOutput(finalText, { toolCallCount, sources });
    }

    // Self-correction: one revision pass when the answer scores low or the
    // validators flag it for review. The corrected text replaces what was
    // streamed (response_reset → re-stream), and is what gets persisted.
    const needsCorrection =
      agentFlags.selfCorrectionEnabled() &&
      !ctx.isCancelled?.() &&
      finalText &&
      finalText.length > 80 &&
      (confidence < 0.45 || validation?.quality === 'review');
    if (needsCorrection) {
      try {
        const corrected = await this._selfCorrect(ctx, {
          draft: finalText,
          issues: validation?.issues || [],
          confidence,
        });
        if (corrected && corrected.text && corrected.text !== finalText) {
          streamCallback({ type: 'response_reset', data: {} });
          streamCallback({ type: 'response_chunk', data: { content: corrected.text } });
          finalText = corrected.text;
          tokensUsed += corrected.tokensUsed || 0;
          confidence = scoreResponse({ responseText: finalText, toolResults, sources });
          if (agentFlags.validatorsEnabled()) {
            validation = validateOutput(finalText, { toolCallCount, sources });
          }
          validation = { ...(validation || {}), self_corrected: true };
        }
      } catch (err) {
        console.warn('Self-correction pass failed (keeping original):', err.message);
      }
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
           (session_id, role, content, model_used, tokens_used, plan_json, tool_calls, sources, complexity_level, confidence_score, structured_results)
         VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          sessionId, finalText, this.model, tokensUsed,
          plan ? JSON.stringify(plan) : null,
          JSON.stringify(toolResults),
          JSON.stringify(sources),
          analysis.complexity,
          confidence,
          structuredResults.length ? JSON.stringify(structuredResults.slice(-4)) : null,
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

  /**
   * One bounded revision pass over a low-confidence / flagged draft.
   * Uses the primary model, no tools — it can only rework what it has.
   */
  async _selfCorrect(ctx, { draft, issues, confidence }) {
    const issueList = issues.length
      ? issues.map((i) => `- ${i.type}: ${i.detail}`).join('\n')
      : '- Low confidence score — verify every claim is supported by the tool results and hedge or remove anything that is not.';
    const params = sanitizeAnthropicParams({
      model: this.model,
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: `You wrote this draft answer for the user's question, but it was flagged for revision (confidence ${confidence}).

USER'S QUESTION: ${String(ctx.userMessage).slice(0, 2000)}

FLAGGED ISSUES:
${issueList}

DRAFT ANSWER:
${String(draft).slice(0, 12000)}

Rewrite the answer fixing the flagged issues. Keep everything that is well-supported. Do NOT invent new data — if something cannot be verified from the draft's own evidence, state the limitation plainly. Keep any <artifact> blocks intact unless they contain the flagged problem. Return ONLY the corrected answer, no preamble.`,
        },
      ],
    });
    const res = await withRetry(() => this.anthropic.messages.create(params), { label: 'self-correct' });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const tokensUsed = (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0);
    return { text, tokensUsed };
  }

  /**
   * Approved feedback → standing guidance lines in the system prompt.
   * Cached for 5 minutes; failures return ''.
   */
  async getFeedbackGuidance() {
    const now = Date.now();
    if (now - this._feedbackCache.at < 5 * 60 * 1000) return this._feedbackCache.text;
    const res = await this.dbPool.query(
      `SELECT COALESCE(NULLIF(training_instruction, ''), feedback_text) AS instruction
       FROM agent_feedback
       WHERE approval_status = 'approved'
         AND COALESCE(NULLIF(training_instruction, ''), feedback_text) IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 15`
    );
    const text = res.rows.length
      ? `LEARNED FROM USER FEEDBACK (admin-approved — always apply):\n${res.rows
          .map((r) => `- ${String(r.instruction).slice(0, 300)}`)
          .join('\n')}`
      : '';
    this._feedbackCache = { at: now, text };
    return text;
  }

  // ==========================================================================
  // Prompt assembly
  // ==========================================================================
  buildToolUseSystemPrompt({
    memories = [],
    outputGuidance = '',
    feedbackGuidance = '',
    conversationSummary = null,
    agentModule = null,
  } = {}) {
    const parts = [clientConfig.getSystemPrompt(agentModule || 'orchestrator_base')];

    if (conversationSummary) {
      parts.push(
        `EARLIER IN THIS CONVERSATION (rolling summary of turns beyond the recent window):\n${String(conversationSummary).slice(0, 4000)}`
      );
    }

    if (feedbackGuidance) {
      parts.push(feedbackGuidance);
    }

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
      '- query_operational_database → the AI platform Postgres. Contains meeting_transcripts (Read.ai + Otter.ai meetings: title, dates, participants, summaries, action items, full transcript text, source column).',
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
    dataLines.push('- search_user_emails → the asking user\'s synced Microsoft 365 email, including extracted attachment text (admins can search all mailboxes).');
    dataLines.push('- search_calendar → live Microsoft 365 calendar (own calendar; admins can view others).');
    dataLines.push('- search_files → live OneDrive/SharePoint file search (own drive; admins can search others).');
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
