# IPS Enterprise AI Agent — Build Context & Architecture Blueprint

> **Purpose of this document.** This is a complete, self-contained context file for building the **IPS** (IPS, Inc. — oilfield electrical services, ipsaecorp.com) AI agent platform inside a brand-new Cursor project. It documents the exact architecture, components, patterns, and "bells and whistles" of an existing, in-production enterprise agent (originally built by nBrain for a media-agency client, and already repurposed once for a retail brand) so you can recreate the same advanced agent for IPS.
>
> **The one key difference you'll be solving for:** IPS will connect to **different data sources** (oilfield project/job data, estimating & bids, labor/crews, fleet & equipment, safety/EHS records, field automation/SCADA telemetry, accounting/ERP). The reference platform is model-agnostic and data-source-agnostic by design — the chat brain, UI, streaming, artifacts, memory, and tool system are all reusable as-is. You will primarily re-skin the branding, re-point the data layer, and re-author a handful of domain tools.
>
> **How to use this in the new project:** Drop this file at the root of the IPS repo, open it in Cursor, and tell the agent: *"Read `IPS-AGENT-PLATFORM-BUILD-CONTEXT.md` and scaffold the platform described in it for IPS."* Then work section-by-section using the build plan in Part 12.

---

## Part 1 — What You're Building (Executive Overview)

A **private, owned, enterprise AI agent platform** — a "Centralized AI Brain" — with a ChatGPT/Claude-grade chat experience that is wired directly into IPS's own data and workflows. It is NOT a ChatGPT wrapper. It is a full platform with:

- A **multi-turn agentic orchestrator** that lets the LLM call tools, inspect results, and keep going (up to 15 tool calls per turn) until it can answer.
- **Native text-to-SQL** over the company's live operational database (natural language → discovered tables → generated SQL → executed → synthesized answer).
- **Model-agnostic routing** across Anthropic Claude, OpenAI GPT, and Google Gemini — the best model is chosen per task.
- **Streaming responses** over Server-Sent Events with live "what's happening" status, token-by-token output, and graceful retry on rate limits.
- **Artifacts** — the agent renders interactive HTML, charts, Mermaid diagrams, SVG, and rich markdown in a side panel (just like Claude Artifacts).
- **Agent intelligence layer**: cross-session long-term memory, deep-research decomposition, output validators, per-turn observability traces, and confidence scoring.
- **A feedback loop** (thumbs up/down + "why?" capture) that trains the agent over time.
- **Multi-channel access**: web chat, plus API, Slack, email, and SMS entry points into the same brain.
- **In-chat uploads** (screenshots/images via vision, PDFs/DOCX/XLSX/PPTX/CSV via text extraction — e.g. RFPs, one-lines, spec sheets, job packets).
- **Voice input**, **chat history with folders/tags/search**, **prompt library**, **session sharing**, and **document/data export**.
- **Knowledge base search** (vector + keyword hybrid) over ingested documents (SOPs, safety manuals, NEC/permit references, service pages).

---

## Part 2 — High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          FRONTEND (Next.js 15)                        │
│  Chat UI · Streaming (SSE) · Artifact panel · History · Voice ·       │
│  Uploads · Feedback · Prompt library · Data inventory page            │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTPS (same-origin proxy) + WebSocket
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       BACKEND (Node + Express)                        │
│                                                                       │
│   /api/agent-chat/*  ──►  AgenticOrchestrator                         │
│                              │                                        │
│        ┌─────────────────────┼──────────────────────────┐           │
│        ▼                     ▼                           ▼           │
│   TOOL_USE mode         PLAN mode                  DEEP RESEARCH     │
│   (default: LLM calls   (action tasks:            (decompose →       │
│    tools in a loop)      email/docs/etc.)          parallel research)│
│        │                                                             │
│        ▼                                                             │
│   ToolRegistry  ──►  [ smart DB tool, vector/hybrid search,          │
│                        domain tools, doc/PDF gen, email, etc. ]      │
│        │                                                             │
│        ├─► ModelRouter (Claude / GPT / Gemini)                       │
│        ├─► Long-term Memory (pgvector recall + extract)              │
│        ├─► Output Validators · Confidence Scoring · Agent Traces     │
│        └─► Query Analyzer (complexity → token budget)                │
└───────────────────────────────┬─────────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│   PostgreSQL (+ pgvector)        Redis            External APIs       │
│   • agent_* system tables        • queue/cache    • Anthropic         │
│   • YOUR business data ◄──────── DIFFERENT FOR    • OpenAI            │
│     (the part that changes        IPS             • Google AI         │
│      for IPS)                                      • (your sources)   │
└─────────────────────────────────────────────────────────────────────┘
```

**The mental model:** *one brain, many surfaces, model-agnostic, data-source-agnostic.* Everything above the "YOUR business data" line is reusable. The data line is what you customize for IPS.

---

## Part 3 — Tech Stack

### Backend (`/backend`)
- **Runtime:** Node.js ≥ 20, Express 4
- **AI SDKs:** `@anthropic-ai/sdk`, `openai`, `@google/genai`
- **DB:** PostgreSQL via `pg` (Pool), with `pgvector` extension for embeddings
- **Vectors/embeddings:** `text-embedding-3-small` (1536 dims). Pinecone optional (`@pinecone-database/pinecone`); pgvector is the default.
- **Realtime:** `socket.io`
- **Queue/cache:** `ioredis` + `bull`
- **Auth:** cookie session (`cookie-parser`, `jsonwebtoken`, `argon2`/`bcryptjs`)
- **Security:** `helmet`, `cors`, `express-rate-limit` (+ `rate-limit-redis`)
- **File handling:** `multer`, `pdf-parse`, `mammoth` (DOCX), `xlsx`, `pdfkit`, `pptxgenjs`
- **Sandbox:** `vm2` (for code-execution tool)

### Frontend (`/frontend`)
- **Framework:** Next.js 15 (App Router), React 18, TypeScript
- **Styling:** Tailwind CSS 3 + `tailwindcss-animate`, shadcn-style UI primitives (Radix)
- **Markdown:** `react-markdown` + `remark-gfm`
- **Icons:** `lucide-react`
- **Realtime:** `socket.io-client`
- **Export:** `html2canvas`

### Infra
- **Hosting:** Render (Blueprint `render.yaml`) — backend web service, frontend web service, managed Postgres, managed Redis. (Any equivalent host works: Railway, Fly, AWS, etc.)
- **Docker:** `docker-compose.yml` for local Postgres/Redis.

---

## Part 4 — Repository Structure

```
/backend
  server.js                       # Express app: middleware, routes, sockets, startup
  package.json
  env.template.txt                # copy → .env
  /agentic
    /config
      client-config.js            # ⭐ CLIENT IDENTITY, SYSTEM PROMPTS, BRANDING, MODELS
      agentFlags.js               # feature flags for the intelligence layer
    /services
      orchestrator.js             # ⭐ the brain — tool_use loop, plan mode, deep research
      toolRegistry.js             # auto-loads & registers tools
      modelRouter.js              # multi-model routing (Claude/GPT/Gemini)
      multiSourceQueryService.js  # ⭐ NL → SQL pipeline
      TableRouter.js              # semantic table discovery (which tables to query)
      TableMetadataVectorization.js # vectorizes table schemas for discovery
      queryAnalyzer.js            # complexity → token-budget heuristic
      longTermMemory.js           # cross-session pgvector memory (recall/extract)
      deepResearch.js             # decompose → parallel sub-research → synthesize
      outputValidators.js         # entity/claim/brand-voice checks (heuristic)
      confidenceScoring.js        # response confidence + digital-twin dashboard
      agentTrace.js               # per-turn observability rows
      hybridSearch.js             # vector + keyword search
      websocket.js                # presence, typing, live updates
      feedbackLearning.js, learningSystem.js, jobQueue.js, ...
    /tools                        # ⭐ each file = one tool the agent can call
      smartDatabaseTool.js        # NL-to-SQL tool (Claude calls this)
      vectorSearchTool.js, hybridSearchTool.js
      clientLookupTool.js, databaseTool.js, ...
      gmailReadTool.js, gmailSendTool.js, gmailDraftTool.js
      pdfGenerateTool.js, docsCreateTool.js, sowGeneratorTool.js, proposalGeneratorTool.js
      pythonExecuteTool.js, taskCreateTool.js, ...
    /routes
      index.js                    # ⭐ chat sessions, messages (SSE), uploads, import, feedback
      templates.js, feedback.js
    /utils
      anthropicRetry.js           # retry/backoff + param sanitizing
      embeddings.js               # embedding helper
      httpAgent.js                # shared IPv4/no-keepalive HTTPS agent for LLM calls
  /routes                         # non-agentic feature routes
    auth.js, admin-users.js, clients.js, ai-rules.js, reports.js,
    data-inventory.js, exports.js, output-templates.js,
    /channels (api.js, slack.js, email.js, sms.js)
  /middleware
    requireAuth.js, requireAdmin.js, requireUserManager.js
  /bootstrap
    autoMigrate.js                # boot-time idempotent migrations
    ensureAdmin.js                # idempotently provision/repair the admin account
  /migrations
    001_create_*_tables.sql ... 029_*.sql   # ordered SQL migrations
    run-migrations.sh
  /scripts
    vectorize-tables.js, ingest-local-documents.js, crawl-website.js, run-migration.js, ...

/frontend
  /app
    page.tsx                      # landing/home
    /ai-chat/page.tsx             # the chat app shell (history + chat + artifacts)
    /data/page.tsx                # "what does the agent know?" inventory
    /account/page.tsx             # self-service profile + change own password
    /admin/users/page.tsx         # admin user management (create, roles, reset/set password)
    /login/page.tsx
    layout.tsx, globals.css
  /components
    /ai-chat
      ChatInterface.tsx           # ⭐ the core chat component (streaming, artifacts, feedback)
      ArtifactPanel.tsx           # renders html/svg/mermaid/chart/markdown artifacts
      ChatHistory.tsx             # sessions sidebar (folders, tags, search, delete)
      PlanDisplay.tsx             # shows plan-mode execution plan
      SourceCitation.tsx          # source pills under answers
      VoiceInput.tsx              # mic → transcript
      PromptLibrary.tsx           # saved/starter prompts
    /layout (Header.tsx, Footer.tsx, Chrome.tsx)
    /ui (button, card, input, textarea, avatar, badge, scroll-area, sheet, tooltip, ...)
  /lib
    artifactParser.ts             # ⭐ streaming + final artifact extraction
    artifactExport.ts             # export an artifact to file
    promptLibrary.ts, utils.ts
  next.config.ts                  # proxies /api/* and /socket.io/* to backend
  middleware.ts                   # edge auth gate
  tailwind.config.ts

render.yaml                       # deployment blueprint
docker-compose.yml
```

⭐ = the files you'll touch most when adapting to IPS.

---

## Part 5 — Backend Deep Dive

### 5.1 `server.js` — application wiring

Responsibilities, in order:
1. Loads `.env`, creates Express app + HTTP server. **Set `require('dns').setDefaultResultOrder('ipv4first')` at the very top** (before any network I/O) — Node 18+ resolves IPv6 first, and flaky IPv6 egress on some hosts manifests as `ERR_STREAM_PREMATURE_CLOSE` on OpenAI/Anthropic calls.
2. **URL normalization shim** for `socket.io` (rewrites `/socket.io?...` → `/socket.io/?...` so the WS handshake matches behind proxies — keep this).
3. Creates the **PostgreSQL `Pool`** (`max: 20`, SSL toggled by `DATABASE_SSL`).
4. Runs **boot-time idempotent migrations** (`runBootstrap`) and **`ensureAdmin(dbPool)`** to guarantee a working admin login on every deploy.
5. CORS (explicit allowed origins — required because `credentials: true` forbids `*`), Helmet, cookie-parser, `trust proxy`, JSON/urlencoded body parsing (50mb, raw body captured for Slack signature verification), request logging.
6. **Initializes the Agentic Brain:** validates config → `new ToolRegistry()` → `toolRegistry.loadToolsFromDirectory(agentic/tools)` → `new AgenticOrchestrator(dbPool, toolRegistry)` → background table-metadata vectorization.
7. Initializes Socket.IO and `websocketService.initialize(io, dbPool)`.
8. Mounts routes (see 5.9).
9. Health check at `/health` (run a real `SELECT 1` so the DB status is accurate), admin DB endpoints (`/api/admin/vectorize`, `/api/admin/database-info`).
10. Graceful shutdown on SIGTERM.

**Startup warmup pattern:** the reference app pre-warms an expensive aggregate query into `app.locals.*WarmCache` a couple seconds after listen. Generalize: pre-warm any expensive dropdown/aggregate your IPS UI needs (e.g. active-jobs list, customer list).

### 5.2 `client-config.js` — ⭐ THE customization hub

This single module is the identity of the platform. **For IPS, this is the #1 file to rewrite.** It exports:

- `CLIENT_NAME`, `CLIENT_ID` — e.g. `'IPS'`, `'ips'`.
- `PINECONE_INDEX` — e.g. `ips-knowledge`.
- `BRAND_COLORS` — primary/secondary/accent/text/background/surface (IPS red + charcoal + steel-blue accent).
- `FEATURES` — toggles (gmail, calendar, code_execution, video, voice, real_time_collaboration, feedback_learning, template_system).
- `AI_MODEL` — model IDs per role: `primary` (Claude Opus), `content` (GPT), `fast`, `long_context` (Gemini), `flash`, `embedding`, `voice_transcription` (Whisper).
- `RATE_LIMITS` — chat/file/job windows.
- **`SYSTEM_PROMPTS`** — the brain's personality and rules:
  - `orchestrator_base` — the master system prompt. Contains: who the company is, brand/identity, what the agent can do, **mandatory tool-use rules**, knowledge-search rules, tone/style, context maintenance, stop conditions, and **the full ARTIFACTS spec** (how to emit `<artifact type="..." title="...">`). **Rewrite the company/brand sections for IPS; keep the tool-use + artifact mechanics verbatim.**
  - Specialized prompts: `email_drafter`, `document_creator`, `code_analyst`, plus **domain agent modules** (in the reference: `insight_generator`, `campaign_analysis`, `media_strategy`, `qa_validator`). These encode institutional rules. **Replace these with IPS's domain expertise** (e.g. estimating/bid review, safety & compliance QA, field-ops analysis).
- Helpers: `getSystemPrompt(context)` (base, or base + specialized), `getAgentModules()`, `getToolConfig()`, `isFeatureEnabled()`, and `validate()` (fails fast if required env vars are missing).

> **Pattern to preserve:** the orchestrator always builds prompts via `clientConfig.getSystemPrompt('orchestrator_base')` and appends runtime context (memory, output guidance, current date). Keep that seam; just change the content.

### 5.3 `orchestrator.js` — the brain

The `AgenticOrchestrator` class is the core. Key surface:

- **`processQuery({ userMessage, conversationHistory, sessionId, userId, clientId, projectId, streamCallback, imageAttachments })`** — the single entry point. Steps:
  1. `queryAnalyzer.analyzeQuery()` → complexity level + token budget; streamed to UI as an `analysis` event.
  2. `getOutputGuidance(userId, message)` → matches active "output templates" (global + per-user format rules) and injects formatting instructions.
  3. **Routing:** `isLegacyPlanQuery()` — if the message is an explicit action ("send email", "create document", "generate pdf", "create task", "schedule meeting", "upload/download"), use **PLAN mode**. Otherwise use **TOOL_USE mode** (the default).

- **TOOL_USE mode (`processWithToolUse`)** — the workhorse:
  - Recalls long-term memory (flag-gated, best-effort).
  - Builds the system prompt (`buildToolUseSystemPrompt`) = base prompt + memory block + output guidance + current date + mandatory-tool-use rules + data-source descriptions + stop conditions.
  - If user attached images, sends them as native Claude vision blocks.
  - Triggers **deep research** if enabled and trigger phrases present.
  - Calls Claude with `tools` (schemas from `getToolSchemas()`) and **streams** the first turn's text token-by-token (`response_chunk` events). Wrap streaming calls in a `_streamWithRetry` helper that safely retries transient connection drops **only if no text has been emitted yet**.
  - **Multi-turn loop:** while `stop_reason === 'tool_use'` and `toolCallCount < maxToolCalls (15)`: execute each requested tool, append `tool_result`, call the model again. Intermediate "thinking" text is discarded; only the final turn's text is streamed and saved. Stops on `maxConsecutiveEmpty (3)` empty results. 1.5s cooldown between iterations to avoid rate-limit exhaustion.
  - After the loop: confidence scoring, output validators, **save user + assistant messages**, log complexity, record trace, extract durable memory (async).
  - Returns `{ success, response, assistantMessageId, plan, sources, tokensUsed, complexity, validation, processingTime }`.

- **PLAN mode (`processWithPlan`)** — for action tasks: `generateExecutionPlan()` (Claude returns JSON plan) → stream plan → `executePlan()` (run each tool step, stream progress) → `synthesizeResponse()` (route synthesis through `ModelRouter`) → save.

- **DEEP RESEARCH (`processDeepResearch`)** — decompose the question into sub-questions, research each (parallel sub-loops sharing the same tools), synthesize a final answer; persists like a normal turn.

- **Token budgets:** capped at 32k output (64k streams for minutes and bloats memory); "deep analysis" keywords bump the cap.
- **Reliability:** every Anthropic call is wrapped in `withRetry(...)` (`utils/anthropicRetry.js`) with `sanitizeAnthropicParams(...)`. Rate-limit (429) and overload (529) errors surface as friendly, retryable messages; connection errors (`ERR_STREAM_PREMATURE_CLOSE`, `ECONNRESET`, etc.) are also retried.

> **Recreate this file nearly verbatim.** It's data-source-agnostic. The only spots referencing the client are inside the system-prompt strings, which come from `client-config.js`.

### 5.4 `toolRegistry.js` + tool authoring pattern

`ToolRegistry` auto-loads every `.js` in `/agentic/tools` that exports an object with `{ name, execute }`. Class-based tools (like the smart DB tool) are instantiated separately by the orchestrator.

**Every object-style tool follows this shape** (copy this template for new IPS tools):

```js
module.exports = {
  name: 'tool_name',                 // unique; what the LLM calls
  description: `Clear description + WHEN TO USE + examples`,  // the LLM reads this
  category: 'data',                  // organizational
  requiresApproval: false,           // gate destructive actions
  parameters: {                      // becomes the LLM's input_schema
    type: 'object',
    properties: {
      some_arg: { type: 'string', description: 'what it is' },
    },
    required: ['some_arg'],
  },
  async execute(params, context) {
    // context = { userId, clientId, projectId, sessionId, dbPool }
    try {
      // ...do the work, query dbPool, call an API, etc.
      return {
        success: true,
        data: { /* ... */ },
        confidence: 0.95,
        source_type: 'database',     // surfaces in citations
        data_points: [ /* optional structured highlights */ ],
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
```

The orchestrator turns each tool's `parameters` into a Claude `input_schema` in `getToolSchemas()`. **Description quality drives tool-selection accuracy — write rich descriptions with explicit "WHEN TO USE" and examples.**

### 5.5 `modelRouter.js` — multi-model orchestration

- A `MODEL_REGISTRY` maps logical model keys → `{ provider, modelId, strengths, maxTokens, costTier }` across Anthropic / OpenAI / Google.
- `TASK_TO_MODEL` maps task types → model keys (tool_use/agentic/strategy/analysis → Claude; content/creative → GPT; long_context/document_analysis/research → Gemini Pro; summarization/classification/extraction → cheap models; fast_tasks → Gemini Flash).
- `classifyTask(message)` — regex heuristics to pick a task type.
- `generateText(...)` and `generateTextStream(...)` — unified interface; **automatic fallback to Claude** if the chosen provider errors. Latency is tracked (target <3s) and exposed via `/api/agent-chat/models`.
- Only providers with API keys present are activated.

> Tool-use always routes to Claude (best agentic support). Keep that. IPS inherits model-agnosticism for free — set whichever provider keys you have.

### 5.6 The data layer (NL → SQL) — ⭐ where IPS differs most

This is the part you'll re-point at IPS's data. Three cooperating pieces:

1. **`smartDatabaseTool.js`** (class, name `query_operational_database`) — the tool Claude calls for any data question. Takes a natural-language `query` (+ optional table `hint`). Runs the NL→SQL pipeline, retries with alternative phrasings if empty, caps to 100 rows, formats records as text for the model. **It announces nothing** (the prompt tells the model to use it silently).

2. **`multiSourceQueryService.js`** — the pipeline:
   - `getAllTables()` — lists `public` base tables, **excluding** the `agent_*` system tables and other infra tables (`excludedTables` array).
   - `TableRouter.discoverRelevantTables()` — semantic discovery of which tables matter for this question (uses vectorized table metadata).
   - `buildDynamicSchemaContext()` — for each relevant table, emits columns, row counts, date ranges, and **sample rows** (pulled from `agent_metadata.table_vectors`, with an `information_schema` fallback) so the model writes correct SQL.
   - `generateSQL()` — Claude (temp 0.1) writes **one read-only SELECT**, given the current date for relative-date math and strict rules (only listed tables, quote weird columns, LIMIT lists, aggregate big tables). **Hard safety check rejects any DROP/DELETE/UPDATE/INSERT/ALTER/CREATE/GRANT/REVOKE.**
   - `executeQuery()` — `SET statement_timeout = 30000`, run, return rows.
   - Empty/incomplete results → retry against alternative tables.
   - `logQuery()` — every query logged to `agent_metadata.query_history` for learning.

3. **`TableMetadataVectorization.js`** + `scripts/vectorize-tables.js` — scans each data table, captures columns/types/row-counts/date-ranges/sample rows, embeds a searchable description, and stores it in `agent_metadata.table_vectors`. This is what makes table discovery and schema-context generation work. **Run vectorization once after loading IPS's data** (`npm run vectorize`, or `POST /api/admin/vectorize`).

> **Adapting for IPS:** the engine is generic — it discovers and queries *whatever public tables exist*. You mainly:
> - Load IPS's data into the same Postgres (as tables, or via FDW / ETL / sync jobs).
> - Run vectorization so the agent "knows" the new tables.
> - Update the data-source descriptions in `client-config.js` `orchestrator_base` and in `orchestrator.buildToolUseSystemPrompt` (the "OTHER DATA IN DATABASE" / "AVAILABLE DATA" lines) to name IPS's real tables and what they contain.
> - If IPS has an authoritative high-volume domain table that deserves its own tool (e.g. field automation/SCADA telemetry, job-costing ledger), author a purpose-built tool for it (see 5.4) and tell the model to prefer it.
> - See **Part 11** for the data-source playbook.

### 5.7 Agent intelligence layer (all flag-gated via `agentFlags.js`)

Each is independently toggleable with `FEATURE_*` env vars; failures never break chat.

- **`longTermMemory.js`** — durable, cross-session, per-user semantic memory. `recall(userId, message)` before answering (pgvector cosine similarity over `agent_memories`), `extract(...)` after answering to persist new facts/preferences/projects/style. Deduped by `(user_id, md5(content))`.
- **`deepResearch.js`** — `shouldTrigger(message)` on strong phrases; `run(...)` decomposes into sub-questions, researches each with the full toolset, synthesizes. Streams a plan + progress.
- **`outputValidators.js`** — post-answer heuristic checks (entity consistency, unsupported claims, brand-voice). Returns `{ quality, issues[] }`; surfaced, never throws.
- **`confidenceScoring.js`** — scores each response (tool calls + sources + text). Logged per message; powers `/api/agent-chat/confidence` and a "digital twin" dashboard.
- **`agentTrace.js`** — one consolidated observability row per turn (mode, sub-questions, tools, memory hits, validators, confidence, tokens, latency) in `agent_traces`. Viewable via `/api/agent-chat/admin/traces`.
- **`queryAnalyzer.js`** — fast heuristic complexity classifier → token budget (quick 4k / standard 16k / detailed 32k / comprehensive 64k). Deliberately **not** an LLM call (saves rate limit).

### 5.8 `websocket.js` — realtime

Socket.IO handlers: `join_session`/`leave_session` (presence in `agent_session_presence`), `typing_start`/`typing_stop`, `plan_modified` (owner-gated broadcast), disconnect cleanup. Helpers `broadcastToSession()` and `sendNotificationToUser()`. Used for multi-user collaboration and live updates; safe to keep even for single-user IPS.

### 5.9 API surface (`/agentic/routes/index.js` and `/routes/*`)

Mounted under `/api/agent-chat` (plus feature routes). Highlights:

- **Sessions:** `POST/GET/PUT/DELETE /sessions`, `GET /sessions/:id` (with messages), `POST /sessions/:id/generate-title` (Haiku-generated short title with fallback). Sessions support folders, subfolders, tags, archive, and `visibility` (shared/private).
- **Messaging (streaming):** `POST /sessions/:id/message` — sets SSE headers, defines `streamCallback` that writes `data: {json}\n\n`, runs a **15s heartbeat** (`: ping`) so proxies don't drop long runs, calls `orchestrator.processQuery`, then writes a terminal `complete` (or `error`) event. Rate-limited (10/min/user, in-memory).
- **Uploads:** `POST /upload` (multer, 25MB, ≤8 files). Images → base64 vision blocks; documents → server-side text extraction (`DocumentProcessor`). Frontend sends returned descriptors with the next message.
- **Chat migration/import:** `GET /migration-prompt` (a copy-paste prompt users run in ChatGPT/Claude to export their accumulated training) and `POST /import` (ingest that export as a seeded session so the brain "remembers" it). **Great onboarding feature — keep it for IPS.**
- **Feedback:** `POST /messages/:id/feedback` (rating + categories + text + training_instruction), plus admin approve endpoints.
- **Observability:** `/admin/traces`, `/confidence`, `/digital-twin/dashboard`.
- **Tools/models:** `GET /tools`, `GET /models`.
- **Other route files:** `auth` (cookie login/logout/session/change-password), `admin-users` (user management: create users, assign user/admin role, reset & set passwords), `clients`, `ai-rules`, `reports`, `data-inventory` (the "what does the agent know?" page), `exports` (artifact → PDF/Excel), `output-templates` (global + per-user formatting rules), and the multi-channel entry points under `/channels/{api,slack,email,sms}` which all funnel into the same `orchestrator`.

### 5.10 SSE event protocol (backend → frontend)

The streaming contract the frontend understands:

| event `type`     | when                          | payload `data`                              |
|------------------|-------------------------------|---------------------------------------------|
| `analysis`       | after complexity analysis     | `{ complexity, token_allocation, reasoning }` |
| `plan`           | plan/deep-research planned    | the plan object (with `mode`)               |
| `progress`       | a tool is running             | `{ step, total, tool, status }`             |
| `tool_result`    | a tool returned              | `{ step, tool, success, summary }`          |
| `tool_error`     | a tool failed                | `{ step, tool, error }`                     |
| `response_chunk` | streamed answer text         | `{ content }` (append)                       |
| `complete`       | turn finished                | the full result object (`assistantMessageId`, etc.) |
| `error`          | failure                      | `{ error, errorType, retryable, retryAfterSec }` |

Keep this protocol identical so the existing frontend works unchanged.

---

## Part 6 — Frontend Deep Dive

### 6.1 `ChatInterface.tsx` — the core component

This is the heart of the UX. Recreate it closely. It implements:

- **Streaming reader:** `fetch` the SSE endpoint, read the body stream, buffer by `\n`, parse `data:` lines, and react to each event type (table in 5.10). Token chunks are fed through the streaming artifact parser.
- **Live status:** while loading, shows animated dots + a status line. Specific backend events set the status (`friendlyTool(name)` maps internal tool names → human phrases like "Querying the database", "Searching documents & knowledge"); when no event has arrived it cycles generic `WORKING_PHRASES`. The moment answer text streams, the status clears.
- **Artifacts:** uses `StreamingArtifactParser` to split clean text from `<artifact>` blocks in real time; artifacts populate a right-hand panel; inline `[artifact:id:title]` placeholders render as clickable cards in the message.
- **Markdown rendering:** `react-markdown` + `remark-gfm` with a full custom component map (headings, lists, tables with horizontal scroll, code blocks, blockquotes, links open in new tab).
- **Feedback:** thumbs up posts immediately; thumbs down opens a "What was wrong? This trains the agent." comment box, then posts with the reason (highest-signal training input).
- **Attachments:** file picker + **paste-to-upload** (screenshots!) + drag; uploads to `/upload`, shows chips, sends descriptors with the message. Can send with attachments only.
- **Voice input:** `VoiceInput` mic → transcript into the input.
- **Resilience:** rate-limit (429) handling with an auto-retry countdown ("AI service at capacity — retrying in Ns" + Retry Now/Cancel); graceful message if the stream drops mid-run (long deep-research over a proxy idle timeout); **Stop** button aborts via `AbortController`.
- **Auto-title:** first message triggers `generate-title`.
- **Auth:** all calls use `credentials: 'include'`; socket connects same-origin with `path: '/socket.io/'` so the session cookie rides along.

### 6.2 Artifact system

- **`lib/artifactParser.ts`** — `parseArtifacts(text)` for completed messages and `StreamingArtifactParser` for live streams. Supported types: `html`, `svg`, `mermaid`, `chart` (Chart.js JSON), `markdown`. The agent is instructed (in `orchestrator_base`) to emit `<artifact type="..." title="...">...</artifact>` and keep prose outside the tags.
- **`ArtifactPanel.tsx`** — renders each type (HTML in a sandboxed iframe with Chart.js/D3/Mermaid/KaTeX preloaded; mermaid via mermaid.js; chart via Chart.js; markdown via react-markdown). Includes copy/export.
- **`lib/artifactExport.ts`** + backend `/api/exports` — turn an artifact into a downloadable PDF/Excel.

### 6.3 Other components & pages

- **`ChatHistory.tsx`** — sessions sidebar: folders/tags/search, rename, archive, delete (delete button always visible), shared/private indicator.
- **`PlanDisplay.tsx`** — renders plan-mode steps with approve/modify.
- **`SourceCitation.tsx`** — source pills with confidence under answers.
- **`PromptLibrary.tsx`** + `lib/promptLibrary.ts` — starter/saved prompts (author IPS-flavored starters: "Summarize open RFPs", "Which crews are on the Loving job this week?", "Draft a safety toolbox talk for hydro excavation").
- **`/app/ai-chat/page.tsx`** — shell that composes history + chat + artifacts.
- **`/app/data/page.tsx`** — read-only "what does the agent know?" inventory (counts/metadata from `/api/data-inventory`).
- **`/app/account/page.tsx`** — self-service profile + change-own-password.
- **`/app/admin/users/page.tsx`** — admin user management (list, create, set role, reset/set password).
- **`/components/ui/*`** — shadcn-style primitives (button, card, input, textarea, avatar, badge, scroll-area, sheet, tooltip, separator).

### 6.4 `next.config.ts` proxy

Rewrites `/api/*` and `/socket.io/*` to the backend so the frontend is same-origin (cookies + WS work cleanly). `middleware.ts` is an edge auth gate. Replicate both.

### 6.5 Branding/theming

Brand colors live in `client-config.js` (backend) and Tailwind theme tokens (frontend). **For IPS:** define IPS's palette as Tailwind tokens (`ips-*`), swap the logo asset (`ips-logo.png`), and update the brand colors in config. The structure stays; only tokens/assets change. IPS palette: **red primary, charcoal/near-black secondary, steel-blue accent** (sampled from the logo + ipsaecorp.com — verify and refine during the build).

---

## Part 7 — Database Schema

The platform owns a set of `agent_*` system tables (in migration `001`) plus an `agent_metadata` schema for the data layer, plus the **business data tables** (which differ for IPS). Run migrations in order from `/backend/migrations` (`run-migrations.sh` or `npm run db:migrate`); all are idempotent (`IF NOT EXISTS`) and several re-run safely on boot via `bootstrap/autoMigrate`.

### Core system tables (migration 001)
- `users` — platform users/auth (email, password_hash [argon2], role, is_active, must_change_password).
- `agent_chat_sessions` — sessions (user_id, client_id, project_id, title, folder, tags, is_archived, visibility, timestamps).
- `agent_chat_messages` — messages (role, content, model_used, tokens_used, plan_json, tool_calls, sources, search_method, complexity_level, confidence_score, created_at).
- `agent_artifacts` — generated artifacts (type, title, content, version, parent_artifact_id).
- `agent_templates` — brand/document templates.
- `agent_session_presence` — realtime presence.
- `agent_feedback` — thumbs + categories + text + training_instruction + approval workflow.
- `agent_user_preferences` — learned per-user preferences (key/value/confidence).
- `agent_background_jobs`, `agent_notification_preferences`, `agent_notifications`, `agent_weekly_digests`, `agent_pinecone_sync`.
- Plus GIN/FTS indexes and `updated_at` triggers.

### Data-layer schema (`agent_metadata`, migration 004)
- `agent_metadata.table_vectors` — vectorized table metadata for discovery + schema context.
- `agent_metadata.query_history` — every NL→SQL run (for learning).
- `agent_metadata.query_patterns` — reusable query templates.

### Knowledge base (migration 002)
- `pgvector` extension + a `website_content`/document table (`vector(1536)`, ivfflat cosine index + FTS GIN index) — powers hybrid_search / vector_search over ingested site + document content.

### Agent intelligence (migration 028)
- `agent_memories` — durable cross-session memory (`vector(1536)`, ivfflat cosine index, dedupe by content hash).
- `agent_traces` — per-turn observability.

### Chat sharing + templates (migration 029)
- Chat sharing/visibility + global/per-user output templates.

> **IPS action:** keep migration `001`, `002`, `004`, `028`, `029` (the brain). Skip the reference client's Microsoft/SharePoint (`003`, `017`, `022`–`024`) and media-specific migrations. Replace the reference-client business-data migrations/seeds with IPS's own data tables (Part 11). A small auth-consolidation migration (`030`) plus an `ensureAdmin` bootstrap keeps the admin login reliable.

---

## Part 8 — Environment Variables

Copy `env.template.txt` → `.env`. Core set:

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/db
DATABASE_SSL=true

# Auth
JWT_SECRET=change-me
# Admin bootstrap (ensureAdmin uses these on boot)
ADMIN_EMAIL=admin@ipsaecorp.com
ADMIN_INITIAL_PASSWORD=change-me-strong

# AI models (Anthropic + OpenAI required; Google optional)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_AI_API_KEY=...            # optional, enables Gemini routing

# Vector DB (pgvector default; Pinecone optional)
PINECONE_API_KEY=...             # optional
PINECONE_INDEX_NAME=ips-knowledge

# Infra
REDIS_URL=redis://localhost:6379
PORT=8080
NODE_ENV=development
FRONTEND_URL=http://localhost:3000

# Intelligence layer flags (default ON; deep research is opt-in per query)
FEATURE_LONG_TERM_MEMORY=true
FEATURE_DEEP_RESEARCH=true
FEATURE_OUTPUT_VALIDATORS=true
FEATURE_AGENT_TRACE=true

# Capability flags
FEATURE_CODE_EXEC=true
FEATURE_VOICE=false
FEATURE_VIDEO=false
FEATURE_GMAIL=false
FEATURE_CALENDAR=false

# Client identity
CLIENT_NAME=IPS
CLIENT_ID=ips
BRAND_PRIMARY_COLOR=#EC1C24       # IPS red (verify from ipsaecorp.com / logo)
BRAND_SECONDARY_COLOR=#231F20     # charcoal/near-black
BRAND_LOGO_URL=/ips-logo.png

# ----- SECONDARY DATABASE: IPS Billing Platform (read-only) -----
# The agent connects to the existing IPS Billing/accounting Postgres in addition
# to its own primary DB. See Part 11.1. Store as a secret; do NOT commit.
IPS_BILLING_DATABASE_URL=postgresql://<billing-readonly-user>:<password>@dpg-d7h7t6vaqgkc739qfb70-a.oregon-postgres.render.com/ips_cb  # REDACTED — real value lives in .env / Render secret only
IPS_BILLING_DATABASE_SSL=true

# (Optional) other IPS-specific data-source connections go here
# e.g. IPS_ERP_URL=..., IPS_FSM_API_KEY=..., IPS_SCADA_API_KEY=...
```

`client-config.validate()` hard-requires `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `REDIS_URL`, `DATABASE_URL`. Pinecone is optional (warns, falls back to pgvector). Drop the Microsoft/SharePoint/Google blocks unless IPS uses them.

---

## Part 9 — Local Development

```bash
# 1. Infra (Postgres + Redis)
docker compose up -d

# 2. Backend
cd backend
cp env.template.txt .env        # fill in keys
npm install
bash migrations/run-migrations.sh   # or npm run db:migrate
npm run dev                     # nodemon server.js on :8080

# 3. Load IPS data, then vectorize so the agent "knows" the tables
npm run vectorize               # or POST /api/admin/vectorize

# 4. Frontend
cd ../frontend
npm install                     # add --legacy-peer-deps if npm peer errors (react-markdown@9)
npm run dev                     # Next.js on :3000
```

Open `http://localhost:3000/ai-chat`.

---

## Part 10 — Deployment (Render Blueprint)

`render.yaml` provisions four resources: **backend web service** (`rootDir: backend`, `npm install` / `npm start`, health `/health`), **frontend web service** (`rootDir: frontend`, `npm install --legacy-peer-deps && npm run build` / `npm start`), **managed Postgres** (`postgresMajorVersion: 15`), **managed Redis** (`allkeys-lru`). It wires `DATABASE_URL`/`REDIS_URL`/`FRONTEND_URL` between services, auto-generates `JWT_SECRET`, and marks secrets `sync: false` (set in dashboard). For IPS: services are named `ips-*`, set `CLIENT_NAME=IPS`/`CLIENT_ID=ips`/brand colors, set the AI keys + `ADMIN_EMAIL`/`ADMIN_INITIAL_PASSWORD`, and remove the Microsoft blocks. Any equivalent host works the same way.

**Deployment lessons baked in:** Postgres plan names use hyphens (e.g. `basic-256mb`); the frontend build needs `--include=dev` (or `--legacy-peer-deps --include=dev`) so `typescript` is present at build time; force IPv4 + disable keep-alive on the outbound LLM HTTPS agent (`agentic/utils/httpAgent.js`) to avoid `ERR_STREAM_PREMATURE_CLOSE`.

---

## Part 11 — ⭐ The Data-Source Playbook for IPS (the key difference)

The agent answers data questions through one generic mechanism: **discover relevant tables in Postgres → generate read-only SQL → execute → synthesize.** So "connecting IPS to different data sources" reduces to: *get IPS's data queryable from the platform's Postgres (or behind a tool), then teach the agent it exists.*

**Likely IPS data sources (confirm with the IPS team):**
- **Jobs / projects / work orders + estimating & bids (RFPs)** — from an ERP or field-service management (FSM) / construction-accounting system (e.g. Viewpoint/Vista, Sage 300 CRE / Sage Intacct, Foundation, Jonas, ServiceTitan, or QuickBooks).
- **Labor / crews / timekeeping / payroll** — who's on which job, hours, certifications.
- **Fleet & equipment** — hydro-excavation trucks, bucket trucks, utilization/maintenance.
- **Field automation / SCADA / well telemetry** — real-time field data from the automation services line (often a historian or time-series DB / vendor API).
- **Safety & compliance (EHS)** — incidents, audits, permits, training, contractor-qualification portals (ISNetworld, Avetta, Veriforce).
- **Accounting / job costing** — costs vs. estimate, WIP, AR/AP.
- **CRM** — customers (oil & gas operators/producers), contacts, opportunities.
- **Inventory / materials / purchasing** — electrical materials, wire/gear, procurement.
- **Documents & knowledge** — SOPs, safety manuals, one-lines, spec sheets, NEC/permit references, the ipsaecorp.com site content.

Choose a pattern per source:

1. **Native Postgres tables (simplest).** Load/replicate IPS's data as tables in the platform DB (ETL, nightly sync, CSV/Excel import, or `INSERT` jobs). The smart DB tool works immediately after vectorization. Best for: exports, warehouses, structured business data.

2. **Foreign data / live DB.** If IPS's data lives in another Postgres/MySQL/SQL Server/warehouse, use `postgres_fdw`/a sync job to mirror or expose it as tables. Same downstream flow.

3. **Third-party API → dedicated tool.** If a source is an API (FSM, EHS portal, SCADA/historian, CRM), **author a tool** (Part 5.4) that calls it and returns structured results. Register it; describe it richly so the model picks it. Best for: real-time systems, write actions, anything not worth replicating into SQL.

4. **Documents/knowledge → vector store.** Ingest PDFs/docs/site content with `scripts/ingest-local-documents.js` / `scripts/crawl-website.js` into the vector store; the agent retrieves via `vector_search`/`hybrid_search`. Best for: SOPs, safety manuals, spec sheets, service/site content.

5. **Authoritative high-volume domain table → purpose-built tool.** If IPS has a giant, accuracy-critical table (e.g. SCADA/telemetry time-series or a job-costing ledger), build a focused tool over it and instruct the model to prefer it over raw SQL.

**After wiring any source, you MUST:**
- Run table vectorization (`npm run vectorize`) so discovery + schema-context include the new tables.
- Update the **data-source descriptions** in `client-config.js` (`orchestrator_base`) and `orchestrator.buildToolUseSystemPrompt` — name IPS's real tables/sources and what each contains, and add any "prefer tool X for question Y" routing rules.
- Add new tables to `multiSourceQueryService.excludedTables` only if they are infra/noise that should never be queried.
- Add domain guardrails to the specialized prompts (e.g. IPS estimating rules, safety/compliance QA checklist, like-for-like job comparisons only).

**Safety stays intact regardless of source:** SQL generation is SELECT-only with a keyword denylist and a 30s statement timeout; row output is capped; tools can require approval for write/destructive actions.

---

## Part 11.1 — ⭐ IPS Billing Platform (secondary Postgres) — CONFIRMED INTEGRATION

IPS runs a **separate, purpose-built Billing/accounting platform** with its own Postgres database. This agent will use **two databases**:

1. **Primary DB (new, created for this agent):** the platform's own `agent_*` system tables + any IPS operational data we load. Provisioned by `render.yaml` (`ips-db`) and referenced via `DATABASE_URL`.
2. **Secondary DB (existing IPS Billing platform, read-only):** the live accounting/billing database. It is **not** created by this project — we connect to the existing one. Both live in the same Render region (`oregon`), so latency between them is negligible.

**Secondary DB connection (store as a secret — DO NOT hardcode or commit):**
```
IPS_BILLING_DATABASE_URL=postgresql://ips_cb_user:...@dpg-d7h7t6vaqgkc739qfb70-a.oregon-postgres.render.com/ips_cb
IPS_BILLING_DATABASE_SSL=true
```
> ⚠️ **Security:** the provided URL includes a live password. Put it in `.env` locally and in Render as a `sync: false` secret — never in committed code. **Strongly recommended:** create a **dedicated read-only role** on the billing DB for the agent (e.g. `GRANT CONNECT` + `GRANT USAGE ON SCHEMA` + `GRANT SELECT ON ALL TABLES`, no write grants) instead of reusing `ips_cb_user`, so the agent physically cannot write to accounting data. Rotate the credential after the build if it has been shared.

### Postgres reality check
A single Postgres connection sees only one database, and Postgres does **not** support cross-database `JOIN`s over a plain connection. So "the agent has both databases" is implemented one of two ways below.

### ✅ Default approach for IPS — Option B: separate read-only pool + dedicated billing tool
Because billing is a sensitive, standalone accounting platform, default to strong isolation:

- Add a **second `pg.Pool`** in `server.js` from `IPS_BILLING_DATABASE_URL` (e.g. `billingDbPool`, `max: 10`, SSL on), separate from the primary `dbPool`.
- Author a purpose-built tool **`query_billing_database`** (mirror `smartDatabaseTool.js` / the `multiSourceQueryService` NL→SQL pipeline, but pointed at `billingDbPool`). Same SELECT-only safety, keyword denylist, 30s timeout, 100-row cap.
- Run **table vectorization against the billing DB too** so table discovery + schema context work there (store its `table_vectors` tagged by source, or in a separate metadata namespace, so the two schemas don't collide).
- In `orchestrator.buildToolUseSystemPrompt` / `client-config.orchestrator_base`, add explicit routing rules: *accounting/billing/invoice/AR/AP/payment/revenue questions → `query_billing_database`; jobs/crews/equipment/operational questions → `query_operational_database`.* Describe what each DB contains.
- The agent answers from each DB independently and synthesizes across tool calls. **Trade-off:** no single query can JOIN across the two DBs.

### Alternative — Option A: `postgres_fdw` (unified surface, cross-DB joins)
If IPS frequently needs a single query that blends operational + billing data (e.g. job cost vs. invoiced amount), mount the billing tables into the primary DB as a read-only foreign schema:

- On the primary DB: `CREATE EXTENSION postgres_fdw;` → `CREATE SERVER` pointing at the billing host → `CREATE USER MAPPING` (read-only billing role) → `IMPORT FOREIGN SCHEMA public FROM SERVER ... INTO billing;`.
- The existing single-pool NL→SQL engine then discovers `billing.*` alongside local tables — one brain, one queryable surface, cross-DB joins work. Add the `billing` schema to discovery + vectorization and describe it in the prompt.
- **Watch-out:** heavy cross-DB analytical joins can be slow; add materialized views or a nightly sync for those. FDW is available on Render Postgres.

### Universal notes (either option)
- Dedicated **read-only** billing credential (least privilege) on top of the platform's SELECT-only SQL guard.
- **Vectorize both schemas** — the agent can only query what table discovery knows about.
- Size pools modestly (`max: 10` each) to stay under Render's per-plan connection cap.
- Never expose the billing connection string to the frontend; it stays server-side only.

---

## Part 12 — Step-by-Step Build Plan for IPS

1. **Scaffold the repo** mirroring Part 4 (`/backend`, `/frontend`, `render.yaml`, `docker-compose.yml`). Copy `package.json` deps from Part 3.
2. **Stand up infra** (`docker compose up -d`), create `.env` (Part 8) with at least Anthropic + OpenAI + DB + Redis.
3. **Bring over the brain (mostly verbatim):** `server.js`, the entire `/agentic` tree (orchestrator, toolRegistry, modelRouter, multiSourceQueryService, TableRouter, TableMetadataVectorization, queryAnalyzer, the intelligence services, websocket, utils incl. `httpAgent.js`), `/middleware`, and `/bootstrap` (autoMigrate + ensureAdmin).
4. **Rewrite `client-config.js` for IPS:** name/id, brand colors, Pinecone index, features, and — most importantly — the **system prompts** (company identity + domain agent modules + data-source descriptions). Keep the tool-use mechanics and the ARTIFACTS spec unchanged.
5. **Run core migrations** `001, 002, 004, 028, 029` (the brain). Skip reference-client/Microsoft migrations.
6. **Wire IPS data sources** (Part 11): load tables and/or author tools and/or ingest documents. **Connect the secondary IPS Billing database (Part 11.1)** — default to Option B (separate read-only `billingDbPool` + `query_billing_database` tool). Crawl/ingest ipsaecorp.com so the agent is brand-consistent from day one.
7. **Vectorize** (`npm run vectorize`) and confirm via `GET /api/admin/database-info` that IPS tables appear with vector chunks.
8. **Bring over the frontend:** the `/components/ai-chat/*`, `/lib/artifact*`, `/app/ai-chat`, `/app/data`, `/app/account`, `/app/admin/users`, `/components/ui/*`, `next.config.ts` proxy, `middleware.ts`. Re-theme Tailwind tokens to IPS's palette and swap the logo.
9. **Smoke test the loop:** ask a data question (verify tool_use + SQL + streamed answer), ask for a chart/diagram (verify artifact), upload a screenshot/RFP (verify vision + doc extraction), thumbs-down (verify feedback), and a "deep dive …" prompt (verify deep research).
10. **Author IPS domain tools** as needed (Part 5.4) and tune the specialized prompts/guardrails.
11. **Tune routing & guardrails** in `client-config.js` (which tool for which question; domain QA rules).
12. **Deploy** via `render.yaml` (rename to `ips-*`, set secrets).

---

## Part 13 — Customization Checklist (Reference Client → IPS)

- [ ] `client-config.js`: `CLIENT_NAME`, `CLIENT_ID`, `PINECONE_INDEX`, `BRAND_COLORS`.
- [ ] `client-config.js` `SYSTEM_PROMPTS.orchestrator_base`: rewrite company identity, brand voice, capabilities, and **data-source descriptions** to IPS's reality.
- [ ] `client-config.js` specialized prompts: replace reference modules with IPS's domain agents + guardrails (estimating/bid review, safety & compliance QA, field-ops analysis) or remove if N/A.
- [ ] `orchestrator.buildToolUseSystemPrompt`: update "AVAILABLE DATA / OTHER DATA IN DATABASE" lines and tool-preference routing to IPS's tables/tools.
- [ ] `/agentic/tools`: keep generic tools (smart DB, vector/hybrid search, pdf/doc gen, python). Remove reference-client-specific tools; author IPS domain tools.
- [ ] `multiSourceQueryService.excludedTables`: adjust for IPS's schema.
- [ ] Migrations: keep `001/002/004/028/029`; drop Microsoft/media-specific ones; add IPS data tables.
- [ ] Frontend Tailwind tokens + logo (`ips-logo.png`) + product copy (footer line, landing page, prompt library starters).
- [ ] `render.yaml`: service names (`ips-*`), client identity vars, secrets (incl. `ADMIN_EMAIL`/`ADMIN_INITIAL_PASSWORD`); remove MS blocks.
- [ ] `.env` + Render secrets: IPS keys + `IPS_BILLING_DATABASE_URL` (secondary billing DB, read-only) + any other data-source connection vars.
- [ ] Billing DB (Part 11.1): second read-only pool + `query_billing_database` tool (Option B) or `postgres_fdw` `billing` schema (Option A); vectorize its tables; add routing rules to the prompts.
- [ ] Decide feature flags (voice, code-exec, deep research, etc.).

---

## Part 14 — Production Lessons Baked In (keep these)

- **Retry/backoff** on every Anthropic call (`withRetry` + `sanitizeAnthropicParams`); surface 429/529 as friendly, auto-retrying messages; treat connection errors (`ERR_STREAM_PREMATURE_CLOSE`, `ECONNRESET`, `ETIMEDOUT`, etc.) as retryable.
- **Force IPv4 + disable keep-alive** on the outbound LLM HTTPS agent (`agentic/utils/httpAgent.js`) and set `dns.setDefaultResultOrder('ipv4first')` in `server.js` — this is what fixed persistent "Premature close" on the cloud runtime.
- **SSE heartbeat** (15s `: ping`) so proxies/load balancers don't kill long runs; frontend handles a dropped stream gracefully.
- **Cap output tokens at ~32k** (64k streams for minutes and bloats memory); bump only for explicit "deep/comprehensive" asks.
- **Cooldown (1.5s) between tool-loop iterations** to avoid rate-limit exhaustion; stop after 3 consecutive empty results; max 15 tool calls/turn.
- **Heuristic complexity analysis** (no LLM call) to set token budget without burning rate limit.
- **SELECT-only SQL** with keyword denylist + 30s statement timeout + 100-row output cap.
- **Vectorize table metadata** so the model writes correct SQL with real columns + sample rows; cache expensive dropdown queries at startup.
- **Cookie-based auth, same-origin proxy** for both REST and WebSocket so sessions "just work."
- **Idempotent boot migrations + `ensureAdmin`** so a fresh deploy always has a working admin login; the health check runs a real `SELECT 1`.
- **Everything in the intelligence layer is flag-gated and best-effort** — memory/validators/traces/deep-research failures must never break a chat turn.
- **Discard intermediate tool-loop "thinking" text;** only stream/save the final turn so users don't see the model talking to itself.

---

### Appendix A — Generic tools worth porting as-is
`smartDatabaseTool` (NL→SQL), `vectorSearchTool` / `hybridSearchTool` (knowledge search), `pdfGenerateTool`, `docsCreateTool`, `proposalGeneratorTool` / `sowGeneratorTool` (template-driven docs — great for IPS bids/RFP responses/SOWs), `pythonExecuteTool` (sandboxed analysis), `taskCreateTool`. Gmail tools only if IPS uses Google Workspace.

### Appendix B — The migration/import onboarding trick
Ship `GET /migration-prompt` + `POST /import`: users paste a prompt into their old ChatGPT/Claude to export everything they "taught" it as Markdown, then upload that file. It's ingested as a seeded session so the new IPS brain starts with their accumulated context. Low effort, high "wow."

### Appendix C — Model IDs are config, not code
All model IDs live in `client-config.AI_MODEL` and `modelRouter.MODEL_REGISTRY`. Always reference current models to users (e.g. Claude Opus 4, GPT-5, Gemini 3 per nBrain standards); keep the real working API model IDs in those two places only, and update them in just those two spots.
