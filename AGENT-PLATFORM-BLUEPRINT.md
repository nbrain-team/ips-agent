# Enterprise AI Agent Platform — Complete Build Blueprint (Client-Agnostic)

> **Purpose of this document.** This is a complete, self-contained context file for building a **private, owned, enterprise AI agent platform** — a "Centralized AI Brain" — inside a brand-new Cursor project, for any client, in any industry, with any data sources. It documents the exact architecture, components, patterns, schemas, API contracts, and hard-won production lessons of an in-production enterprise agent platform (built by nBrain, proven across multiple client deployments: a media agency, a retail brand, and an industrial-services company). Everything here is **deliberately client-agnostic**: brand identity, domain prompts, and data connections are isolated behind clean seams so the same platform can be re-pointed at a new business in days.
>
> **How to use this in a new project:** Drop this file at the root of the new repo, open it in Cursor, and tell the agent: *"Read `AGENT-PLATFORM-BLUEPRINT.md` and scaffold the platform described in it for {{CLIENT_NAME}}."* Then work section-by-section using the build plan in Part 15. Placeholders in this document use `{{CLIENT_NAME}}` / `{{client-slug}}` / `{{clientdomain.com}}` — replace them everywhere during the build.
>
> **The three things that change per client** (everything else ports verbatim):
> 1. **Identity** — `client-config.js` (name, brand, system prompts, domain agent modules).
> 2. **Data connections** — which databases/APIs/documents the agent can reach (Part 14, the Data-Source Playbook).
> 3. **Theming** — Tailwind tokens, logo asset, product copy, prompt-library starters.

---

## Table of Contents

- Part 1 — What You're Building (Executive Overview)
- Part 2 — High-Level Architecture
- Part 3 — Tech Stack (exact dependencies)
- Part 4 — Repository Structure
- Part 5 — Backend Deep Dive
  - 5.1 `server.js` — application wiring, schedulers, safety nets
  - 5.2 `client-config.js` — the customization hub
  - 5.3 `agentFlags.js` — the intelligence-layer kill switches
  - 5.4 `orchestrator.js` — the brain (TOOL_USE / PLAN / DEEP RESEARCH)
  - 5.5 `toolRegistry.js` + the tool authoring pattern
  - 5.6 `modelRouter.js` — multi-model orchestration
  - 5.7 The NL→SQL data layer
  - 5.8 The secondary read-only database pattern
  - 5.9 Agent intelligence layer (memory, self-correction, validators, traces…)
  - 5.10 Email / calendar / file integrations (Microsoft Graph pattern)
  - 5.11 Meeting-transcript ingestion (webhook pattern)
  - 5.12 Document processing (isolated-worker extraction)
  - 5.13 Knowledge base: crawler, ingestion, hybrid search
  - 5.14 Ops layer: failure inbox + admin ops dashboard
  - 5.15 Realtime (`websocket.js`)
  - 5.16 Full API surface
  - 5.17 SSE streaming protocol (the frontend contract)
  - 5.18 Auth & security model
- Part 6 — Frontend Deep Dive
- Part 7 — Database Schema (full migration catalog)
- Part 8 — Environment Variables
- Part 9 — Local Development
- Part 10 — Deployment (Render blueprint + lessons)
- Part 11 — The Feedback & Learning Loop
- Part 12 — Observability, Usage & Cost Analytics
- Part 13 — Onboarding Features (self-inventory, chat import, tips page)
- Part 14 — ⭐ The Data-Source Playbook (the part that changes per client)
- Part 15 — Step-by-Step Build Plan
- Part 16 — Customization Checklist
- Part 17 — Production Lessons Baked In (do not skip)
- Appendices

---

## Part 1 — What You're Building (Executive Overview)

A **private, owned, enterprise AI agent platform** with a ChatGPT/Claude-grade chat experience wired directly into the client's own data and workflows. It is NOT a ChatGPT wrapper. It is a full platform with:

- A **multi-turn agentic orchestrator** that lets the LLM call tools, inspect results, and keep going (up to 15 tool calls per turn) until it can answer — with intermediate "thinking" text suppressed so users only see the final answer.
- **Native text-to-SQL** over the client's live operational database(s): natural language → semantic table discovery → generated read-only SQL → executed → synthesized answer. Works against **multiple Postgres databases simultaneously** (a primary platform DB plus any number of read-only secondary business systems, each behind its own tool).
- **Model-agnostic routing** across Anthropic Claude, OpenAI GPT, and Google Gemini — the best model is chosen per task type, with automatic fallback and per-model latency tracking.
- **Streaming responses** over Server-Sent Events with live "what's happening" status, token-by-token output, heartbeats for proxies, graceful retry on rate limits, and server-side cancellation when the user hits Stop.
- **Artifacts** — the agent renders interactive HTML, Chart.js charts, Mermaid diagrams, SVG, and rich markdown in a side panel (like Claude Artifacts), streamed live as they generate.
- An **agent intelligence layer**: cross-session long-term memory, rolling conversation summaries (context beyond the recent-message window), deep-research decomposition, output validators, a **self-correction pass** on low-confidence answers, per-turn observability traces, and confidence scoring.
- A **closed feedback loop**: thumbs up/down with "why?" capture → immediate per-user memory + an admin approval queue → approved feedback becomes standing system-prompt guidance for every future answer.
- **Structured-result retention**: SQL rows behind an answer are stored with the message, so follow-ups like "chart that" or "filter those to Q3" reuse the data instead of re-querying.
- **Specialized agent modules** routed by intent (e.g. a bid/estimate reviewer, a QA validator, an email drafter, a code analyst) — domain expertise encoded as prompt modules, swapped per client.
- **Company email, calendar, and file integration** (Microsoft 365 Graph pattern; adaptable to Google Workspace): tenant-wide hourly email sync with **attachment text extraction**, live calendar lookup, live OneDrive/SharePoint file search — all **permission-scoped** (users see only their own; admins see all).
- **Meeting-transcript ingestion** via webhooks from meeting recorders (Read.ai-style; adaptable to Otter/Fathom/Fireflies): full transcript stored + chunked + embedded so "what did we decide on the call?" just works.
- **In-chat uploads**: screenshots/images via native vision; PDFs/DOCX/XLSX/CSV/TXT via server-side text extraction **run in an isolated child process** so a corrupt file can never take down the API.
- **Knowledge base search** (pgvector + keyword hybrid) over ingested documents and the client's website (crawled on a schedule).
- **Voice input**, **chat history with folders/tags/search/archive**, **prompt library**, **session sharing**, **auto-titled chats**, **regenerate/edit-and-resend**, and **artifact export** (PDF/Excel).
- **An admin ops center**: ingest-pipeline health, per-user/per-model token and cost analytics, a persistent failure inbox, and one-click manual job triggers (re-crawl, re-vectorize, email sync).
- **Enterprise auth**: cookie-session JWT with per-user token-version revocation, password login + optional Microsoft Entra SSO with domain-scoped auto-provisioning, admin user management, and an idempotent admin bootstrap so every fresh deploy has a working login.
- **Multi-channel access**: web chat plus an API-key channel endpoint that funnels into the same brain (extensible to Slack/email/SMS).

**The mental model:** *one brain, many surfaces, model-agnostic, data-source-agnostic.* Everything above the client's business data is reusable. The data line is what you customize per client.

---

## Part 2 — High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          FRONTEND (Next.js 15)                            │
│  Chat UI · SSE streaming · Artifact panel · History · Voice · Uploads ·   │
│  Feedback · Prompt library · Data-inventory page · Tips page ·            │
│  Admin: users + ops dashboard · Account page · Login (password + SSO)     │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTPS (same-origin proxy) + WebSocket
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       BACKEND (Node 20 + Express)                          │
│                                                                            │
│   /api/agent-chat/*  ──►  AgenticOrchestrator                              │
│                              │                                             │
│        ┌─────────────────────┼──────────────────────────┐                 │
│        ▼                     ▼                           ▼                 │
│   TOOL_USE mode         PLAN mode                  DEEP RESEARCH           │
│   (default: LLM calls   (action tasks:            (decompose →             │
│    tools in a loop)      docs/pdf/tasks)           sub-research → synth)   │
│        │                                                                   │
│        ▼                                                                   │
│   ToolRegistry ──► [ NL→SQL tool(s) · vector/hybrid search · email ·       │
│                      calendar · files · data-source inventory ·            │
│                      doc/PDF gen · python · task create ]                  │
│        │                                                                   │
│        ├─► ModelRouter (Claude / GPT / Gemini + fallback + latency)        │
│        ├─► Long-term Memory (pgvector recall + extract)                    │
│        ├─► Conversation Summary (rolling, beyond the 20-msg window)        │
│        ├─► Feedback Guidance (approved feedback → prompt lines)            │
│        ├─► Output Validators · Confidence · Self-Correction pass           │
│        ├─► Agent Traces (per-turn observability)                           │
│        └─► Query Analyzer (complexity → token budget, no LLM call)         │
│                                                                            │
│   Background schedulers: email sync (hourly) · table re-profiling (daily)  │
│   · website re-crawl (weekly) — all best-effort, all report to the         │
│   ingest-failure inbox, none can crash the API                             │
│                                                                            │
│   Webhooks: meeting recorder (signed, ACK-fast, async ingest)              │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  PostgreSQL (+ pgvector)      Secondary DB(s)        External APIs         │
│  • agent_* system tables      • client's existing    • Anthropic           │
│  • knowledge base (vectors)     business systems     • OpenAI              │
│  • email / meetings store       (read-only pools,    • Google AI           │
│  • YOUR business data ◄──       own NL→SQL tool      • Microsoft Graph     │
│    DIFFERENT PER CLIENT         each)                • (client's sources)  │
│                                                                            │
│  Redis (queue/cache)                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Part 3 — Tech Stack

### Backend (`/backend`) — Node.js ≥ 20, Express 4

`package.json` dependencies (proven set — copy exactly, then update versions):

```json
{
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "db:migrate": "node scripts/run-migration.js all",
    "vectorize": "node scripts/vectorize-tables.js",
    "crawl": "node scripts/crawl-website.js",
    "ingest": "node scripts/ingest-local-documents.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@google/genai": "^0.14.0",
    "bcryptjs": "^2.4.3",
    "bull": "^4.16.5",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "express-rate-limit": "^7.5.0",
    "helmet": "^8.0.0",
    "ioredis": "^5.4.2",
    "jsonwebtoken": "^9.0.2",
    "mammoth": "^1.8.0",
    "multer": "^1.4.5-lts.1",
    "openai": "^4.87.0",
    "pdf-parse": "^1.1.1",
    "pdfkit": "^0.15.2",
    "pg": "^8.13.1",
    "socket.io": "^4.8.1",
    "xlsx": "^0.18.5"
  },
  "devDependencies": { "nodemon": "^3.1.9" }
}
```

- **DB:** PostgreSQL via `pg` (Pool), `pgvector` extension for embeddings.
- **Embeddings:** `text-embedding-3-small` (1536 dims) via OpenAI. Pinecone optional; pgvector is the default and works great.
- **Realtime:** `socket.io`. **Queue/cache:** `ioredis` + `bull`.
- **Auth:** cookie session (`cookie-parser` + `jsonwebtoken`), `bcryptjs` password hashing.
- **Security:** `helmet` (strict CSP — safe because the backend serves no HTML), `cors` with explicit origins, `express-rate-limit`.
- **Files:** `multer` (memory storage), `pdf-parse`, `mammoth` (DOCX), `xlsx` (XLSX/CSV), `pdfkit` (PDF generation).

### Frontend (`/frontend`) — Next.js 15 (App Router), React 18, TypeScript

```json
{
  "dependencies": {
    "clsx": "^2.1.1",
    "html2canvas": "^1.4.1",
    "lucide-react": "^0.474.0",
    "next": "^15.1.6",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-markdown": "^9.0.3",
    "remark-gfm": "^4.0.0",
    "socket.io-client": "^4.8.1",
    "tailwind-merge": "^2.6.0"
  },
  "devDependencies": {
    "tailwindcss": "^3.4.17",
    "tailwindcss-animate": "^1.0.7",
    "typescript": "^5.7.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.5.1"
  }
}
```

- Styling: Tailwind CSS 3 + shadcn-style UI primitives. Markdown: `react-markdown` + `remark-gfm`. Icons: `lucide-react`.
- Install with `--legacy-peer-deps` (react-markdown@9 peer quirk); build with `--include=dev` so `typescript` exists at build time.

### Infra

- **Hosting:** Render Blueprint (`render.yaml`) — backend web service, frontend web service, managed Postgres 15, managed Redis (`allkeys-lru`). Any equivalent host works (Railway, Fly, AWS…).
- **Local:** `docker-compose.yml` for Postgres + Redis.

---

## Part 4 — Repository Structure

This is the actual, current layout of the reference build. ⭐ = the files you touch most when adapting to a new client.

```
/backend
  server.js                        # Express app: pools, middleware, brain init, routes, schedulers
  package.json
  env.template.txt                 # copy → .env
  /agentic
    /config
      client-config.js             # ⭐ CLIENT IDENTITY, SYSTEM PROMPTS, BRANDING, MODELS
      agentFlags.js                # feature flags for the intelligence layer
    /services
      orchestrator.js              # ⭐ the brain — tool_use loop, plan mode, deep research, self-correction
      toolRegistry.js              # auto-loads & registers tools
      modelRouter.js               # multi-model routing (Claude / GPT / Gemini)
      multiSourceQueryService.js   # ⭐ NL → SQL pipeline
      TableRouter.js               # semantic table discovery (which tables to query)
      TableMetadataVectorization.js# vectorizes table schemas (per-source-tagged)
      queryAnalyzer.js             # complexity → token-budget heuristic (no LLM call)
      longTermMemory.js            # cross-session pgvector memory (recall/extract)
      deepResearch.js              # decompose → sub-research → synthesize
      outputValidators.js          # entity/claim/brand-voice checks (heuristic)
      confidenceScoring.js         # response confidence + dashboard
      agentTrace.js                # per-turn observability rows
      hybridSearch.js              # vector + keyword search over the knowledge base
      documentProcessor.js         # text extraction + isolated-worker wrapper
      msGraph.js                   # ⭐ Microsoft Graph: app token, tenant users, email sync (swap per client)
      readaiIngest.js              # ⭐ meeting-webhook payload → transcript store + embedded chunks
      ingestFailures.js            # persistent failure inbox writer
      websocket.js                 # presence, typing, live updates
    /tools                         # ⭐ each file = one tool the agent can call
      smartDatabaseTool.js         # NL-to-SQL tool (class; one instance per database)
      vectorSearchTool.js          # semantic knowledge search
      hybridSearchTool.js          # vector + keyword knowledge search
      emailSearchTool.js           # permission-scoped synced-email search (+ attachment text)
      calendarSearchTool.js        # live calendar lookup (permission-scoped)
      fileSearchTool.js            # live OneDrive/SharePoint search (permission-scoped)
      listDataSourcesTool.js       # self-inventory: "what are we connected to?"
      pdfGenerateTool.js           # PDF generation (pdfkit)
      docsCreateTool.js            # structured document creation
      pythonExecuteTool.js         # python analysis (flag-gated; see security note)
      taskCreateTool.js            # task creation
    /routes
      index.js                     # ⭐ sessions, SSE messages, uploads, import, feedback, traces
    /utils
      anthropicRetry.js            # retry/backoff + param sanitizing (withRetry, isRetryable)
      embeddings.js                # embedText + toVectorLiteral helpers
      httpAgent.js                 # shared IPv4/no-keepalive HTTPS agent for LLM calls
  /routes
    auth.js                        # cookie login/logout/session/change-password
    auth-microsoft.js              # ⭐ Entra ID SSO (authorization-code flow) — swap per client IdP
    admin-users.js                 # user management (create, roles, reset/set password)
    admin-ops.js                   # ops dashboard API: health, usage/cost, failures, job triggers
    data-inventory.js              # "what does the agent know?" page API
    exports.js                     # artifact → PDF/Excel export
    output-templates.js            # global + per-user output-format rules
    webhooks.js                    # inbound webhooks (meeting recorder), signed + ACK-fast
    /channels
      api.js                       # API-key channel into the same orchestrator
  /middleware
    requireAuth.js                 # JWT cookie → req.user (checks token_version + is_active)
    requireAdmin.js
    requireUserManager.js
  /bootstrap
    autoMigrate.js                 # boot-time idempotent migrations
    ensureAdmin.js                 # idempotently provision/repair the admin account
  /migrations                      # ordered idempotent SQL (see Part 7)
    001_create_system_tables.sql
    002_create_knowledge_base.sql
    004_create_agent_metadata.sql
    028_create_agent_intelligence.sql
    029_chat_sharing_output_templates.sql
    030_auth_consolidation.sql
    031_microsoft_email.sql
    032_meeting_transcripts.sql
    033_meeting_source.sql
    034_security_token_version.sql
    035_intelligence_upgrades.sql
    036_data_coverage.sql
    037_ops_visibility.sql
    run-migrations.sh
  /scripts
    run-migration.js               # migration runner (single or all)
    vectorize-tables.js            # profile + embed table metadata (both DBs)
    crawl-website.js               # crawl {{clientdomain.com}} into the knowledge base
    ingest-local-documents.js      # ingest local PDFs/docs into the knowledge base
    extract-text-worker.js         # isolated child process for document extraction
    sync-emails.js                 # manual email-sync CLI

/frontend
  /app
    page.tsx                       # redirect → /ai-chat
    layout.tsx, globals.css
    /login/page.tsx                # password + "Sign in with Microsoft" (SSO)
    /ai-chat/page.tsx              # the chat app shell (history + chat + artifacts)
    /data/page.tsx                 # "what does the agent know?" inventory
    /tips/page.tsx                 # user onboarding: what to ask, how features work
    /account/page.tsx              # self-service profile + change-own-password
    /admin/users/page.tsx          # admin user management
    /admin/ops/page.tsx            # admin ops dashboard (health, usage, cost, failures, jobs)
  /components
    /ai-chat
      ChatInterface.tsx            # ⭐ the core chat component (streaming, artifacts, feedback…)
      ArtifactPanel.tsx            # renders html/svg/mermaid/chart/markdown artifacts
      ChatHistory.tsx              # sessions sidebar (folders, tags, search, archive, delete)
      PlanDisplay.tsx              # plan-mode / deep-research step display
      SourceCitation.tsx           # source pills with confidence + SQL provenance
      VoiceInput.tsx               # mic → transcript
      PromptLibrary.tsx            # saved/starter prompts
    /layout/Header.tsx
    /ui                            # shadcn-style primitives (button, card, input, textarea, badge…)
  /lib
    artifactParser.ts              # ⭐ streaming + final artifact extraction
    artifactExport.ts              # export an artifact to file
    promptLibrary.ts               # ⭐ starter prompts (re-author per client)
    utils.ts
  next.config.ts                   # same-origin proxy: /api/* + /socket.io/* + /health → backend
  middleware.ts                    # edge auth gate (session cookie required for pages)
  tailwind.config.ts               # ⭐ brand tokens

render.yaml                        # deployment blueprint
docker-compose.yml                 # local Postgres + Redis
```

---

## Part 5 — Backend Deep Dive

### 5.1 `server.js` — application wiring

Responsibilities, in order (each one is load-bearing):

1. **`require('dns').setDefaultResultOrder('ipv4first')` at the very top** — before any network I/O. Node 18+ resolves IPv6 first; flaky IPv6 egress on cloud hosts manifests as `ERR_STREAM_PREMATURE_CLOSE` on LLM API calls. This line plus the custom HTTPS agent (5.4 notes) is what fixed persistent stream drops in production.
2. **URL normalization shim** for `socket.io` (rewrite `/socket.io?...` → `/socket.io/?...`) so the WS handshake works behind proxies.
3. **Primary Postgres pool** (`max: 20`, SSL toggled by `DATABASE_SSL`).
4. **Optional secondary read-only pool(s)** for existing client business systems. Critical pattern: pass `options: '-c default_transaction_read_only=on'` on the Pool so read-only is **enforced by the database for every connection**, independent of the credential's grants. Size modestly (`max: 10`) to respect the host's connection caps.
5. **Helmet with a strict CSP** (`defaultSrc 'none'` etc.) — safe because the backend serves no HTML pages, and it protects any JSON a browser might render directly.
6. **CORS with an explicit origin allow-list** (`FRONTEND_URL` + localhost) — required because `credentials: true` forbids `*`.
7. `cookie-parser`, `trust proxy`, JSON body parsing at 50mb with **raw body capture** (`verify: (req,_res,buf) => { req.rawBody = buf; }`) for webhook signature verification. Request logging that skips `/health`.
8. **Global API rate limit** per IP (default 600 / 15 min) that **skips `/api/webhooks`** (machine traffic). Per-user chat limits are stricter and live in the chat routes.
9. **Startup sequence:** boot-time idempotent migrations (`runBootstrap`) → `ensureAdmin(dbPool)` (guaranteed working admin login on every deploy) → `clientConfig.validate()` (fail fast on missing env) → `new ToolRegistry()` + `loadToolsFromDirectory(agentic/tools)` → `new AgenticOrchestrator(dbPool, toolRegistry, { secondaryPools })` → Socket.IO init → route mounting.
10. **Health check `/health`** runs a real `SELECT 1` so DB status is accurate; reports uptime and whether secondary DBs are configured. Returns 503 when degraded.
11. **Admin utility endpoints:** `POST /api/admin/vectorize` (re-profile all DBs), `GET /api/admin/database-info` (tables + vector counts), `POST /api/admin/sync-emails` + `GET /api/admin/email-sync-status` (if email integration configured).
12. **Background schedulers** (all optional, all env-tunable, all record failures to the ingest-failure inbox):
    - **Email sync** every `EMAIL_SYNC_INTERVAL_MIN` (default 60), first run 15s after boot.
    - **Table re-profiling** every `TABLE_REPROFILE_INTERVAL_H` (default 24) — catches schema drift, new tables, fresh row counts/date ranges on every DB.
    - **Website re-crawl** every `WEBSITE_RECRAWL_INTERVAL_DAYS` (default 7), spawned as a child process.
    - One-time boot check: vectorize table metadata in the background if stale.
13. **Process-level safety nets:** `unhandledRejection` and `uncaughtException` handlers that log loudly, record to the failure inbox, and **keep the service alive** — background jobs must never take the API down. Fatal *startup* errors still exit.
14. **Graceful shutdown** on SIGTERM (close server, end pools, 5s hard exit).

### 5.2 `client-config.js` — ⭐ THE customization hub

One module = the entire identity of the platform. **This is the #1 file to rewrite per client.** It exports:

- `CLIENT_NAME`, `CLIENT_ID` — e.g. `'{{CLIENT_NAME}}'`, `'{{client-slug}}'`.
- `PINECONE_INDEX` — `{{client-slug}}-knowledge` (only if using Pinecone; pgvector needs nothing).
- `BRAND_COLORS` — primary / primaryDark / secondary / accent / text / background / surface / fontFamily. Sample these from the client's real site CSS and logo; note the source and date in a comment.
- `BRAND_LOGO_URL` — `/{{client-slug}}-logo.png` in the frontend public dir.
- `FEATURES` — toggles (gmail/calendar integrations, code_execution, video, voice, real_time_collaboration, feedback_learning, template_system).
- `AI_MODEL` — model IDs per role: `primary` (Claude, drives all tool use), `content` (GPT), `fast`, `long_context` (Gemini Pro), `flash` (Gemini Flash), `embedding`, `voice_transcription` (Whisper). **Model IDs are config, not code** — they live here and in `modelRouter.MODEL_REGISTRY` only.
- `RATE_LIMITS` — chat / file-upload / background-job windows.
- **`SYSTEM_PROMPTS`** — the brain's personality and rules:
  - **`orchestrator_base`** — the master system prompt. Structure it in this exact order (the mechanics sections port verbatim; only the identity/data sections change per client):
    1. **BRAND & IDENTITY** — who the company is, offices, services, positioning lines, brand voice & writing style, target audience. Verified against the real website; date-stamp the verification.
    2. **CORE PHILOSOPHY** — zero hallucinations, always cite sources with confidence, accuracy first, practical on-brand recommendations.
    3. **YOUR CAPABILITIES** — plain-English list of what the agent can do.
    4. **MANDATORY TOOL USE — DATABASE QUERIES** — for ANY structured-data question, ALWAYS use the NL→SQL tool(s); never answer data questions from memory; the tool handles table discovery automatically.
    5. **CRITICAL TOOLS FOR KNOWLEDGE SEARCH** — hybrid/vector search for company/policy/"what do we do" questions; note that meeting transcripts live in the knowledge base too.
    6. **EMAIL rules** (if wired) — always use the email tool; explain that permission scoping is automatic; never route email questions to the SQL tool.
    7. **SELF-INVENTORY / ONBOARDING** — "what are we connected to?" → always call `list_data_sources` and answer with a friendly bulleted list.
    8. **HOW YOU WORK** — query silently, present results naturally, never announce "let me query the database", include real numbers, format clearly.
    9. **TONE & STYLE** — on-brand, confident, transparent about limits; never start with "Based on the data...".
    10. **CONTEXT MAINTENANCE** — resolve "it/that/those" from history; build on prior results.
    11. **STOP CONDITIONS** — empty DB 2-3 times → stop and say what was tried; always present partial results over nothing.
    12. **The full ARTIFACTS spec** (keep verbatim):
        - Emit `<artifact type="TYPE" title="TITLE">CONTENT</artifact>` for anything that benefits from visual rendering.
        - Types: `html` (self-contained, inline CSS/JS), `svg`, `mermaid` (raw definition only — no fences, no "mermaid" line), `chart` (Chart.js config JSON), `markdown`.
        - HTML artifacts get Chart.js, D3, Mermaid, KaTeX pre-loaded in the sandbox.
        - Anti-repetition rule: at most ONE short sentence before the tag; nothing restated after it.
        - Updates include the full new version. Use artifacts for charts/diagrams/dashboards/calculators, NOT for plain text/bullets/basic tables.
  - **Specialized prompts:** `email_drafter`, `document_creator`, `code_analyst`, plus **domain agent modules** — this is where the client's institutional expertise lives. Reference examples that shipped: an `estimating_reviewer` (bid/RFP review checklist: scope completeness, labor assumptions, materials/lead times, logistics, compliance, margin & risk → structured review with gaps and a go/no-go recommendation) and a `qa_validator` (8-item checklist: factual accuracy, statistical validity, like-for-like comparisons only, tone calibration, compliance, actionability, data completeness, red-flag resolution → PASS/FAIL per item + quality score + APPROVE/REVISE/REJECT). **Author 2–4 modules encoding the new client's domain rules.**
- `TOOLS_CONFIG` — per-tool limits (SQL timeout 30s; vector search `top_k: 10, min_similarity: 0.35` — cosine similarity on text-embedding-3-small lands 0.4–0.6 for good matches, so 0.35 filters noise without starving context; code exec timeout/memory; pdf max pages).
- `KNOWLEDGE_BASE_CATEGORIES` — content taxonomy.
- Helpers (**do not change — the orchestrator depends on these seams**): `getSystemPrompt(context)` (base, or base + `--- SPECIALIZED CONTEXT ---` + module), `getAgentModules()`, `getToolConfig()`, `isFeatureEnabled()`, `validate()` (hard-requires ANTHROPIC_API_KEY, OPENAI_API_KEY, REDIS_URL, DATABASE_URL; warns on missing Pinecone).

### 5.3 `agentFlags.js` — intelligence-layer kill switches

Every intelligence upgrade is independently toggleable via env (`FEATURE_<X>=false`) so it can be dialed back instantly without a code change. All default ON except deep research is also gated per-query by trigger phrases:

```js
memoryEnabled()               // FEATURE_LONG_TERM_MEMORY
deepResearchEnabled()         // FEATURE_DEEP_RESEARCH
validatorsEnabled()           // FEATURE_OUTPUT_VALIDATORS
traceEnabled()                // FEATURE_AGENT_TRACE
feedbackLearningEnabled()     // FEATURE_FEEDBACK_LEARNING
selfCorrectionEnabled()       // FEATURE_SELF_CORRECTION
conversationSummaryEnabled()  // FEATURE_CONVERSATION_SUMMARY
```

Rule: **failures in any flag-gated feature never break a chat turn** — everything is wrapped in try/catch and degrades to "off".

### 5.4 `orchestrator.js` — the brain

The `AgenticOrchestrator` class. Constants: `MAX_TOOL_CALLS = 15`, `MAX_CONSECUTIVE_EMPTY = 3`, `TOOL_LOOP_COOLDOWN_MS = 1500`, `HARD_TOKEN_CAP = 32000`.

**Constructor** takes `(dbPool, toolRegistry, { secondaryPools })`. It instantiates the ModelRouter, LongTermMemory, and an Anthropic client with the shared IPv4/no-keepalive HTTPS agent and `maxRetries: 0` (retries are handled by our own `withRetry` so behavior is observable). Class-based tools get instantiated here: one `SmartDatabaseTool` per database (the primary as `query_operational_database`; each secondary as its own named tool, e.g. `query_billing_database`, with a rich description and explicit "do NOT use for X" routing).

**`processQuery({...})`** — the single entry point for every channel. Signature:

```js
processQuery({
  userMessage, conversationHistory = [], sessionId, userId,
  user = null,                 // { id, email, role } — permission-scoped tools read this
  clientId, projectId = null,
  streamCallback = () => {},   // emits SSE events (Part 5.17)
  imageAttachments = [],       // base64 vision blocks
  documentAttachments = [],    // { filename, text } extracted server-side
  conversationSummary = null,  // rolling summary of turns beyond the window
  isCancelled = () => false,   // server-side stop (client disconnected)
})
```

Steps:
1. `analyzeQuery()` → complexity + token budget; streamed as an `analysis` event.
2. `getOutputGuidance(userId)` → active output templates (global + per-user format rules).
3. **`detectAgentModule(message)`** — regex `MODULE_TRIGGERS` route to specialized modules (estimating/QA/email/code in the reference; author your own). First hit wins; the module's prompt is appended to the base prompt.
4. **Routing:** `PLAN_TRIGGERS` (explicit "create a document/proposal/report", "generate a pdf", "create a task") → PLAN mode. Deep-research trigger phrases (flag-gated) → DEEP RESEARCH. Everything else → **TOOL_USE mode** (the default and the workhorse).
   - Lesson: only keep PLAN triggers for actions that have real tools. "Send email"/"schedule meeting" triggers were removed when no send/calendar-write tools existed — those requests flow through TOOL_USE where the agent drafts content instead of failing.
5. Errors surface as friendly, typed SSE `error` events: 429/529 → "at capacity" + `retryable: true, retryAfterSec`; connection errors → retryable; everything else → honest message.

**TOOL_USE mode (`processWithToolUse`)** — recreate this loop faithfully:

- Recall long-term memories (flag-gated, best-effort). Fetch approved-feedback guidance (cached 5 min).
- Build the system prompt via `buildToolUseSystemPrompt({ memories, outputGuidance, feedbackGuidance, conversationSummary, agentModule })` — see prompt-assembly below.
- Build the message list from the last 20 history messages. **Structured-results retention:** the last 2 assistant messages that carry `structured_results` (retained SQL rows) get them appended as `[STRUCTURED DATA BEHIND THIS ANSWER — reuse for follow-ups instead of re-querying]` blocks (capped 20k chars) — this is what makes "chart that" and "now filter to Q3" work without re-querying.
- Attach images as native Claude vision blocks; append extracted document text as `=== ATTACHED DOCUMENT: name ===` blocks (capped 40k chars each).
- **The multi-turn loop:** stream every turn's text live (optimistic streaming). If the turn ends in `tool_use`:
  - Emit `response_reset` to erase the streamed "thinking" text from the UI (users never see the model talking to itself).
  - Execute each requested tool with context `{ userId, clientId, projectId, sessionId, dbPool, userEmail, userRole }` (the last two power permission-scoped tools).
  - Collect **sources** with grounded provenance: source_type, tool, confidence, summary, **the actual SQL + tables** for DB answers, and document titles/URLs for search answers.
  - Retain structured rows (`{ tool, sql, tables, rowCount, rows: first 30 }`) for future turns.
  - Emit `progress` / `tool_result` / `tool_error` events per tool. Cap tool_result content blocks at 60k chars.
  - Track consecutive-empty results; at 3, inject a system message forcing a final answer describing what was tried.
  - **1.5s cooldown between iterations** (rate-limit protection), check `isCancelled()` each iteration (server-side stop), loop until a turn ends without tool_use or the 15-call cap.
- The final turn's text is the answer. `_streamTurn` wraps the Anthropic streaming call and **retries transient connection drops only if no text has been emitted yet** (up to 4 attempts, 3s×attempt backoff capped at 15s); on the retry path the final text is emitted as one chunk.
- Finalize (below).

**PLAN mode (`processWithPlan`)** — for explicit action tasks: `generateExecutionPlan()` (Claude, temp 0.2, returns strict JSON `{goal, steps:[{tool, description, input}]}`, max 5 steps, with recent history included so "that report we discussed" resolves) → stream the plan → execute steps sequentially with progress events → `synthesizeResponse()` through the ModelRouter → finalize.

**DEEP RESEARCH (`processDeepResearch`)** — decompose the question into sub-questions (via ModelRouter), stream the research plan, then run each sub-question through a **bounded mini tool-loop** (max 5 tool calls, non-streaming, sequential — parallelism trades reliability for speed under rate limits), then synthesize all findings in one streamed final turn with the full system prompt. Cancellation is checked between sub-questions.

**Shared finalization (`_finalizeTurn`)** — every mode ends here:
1. `scoreResponse()` → confidence; `validateOutput()` → `{ quality, issues[] }` (flag-gated).
2. **Self-correction pass** (flag-gated): if the answer is >80 chars AND (confidence < 0.45 OR validators say "review"), run one bounded revision pass — the model gets its own draft + the flagged issues and rewrites it without tools ("do NOT invent new data; state limitations plainly; keep artifact blocks intact"). If the correction differs, emit `response_reset` + re-stream, re-score, and mark `validation.self_corrected = true`. Failures keep the original.
3. Persist the user + assistant messages (`model_used, tokens_used, plan_json, tool_calls, sources, complexity_level, confidence_score, structured_results` — last 4 structured results only). Touch the session's `updated_at`.
4. Record the observability trace (mode, sub-questions, tools, memory hits, validator issues, confidence, tokens, latency).
5. Extract durable memories async (never blocks the response).
6. Return `{ success, response, assistantMessageId, plan, sources, tokensUsed, complexity, confidence, validation, processingTime, mode }`.

**Prompt assembly (`buildToolUseSystemPrompt`)** — ordered parts, joined by blank lines:
1. Base prompt (or base + specialized module).
2. `EARLIER IN THIS CONVERSATION (rolling summary...)` — if a conversation summary exists (capped 4k chars).
3. `LEARNED FROM USER FEEDBACK (admin-approved — always apply):` — approved feedback lines.
4. `WHAT YOU REMEMBER ABOUT THIS USER (from previous sessions):` — recalled memories with types.
5. `OUTPUT FORMAT GUIDANCE (apply when relevant):` — matched output templates.
6. **`AVAILABLE DATA:`** — ⭐ the per-client section: one line per data tool naming what it contains (real table names, real systems), plus explicit `ROUTING:` rules ("billing/invoice questions → query_billing_database; meeting questions → hybrid_search first…"). **Update this every time a data source is wired (Part 14).**
7. `CURRENT DATE: <today, long format>` — required for relative-date math in SQL.

### 5.5 `toolRegistry.js` + the tool authoring pattern

`ToolRegistry` auto-loads every `.js` in `/agentic/tools` that exports `{ name, execute }`, exposes `get(name)`, `getAll()`, `register(tool)` (for class-based tools), and `getToolSchemas()` (turns each tool's `parameters` into a Claude `input_schema`).

**Every object-style tool follows this exact shape** (copy this template for new client tools):

```js
module.exports = {
  name: 'tool_name',                 // unique; what the LLM calls
  description: `One-line summary.

WHEN TO USE: explicit trigger conditions + 2-3 example user phrasings.
(Description quality drives tool-selection accuracy — be rich and explicit,
including "do NOT use for X — use tool_y instead" routing lines.)`,
  category: 'data',                  // data | email | calendar | files | meta | documents | ...
  requiresApproval: false,           // gate destructive actions
  parameters: {                      // becomes the LLM's input_schema
    type: 'object',
    properties: {
      some_arg: { type: 'string', description: 'what it is' },
    },
    required: ['some_arg'],
  },
  async execute(params, context) {
    // context = { userId, clientId, projectId, sessionId, dbPool, userEmail, userRole }
    try {
      return {
        success: true,
        data: { /* rows / items / result */ },
        formatted: '...',            // optional: compact text for the model (preferred over raw data)
        summary: 'N row(s) from X',  // shown in the UI progress line
        confidence: 0.95,
        source_type: 'database',     // surfaces in citations
        source_summary: 'SQL over table_x',
      };
    } catch (error) {
      return { success: false, error: error.message, confidence: 0 };
    }
  },
};
```

**Permission-scoped tool pattern** (email/calendar/files — reuse for any per-user data): read `context.userRole` and `context.userEmail`; non-admins are hard-scoped in SQL/API calls to their own resources (`WHERE mailbox_email = $ownEmail`); an explicit `mailbox` param is admin-only, with a clear "Permission denied: only admins can…" error the model is instructed to relay honestly. **The scoping line lives in the tool, not the prompt** — the prompt explains it, the SQL enforces it.

### 5.6 `modelRouter.js` — multi-model orchestration

- `MODEL_REGISTRY`: logical keys → `{ provider, modelId, strengths, maxTokens, costTier }`, every modelId overridable by env (`ANTHROPIC_PRIMARY_MODEL`, `OPENAI_CONTENT_MODEL`, `GOOGLE_PRO_MODEL`, etc.). Reference set: `claude-primary` (tool_use/agentic/strategy/analysis/synthesis), `claude-fast` (summarization/titles), `gpt-content` (content/creative/email), `gpt-fast` (extraction/classification), `gemini-pro` (long_context/document_analysis/research), `gemini-flash` (fast_tasks).
- `TASK_TO_MODEL` maps task types → keys. `classifyTask(message)` is a regex heuristic (no LLM call).
- `generateText({ taskType, system, prompt, maxTokens, temperature })` — unified interface with **automatic fallback to Claude** when another provider errors, and rolling per-model latency tracking (last 50 calls) exposed via `GET /api/agent-chat/models`.
- Only providers with API keys present are activated; `resolveModel` falls back to `claude-primary` if the chosen provider is unavailable.
- **Provider quirks handled in `_generate`:** newer OpenAI models require `max_completion_tokens` (not `max_tokens`) and only support default temperature — detect by model-ID prefix. Google goes through `@google/genai` `models.generateContent` with `systemInstruction` in config.
- **Tool-use always routes to Claude** (best agentic support). Keep that.

### 5.7 The NL→SQL data layer — ⭐ where clients differ most

Three cooperating pieces, all **source-tagged** so multiple databases coexist:

1. **`smartDatabaseTool.js`** (class, instantiated per database): takes a natural-language `query` (+ optional table `hint`), runs the pipeline, formats up to 100 rows as compact `key: value | key: value` text for the model, and returns `{ data: { rowCount, rows, sql, tables }, formatted, summary, confidence, source_type }`. The SQL and table list ride into the citations. Constructor options: `{ name, description, sourceTag, metadataPool }` — secondary DBs store their metadata vectors **in the primary DB** tagged by source, so schemas never collide.

2. **`multiSourceQueryService.js`** — the pipeline:
   - `getAllTables()` — lists `public` base tables, **excluding** infra tables via an `excludedTables` array (all `agent_*` system tables, email tables, migration bookkeeping — anything the model should never query directly).
   - `TableRouter.discoverRelevantTables()` — semantic discovery over vectorized table metadata: which tables matter for this question.
   - `buildDynamicSchemaContext()` — for each relevant table: columns/types, row counts, date ranges, and **sample rows** (from `agent_metadata.table_vectors`, `information_schema` fallback) so the model writes correct SQL against real columns.
   - `generateSQL()` — Claude at temp 0.1 writes **one read-only SELECT**, given the current date (relative-date math) and strict rules (only listed tables, quote unusual identifiers, LIMIT lists, aggregate big tables). **Hard safety check rejects DROP/DELETE/UPDATE/INSERT/ALTER/CREATE/GRANT/REVOKE.**
   - `executeQuery()` — `SET statement_timeout = 30000`, run, return rows. Empty/failed → retry with alternative table phrasing.
   - `logQuery()` — every run logged to `agent_metadata.query_history` for learning/debugging.

3. **`TableMetadataVectorization.js`** + `scripts/vectorize-tables.js` — profiles every data table (columns, types, row counts, date ranges, sample rows), embeds a searchable description, stores it in `agent_metadata.table_vectors` **with a `source_tag`**. Run after loading data (`npm run vectorize` or `POST /api/admin/vectorize`), re-run on the daily scheduler, and expose a `needsVectorization()` staleness check for the boot-time background pass. **The agent can only query what table discovery knows about.**

### 5.8 The secondary read-only database pattern

Most clients have an existing line-of-business system with its own Postgres (billing, ERP, CRM…). Two integration options; **Option B is the default** (strong isolation):

**Option B — separate read-only pool + dedicated tool (default):**
- A second `pg.Pool` from `{{SECONDARY}}_DATABASE_URL` with `max: 10`, SSL, and `options: '-c default_transaction_read_only=on'` (DB-enforced read-only regardless of the credential).
- A second `SmartDatabaseTool` instance registered under its own name (`query_billing_database`, `query_erp_database`, …) with a rich WHEN-TO-USE description and explicit anti-routing ("do NOT use for operational questions — use query_operational_database").
- Vectorize its tables with `sourceTag` + `metadataPool` pointed at the primary DB.
- Add explicit ROUTING rules to the `AVAILABLE DATA` prompt block: which topics go to which tool.
- Trade-off: no single query can JOIN across the two DBs — the agent synthesizes across tool calls instead. In practice this is fine.

**Option A — `postgres_fdw` (unified surface, cross-DB joins):** mount the secondary tables into the primary DB as a read-only foreign schema (`CREATE EXTENSION postgres_fdw` → `CREATE SERVER` → read-only `USER MAPPING` → `IMPORT FOREIGN SCHEMA ... INTO secondary_schema`). One brain, one queryable surface, joins work. Watch-out: heavy cross-DB analytical joins are slow — add materialized views or a nightly sync for those.

**Universal rules (either option):** dedicated read-only DB role (least privilege) on top of the SELECT-only SQL guard; never expose the connection string to the frontend; store it as a `sync: false` deploy secret; vectorize the schema or the agent can't see it.

### 5.9 Agent intelligence layer (all flag-gated, all best-effort)

- **`longTermMemory.js`** — durable, cross-session, per-user semantic memory. `recall(userId, message)` before answering (pgvector cosine over `agent_memories`); `extract(userId, userMessage, response)` after answering persists new facts/preferences/projects/style, deduped by `(user_id, md5(content))`. Also seeded from chat imports and feedback (Parts 11, 13).
- **Rolling conversation summary** (lives in the chat routes, feeds the orchestrator): when a session exceeds 20 messages, everything older than the last 16 is incrementally folded into `agent_chat_sessions.summary` (dense, factual, ~350 words max: decisions, findings + key numbers, open questions, preferences, topics) via the cheap summarization model, tracked by `summary_thru_message_id`. Runs async after each turn; never blocks. The summary rides into the system prompt so long conversations keep their memory.
- **`deepResearch.js`** — `shouldTrigger(message)` on strong phrases ("deep dive", "comprehensive research"…); `decompose()` returns sub-questions; the orchestrator runs the loops (5.4).
- **`outputValidators.js`** — post-answer heuristic checks (entity consistency, unsupported claims, brand voice). Returns `{ quality: 'ok'|'review', issues[] }`; feeds self-correction; never throws.
- **Self-correction** — one bounded, tool-less revision pass on low-confidence/flagged answers (details in 5.4). The single highest-leverage quality upgrade for its cost.
- **`confidenceScoring.js`** — `scoreResponse({ responseText, toolResults, sources })` → 0–1; logged per message; `getDashboard()` powers `GET /api/agent-chat/confidence`.
- **`agentTrace.js`** — one consolidated row per turn in `agent_traces` (mode, sub-questions, tools used, memory hits, validator issues, confidence, tokens, latency). `getRecentTraces()` powers the admin traces endpoint and the ops dashboard's per-mode analytics.
- **`queryAnalyzer.js`** — fast heuristic complexity classifier → token budget (quick 4k / standard 16k / detailed 32k / comprehensive up to the 32k hard cap). Deliberately **not** an LLM call (saves rate limit and latency).
- **Feedback learning** — see Part 11.

### 5.10 Email / calendar / file integrations (Microsoft Graph pattern)

The reference implementation is Microsoft 365; the *pattern* (app-level sync + permission-scoped tools + live queries) adapts to Google Workspace or any suite. Generalize the module name (`msGraph.js`) if the new client uses something else.

**`msGraph.js`** — two auth modes:
- **APP (client credentials):** tenant-wide sync for ALL users before anyone signs in. Requires APPLICATION permissions (`User.Read.All` + `Mail.Read`, admin consent). App token cached until 5 min before expiry. All Graph GETs retry on 429/503 honoring `Retry-After` (4 attempts).
- **DELEGATED (auth code):** user SSO sign-in (5.18).

**Email sync (`syncAllMailboxes`)** — the shape that makes it production-grade:
- Enumerate tenant users → upsert into `ms_mailboxes` (skip guests / `#EXT#`).
- Per mailbox: sync the last `EMAIL_SYNC_DAYS` (default 30). **Incremental** runs overlap 1 day past `last_synced_at`; **initial** runs get a much higher page cap (80 pages × 50 msgs vs 20) so busy inboxes backfill fully. Bodies fetched as text (`Prefer: outlook.body-content-type="text"`), HTML-stripped, capped 20k chars. Upserts idempotent on `ms_message_id`.
- **Attachments:** for messages with attachments, download files ≤8MB with extractable extensions (pdf/docx/xlsx/pptx/csv/txt/md/json/html), extract text **in the isolated worker** (5.12), store in `ms_email_attachments` with per-attachment error capture. A per-message existence check prevents re-downloading the same files every hourly run.
- Per-mailbox failures (unlicensed mailbox, consent errors) are recorded on `ms_mailboxes.sync_error` and never abort the run. A module-level `syncInFlight` lock prevents overlapping runs. Returns a summary `{ discovered, mailboxes, synced_ok, failed, new_messages, duration_s }`.
- **Retention decision:** synced mail stays searchable forever (no pruning); the search window just defaults to 30d and can widen to 365 on request.

**The three permission-scoped tools** (full pattern in 5.5):
- `search_user_emails` — SQL over `ms_emails` with FTS ranking (generated `tsvector` column) + subject ILIKE + **attachment-content matching** (searches extracted attachment text too, and returns it inline with results). Hard visibility scope: non-admins get `mailbox_email = ownEmail` injected unconditionally.
- `search_calendar` — **live** Graph `calendarView` (not synced): days back/ahead, timezone preference, filters cancelled events, returns organizer/attendees/join-URL. Degrades with an explicit "IT needs to grant Calendars.Read (application) permission" error until consent exists.
- `search_files` — **live** OneDrive/SharePoint `drive/root/search`: names, sizes, modified dates, folders, web links (no content download). Same permission model, same graceful 403 message for `Files.Read.All`.

**Critical safety rule:** the email tables are in the NL→SQL layer's `excludedTables` — **the permission-scoped tool is the ONLY path to email**, so the generic SQL engine can never leak someone else's mailbox.

### 5.11 Meeting-transcript ingestion (webhook pattern)

Reference: Read.ai meeting-end webhooks; the same pattern fits Otter/Fathom/Fireflies/Zoom.

**`routes/webhooks.js`** — the hardened inbound-webhook shape:
- Path-secret auth: `POST /api/webhooks/readai/:secret` compared timing-safely to `READAI_WEBHOOK_SECRET` (503 until configured).
- Optional HMAC signature verification over the **raw body** (`X-Read-Signature`); when the vendor's docs are ambiguous about key/digest encodings, accept any (utf8|base64 key × hex|base64 digest) combination, all timing-safe. If the signing key env is set, a valid signature is REQUIRED.
- Accepts `text/plain` bodies too (lets a browser-based backfill script avoid CORS preflight; body still JSON + signature-verified, with a `?sig=` fallback).
- **ACK immediately, ingest asynchronously** — vendors time out on long transcripts. Ignore non-`meeting_end` triggers. Failures → the ingest-failure inbox with the meeting title as the reference.
- Webhooks are **excluded from the global rate limiter**.

**`readaiIngest.js`** — payload → knowledge:
- Liberal payload parsing (title, times, owner, participants, summary, action items, key questions, topics, report URL, transcript from speaker blocks as `Name: words` lines).
- Full record upserted into `meeting_transcripts` idempotently on the vendor session id (re-delivered webhooks replace, never duplicate).
- **Chunking strategy:** chunk 0 is a high-value **overview chunk** (summary + action items + key questions + topics) — the best retrieval target for "what did we decide"; then transcript chunks of ~2,200 chars split on line boundaries. Every chunk is prefixed with a context header: `[Meeting: "title" on date — participants: …]`.
- Chunks embedded into the knowledge base (`website_content`, category `meeting_transcript`, url = `readai:<session_id>` as the replace-key). Old chunks deleted before re-insert. `chunk_count` recorded.
- A `source` column distinguishes vendors (read.ai webhook vs otter backfill etc.).

### 5.12 Document processing (isolated-worker extraction)

**`documentProcessor.js`** extracts text from PDFs (`pdf-parse`), DOCX (`mammoth`), XLSX/XLS/CSV (`xlsx`, per-sheet CSV, 10 sheets × 50k chars), and plain text. Images are handled separately as native vision blocks (`IMAGE_MIMES` allow-list).

**The production lesson — `extractTextIsolated()`:** malformed PDFs can make pdf.js spin and balloon memory; run in-process that blocks the event loop, fails the health check, and **crash-loops the whole API**. So all extraction (uploads AND email attachments) runs in a **spawned child process** (`scripts/extract-text-worker.js`) with `--max-old-space-size=256`, a 30s SIGKILL timeout, and stdin/stdout JSON piping. Resolves `{ text }` or `{ error }` — never rejects, never takes down the API. A bad file just kills the worker.

### 5.13 Knowledge base: crawler, ingestion, hybrid search

- **`scripts/crawl-website.js`** — crawls `{{clientdomain.com}}` into `website_content` (chunked, embedded, content-hash deduped, `source = 'website'`). Run at build time (`npm run crawl`), on the weekly scheduler, and on demand from the ops dashboard.
- **`scripts/ingest-local-documents.js`** — ingests local PDFs/docs into the same store with categories.
- **`hybridSearch.js`** + `vectorSearchTool.js` / `hybridSearchTool.js` — pgvector cosine (ivfflat index) + Postgres FTS keyword search, merged. `top_k: 10, min_similarity: 0.35`. Everything lands in one store — site content, documents, meeting transcripts — so one search tool covers "what does the company do", "what's our policy on X", and "what did we discuss Tuesday".
- **`utils/embeddings.js`** — `embedText()` (OpenAI `text-embedding-3-small`) + `toVectorLiteral()` for pgvector inserts.

### 5.14 Ops layer: failure inbox + admin ops dashboard

- **`ingestFailures.js`** — `recordFailure(dbPool, { source, reference, error, detail })` writes to `ingest_failures`. Every background pipeline (webhook ingest, email sync, crawls, vectorization, even `unhandledRejection`) records here instead of only console-logging, so problems are visible and clearable from the admin UI. Failure-recording itself can never break the caller.
- **`routes/admin-ops.js`** (admin-gated):
  - `GET /health` — one JSON snapshot of every ingest pipeline: mailbox sync counts/status, email + attachment totals and latest timestamps, meeting counts, table-vector counts per source, website page counts + last crawl, knowledge chunk totals, secondary-DB connectivity, open failure count, and live job state.
  - `GET /usage?days=30` — token/message/latency analytics (Part 12).
  - `GET /failures` + `POST /failures/:id/resolve` — the failure inbox.
  - `POST /crawl` and `POST /vectorize` — manual job triggers with in-process `jobState` (409 if already running; last result/error/exit recorded so the UI shows "running…"/history).

### 5.15 Realtime (`websocket.js`)

Socket.IO handlers: `join_session`/`leave_session` (presence in `agent_session_presence`), `typing_start`/`typing_stop`, `plan_modified` (owner-gated broadcast), disconnect cleanup. Helpers `broadcastToSession()` and `sendNotificationToUser()`. Same-origin path `/socket.io/` so the session cookie rides along. Safe to keep even for single-user deployments.

### 5.16 Full API surface

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`, `POST /api/auth/change-password` |
| SSO | `GET /api/auth/microsoft` (302 to IdP), `GET /api/auth/microsoft/callback` |
| Users (admin) | `GET/POST /api/admin/users`, role updates, reset/set password |
| Sessions | `POST/GET /api/agent-chat/sessions`, `GET/PUT/DELETE /sessions/:id`, `POST /sessions/:id/generate-title` |
| Messaging | `POST /api/agent-chat/sessions/:id/message` (SSE; supports `regenerate` to edit-and-resend) |
| Uploads | `POST /api/agent-chat/upload` (multer, 25MB, ≤8 files) |
| Import | `GET /api/agent-chat/migration-prompt`, `POST /api/agent-chat/import` |
| Feedback | `POST /messages/:id/feedback`, `GET /feedback/pending` (admin), `POST /feedback/:id/approve` (admin) |
| Observability | `GET /api/agent-chat/admin/traces`, `GET /api/agent-chat/confidence` |
| Meta | `GET /api/agent-chat/tools`, `GET /api/agent-chat/models` |
| Data inventory | `GET /api/data-inventory` (powers the /data page) |
| Exports | `POST /api/exports` (artifact → PDF/Excel) |
| Output templates | `GET/POST/PUT/DELETE /api/output-templates` |
| Channels | `POST /api/channels/api` (API-key entry into the orchestrator) |
| Webhooks | `POST /api/webhooks/readai/:secret` (meeting recorder) |
| Admin ops | `GET /api/admin/ops/health`, `GET /usage`, `GET /failures`, `POST /failures/:id/resolve`, `POST /crawl`, `POST /vectorize` |
| Admin utility | `POST /api/admin/vectorize`, `GET /api/admin/database-info`, `POST /api/admin/sync-emails`, `GET /api/admin/email-sync-status` |
| Health | `GET /health` (real `SELECT 1`) |

Chat-route implementation notes worth porting exactly:
- **In-memory chat rate limit:** 10 messages/min/user (429 with `retryAfterSec: 30`).
- **Auto-title inside the stream:** if the session is still "New chat" after a successful exchange, generate a 3–6-word title via the cheap `classification` model with a **hard 10s timeout** and a first-message-truncation fallback, then emit a `session_title` SSE event. (Cheap model on purpose: a primary-model 529 backoff must never block the stream.)
- **Regenerate/edit-and-resend:** `regenerate: true` deletes the last user message and everything after it, then re-processes (optionally with edited text).
- **Server-side stop:** `res.on('close')` sets a flag; the orchestrator's `isCancelled()` halts the tool loop between turns so a closed tab stops burning tokens.
- **15s SSE heartbeat** (`: ping`) so proxies don't drop long runs.
- History pulled with `structured_results`; session summary passed to the orchestrator; `maybeUpdateSummary()` fired-and-forgotten after `complete`.

### 5.17 SSE streaming protocol (the frontend contract — keep identical)

Events are `data: {json}\n\n` lines with `{ type, data }`:

| `type` | when | payload `data` |
|---|---|---|
| `analysis` | after complexity analysis | `{ complexity, token_allocation, reasoning }` |
| `plan` | plan/deep-research planned | plan object incl. `mode` |
| `progress` | a tool is running | `{ step, total, tool, status }` |
| `tool_result` | a tool returned | `{ step, tool, success, summary }` |
| `tool_error` | a tool failed | `{ step, tool, error }` |
| `response_chunk` | streamed answer text | `{ content }` (append) |
| `response_reset` | streamed text was provisional (thinking discarded, or self-correction replaced it) | `{}` (clear the buffer) |
| `session_title` | auto-title landed | `{ title }` |
| `complete` | turn finished | full result object (`assistantMessageId`, `sources`, `confidence`, …) |
| `error` | failure | `{ error, errorType, retryable, retryAfterSec }` |

### 5.18 Auth & security model

- **Cookie sessions:** httpOnly `session` cookie, JWT `{ sub, role, tv }`, 7-day expiry, `sameSite: lax`, `secure` in production. Same-origin proxy means no cross-site cookie pain.
- **Token-version revocation:** `users.token_version` int; the JWT carries `tv` and `requireAuth` rejects mismatches — bumping the version invalidates all of a user's existing sessions (password change, force-logout, disable).
- **`requireAuth` middleware** verifies the JWT, loads the user, checks `is_active` and `token_version`, attaches `req.user = { id, email, role }`.
- **Password auth:** bcrypt hashes, `must_change_password` flow, admin create/reset.
- **`ensureAdmin` bootstrap:** on every boot, provision/repair the `ADMIN_EMAIL`/`ADMIN_INITIAL_PASSWORD` account idempotently — a fresh deploy always has a working admin login.
- **SSO (Entra ID authorization-code flow; adapt per IdP):** `GET /api/auth/microsoft` → IdP → callback **proxied through the frontend domain** (so the cookie lands on the web origin). CSRF-protected via a short-lived JWT `state`. **Provisioning rules:** sign-ins from `SSO_ALLOWED_DOMAIN` are auto-provisioned as role `user` (random password hash); other addresses are NOT auto-provisioned (pre-created by admins only); existing users keep their role and just get the IdP object id attached. Disabled accounts bounce with `account_disabled`.
- **Defense in depth on data:** SELECT-only SQL guard + statement timeout + row caps (5.7); DB-enforced read-only secondary pools (5.8); permission-scoped tools with SQL-level visibility (5.10); email excluded from generic SQL; webhooks path-secret + HMAC + timing-safe compares; strict CSP; explicit CORS; global + per-user rate limits; secrets only in env / `sync: false` deploy config.
- **Code execution caution:** the python tool runs on the host — **keep `FEATURE_CODE_EXEC=false` in production** until it's moved to an isolated runtime (container/microVM).

---

## Part 6 — Frontend Deep Dive

### 6.1 `ChatInterface.tsx` — the core component (recreate closely)

- **Streaming reader:** `fetch` the SSE endpoint, read the body stream, buffer by `\n`, parse `data:` lines, react per event type (table 5.17). Handle `response_reset` by clearing the in-progress answer buffer (thinking text / self-correction replacement). Handle `session_title` by updating the sidebar live.
- **Live status:** while loading, animated dots + a status line. A `friendlyTool(name)` map turns internal tool names into human phrases ("Querying the database", "Searching documents & knowledge", "Searching your email", "Checking the calendar"…); between events it cycles generic working phrases. The moment answer text streams, the status clears.
- **Artifacts:** `StreamingArtifactParser` splits clean prose from `<artifact>` blocks in real time; artifacts populate the right-hand panel; inline `[artifact:id:title]` placeholders render as clickable cards in the message.
- **Markdown:** `react-markdown` + `remark-gfm` with a full custom component map (headings, lists, tables with horizontal scroll, code blocks, blockquotes, links in new tabs).
- **Feedback:** thumbs-up posts immediately; thumbs-down opens a "What was wrong? This trains the agent." box, then posts with the reason — the highest-signal training input (Part 11).
- **Attachments:** file picker + **paste-to-upload** (screenshots!) + drag-drop; uploads to `/upload`, shows chips, sends descriptors with the message; can send with attachments only.
- **Voice input:** `VoiceInput` mic → transcript into the composer.
- **Resilience:** 429 handling with auto-retry countdown ("at capacity — retrying in Ns" + Retry Now / Cancel); graceful message if the stream drops mid-run; **Stop** button aborts via `AbortController` (which also triggers the server-side cancel); regenerate + edit-and-resend on the last exchange.
- **Auth:** all calls `credentials: 'include'`; socket connects same-origin with `path: '/socket.io/'`.

### 6.2 Artifact system

- **`lib/artifactParser.ts`** — `parseArtifacts(text)` for completed messages and `StreamingArtifactParser` for live streams. Types: `html`, `svg`, `mermaid`, `chart` (Chart.js JSON), `markdown`.
- **`ArtifactPanel.tsx`** — HTML in a sandboxed iframe with Chart.js/D3/Mermaid/KaTeX preloaded; mermaid via mermaid.js; chart via Chart.js; markdown via react-markdown. Copy + export buttons.
- **`lib/artifactExport.ts`** + backend `/api/exports` — artifact → downloadable PDF/Excel.

### 6.3 Pages & components

- **`ChatHistory.tsx`** — sessions sidebar: folders/tags/search, rename, archive, delete (always visible), shared/private indicator.
- **`PlanDisplay.tsx`** — plan-mode / deep-research steps with live progress.
- **`SourceCitation.tsx`** — source pills under answers with confidence, and expandable provenance (the actual SQL + tables for DB answers; document links for search answers).
- **`PromptLibrary.tsx`** + `lib/promptLibrary.ts` — starter + saved prompts. ⭐ Author client-flavored starters that exercise every capability (a data question, a chart request, an email search, a meeting recap, a document draft).
- **`/app/data/page.tsx`** — read-only "what does the agent know?" inventory from `/api/data-inventory` (tables with row counts and freshness, knowledge collections, email/meeting counts).
- **`/app/tips/page.tsx`** — a user-onboarding page: what to ask, example prompts per data source, how uploads/artifacts/feedback work. Cheap to build, big adoption lever.
- **`/app/account/page.tsx`** — self-service profile + change-own-password.
- **`/app/admin/users/page.tsx`** — list/create users, set roles, reset/set passwords.
- **`/app/admin/ops/page.tsx`** — the ops dashboard: pipeline health cards, usage/cost charts (daily tokens, by user, by model with $ estimates, by mode with latency/confidence), the failure inbox with resolve buttons, and Run-Now buttons for crawl/vectorize/email-sync.
- **`/app/login/page.tsx`** — password form + "Sign in with Microsoft" button (shown when SSO configured), with error-code messaging from the SSO redirects.
- **`/components/ui/*`** — shadcn-style primitives (button, card, input, textarea, badge, scroll-area, separator).

### 6.4 Proxy + edge auth

- **`next.config.ts`** rewrites `/api/*`, `/socket.io/*`, and `/health` to the backend (`NEXT_PUBLIC_API_BASE_URL`) so the app is same-origin — cookies and WS "just work".
- **`middleware.ts`** — edge gate: pages require the `session` cookie (redirect to `/login?next=…`); `/api`, `/socket.io`, static assets, and `/login` pass through (APIs enforce auth server-side themselves).

### 6.5 Branding/theming

Brand colors live in `client-config.js` (backend) and Tailwind theme tokens (frontend). Per client: define the palette as Tailwind tokens, swap the logo asset, update product copy (header, landing, tips, prompt starters). The structure never changes; only tokens/assets/copy do.

---

## Part 7 — Database Schema (full migration catalog)

All migrations are idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`); several re-run safely on boot via `bootstrap/autoMigrate`. Keep the numbering — it encodes dependency order.

| Migration | Contents |
|---|---|
| **001** system tables | `users` (email, password_hash, role, is_active, must_change_password), `agent_chat_sessions` (user_id, client_id, project_id, title, folder, subfolder, tags, is_archived, visibility), `agent_chat_messages` (role, content, model_used, tokens_used, plan_json, tool_calls, sources, search_method, complexity_level, confidence_score), `agent_artifacts`, `agent_templates`, `agent_session_presence`, `agent_feedback` (rating, categories, feedback_text, training_instruction, approval workflow), `agent_user_preferences`, `agent_background_jobs`, notification tables, GIN/FTS indexes, `updated_at` triggers |
| **002** knowledge base | `pgvector` extension + `website_content` (url, title, content, category, source, `vector(1536)` embedding, content_hash, ivfflat cosine index + FTS GIN index) |
| **004** agent metadata | `agent_metadata` schema: `table_vectors` (vectorized table profiles, **source_tag column**), `query_history` (every NL→SQL run), `query_patterns` |
| **028** intelligence | `agent_memories` (`vector(1536)`, ivfflat, dedupe on content hash), `agent_traces` |
| **029** sharing + templates | chat `visibility`, `agent_output_templates` (global + per-user format rules) |
| **030** auth consolidation | guarantee `role`/`is_active`/`must_change_password`/`name` columns exist; `LOWER(email)` index |
| **031** email integration | `users.ms_object_id` + `auth_provider`; `ms_mailboxes` (tenant users, sync status/error, message_count); `ms_emails` (message id, mailbox_email as the **visibility scope key**, addresses as TEXT[], body_text, **generated `tsvector` FTS column**, web_link) + mailbox/from/FTS indexes |
| **032** meeting transcripts | `meeting_transcripts` (vendor session_id UNIQUE, title, times, owner, participants/action_items/key_questions/topics as JSONB, report_url, transcript_text, chunk_count, raw_payload) |
| **033** meeting source | `meeting_transcripts.source` (which recorder vendor) |
| **034** security | `users.token_version` for JWT revocation |
| **035** intelligence upgrades | `agent_chat_sessions.summary` + `summary_thru_message_id` (rolling summary); `agent_chat_messages.structured_results` JSONB (retained SQL rows) |
| **036** data coverage | `ms_email_attachments` (extracted text, extract_error, FTS GIN index over filename+content) + missing indexes flagged in audit (emails by date, feedback by status, artifacts by session…) |
| **037** ops visibility | `ingest_failures` (source, reference, error, detail JSONB, resolved workflow) |

Plus **the client's business data tables** — the part that changes per client (Part 14).

> Historical note: the numbering has gaps (003, 005–027) because client-specific migrations from prior deployments were deliberately dropped. Keep the gap-tolerant runner.

---

## Part 8 — Environment Variables

Copy `env.template.txt` → `.env`. The full generalized set:

```bash
# ----- DATABASE -----
DATABASE_URL=postgresql://user:password@host:5432/{{client_slug}}_ai
DATABASE_SSL=true

# ----- AUTH -----
JWT_SECRET=change-me-in-production
ADMIN_EMAIL=admin@{{clientdomain.com}}          # ensureAdmin provisions this on boot
ADMIN_INITIAL_PASSWORD=change-me-strong

# ----- AI MODELS -----
ANTHROPIC_API_KEY=sk-ant-...                    # REQUIRED (tool use / the brain)
OPENAI_API_KEY=sk-...                           # REQUIRED (embeddings, content, Whisper)
GOOGLE_AI_API_KEY=...                           # optional (enables Gemini routing)
# Model-ID overrides (defaults live in modelRouter.MODEL_REGISTRY):
# ANTHROPIC_PRIMARY_MODEL / ANTHROPIC_FAST_MODEL / OPENAI_CONTENT_MODEL /
# OPENAI_FAST_MODEL / GOOGLE_PRO_MODEL / GOOGLE_FLASH_MODEL

# ----- VECTOR DB (pgvector is default; Pinecone optional) -----
PINECONE_API_KEY=
PINECONE_INDEX_NAME={{client-slug}}-knowledge

# ----- INFRASTRUCTURE -----
REDIS_URL=redis://localhost:6379
PORT=8080
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
GLOBAL_RATE_LIMIT_MAX=600

# ----- AGENT INTELLIGENCE FLAGS (default ON) -----
FEATURE_LONG_TERM_MEMORY=true
FEATURE_DEEP_RESEARCH=true
FEATURE_OUTPUT_VALIDATORS=true
FEATURE_AGENT_TRACE=true
FEATURE_FEEDBACK_LEARNING=true
FEATURE_SELF_CORRECTION=true
FEATURE_CONVERSATION_SUMMARY=true

# ----- CAPABILITY FLAGS -----
FEATURE_CODE_EXEC=false      # python runs on the host — keep OFF in prod (see 5.18)
FEATURE_VOICE=false
FEATURE_VIDEO=false

# ----- RATE LIMITING -----
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=30

# ----- CLIENT IDENTITY -----
CLIENT_NAME={{CLIENT_NAME}}
CLIENT_ID={{client-slug}}
BRAND_PRIMARY_COLOR=#000000
BRAND_SECONDARY_COLOR=#000000
BRAND_LOGO_URL=/{{client-slug}}-logo.png

# ----- MICROSOFT 365 (or equivalent workspace suite) -----
MS_GRAPH_CLIENT_ID=...                          # Entra app registration
MS_GRAPH_CLIENT_SECRET=...
MS_GRAPH_TENANT_ID=...
MS_GRAPH_REDIRECT_URI=                          # defaults to FRONTEND_URL/api/auth/microsoft/callback
SSO_ALLOWED_DOMAIN={{clientdomain.com}}         # auto-provision scope
EMAIL_SYNC_DAYS=30
EMAIL_SYNC_INTERVAL_MIN=60
MS_SYNC_MAX_PAGES=20
MS_SYNC_MAX_PAGES_INITIAL=80

# ----- MEETING-RECORDER WEBHOOK -----
READAI_WEBHOOK_SECRET=long-random-path-secret
READAI_SIGNING_KEY=                             # HMAC key (enforced when set)

# ----- SCHEDULERS -----
TABLE_REPROFILE_INTERVAL_H=24                   # 0 disables
WEBSITE_RECRAWL_INTERVAL_DAYS=7                 # 0 disables

# ----- SECONDARY DATABASE(S): the client's existing business systems (read-only) -----
# One URL per system; store as deploy secrets, NEVER commit. Create a
# dedicated read-only role on each — do not reuse an app credential.
# {{SECONDARY}}_DATABASE_URL=postgresql://readonly_user:...@host/db
# {{SECONDARY}}_DATABASE_SSL=true

# ----- OTHER CLIENT DATA SOURCES (add connection vars per source wired) -----
# e.g. {{ERP}}_API_KEY=..., {{CRM}}_API_KEY=...
```

---

## Part 9 — Local Development

```bash
# 1. Infra (Postgres + Redis)
docker compose up -d

# 2. Backend
cd backend
cp env.template.txt .env        # fill in keys
npm install
npm run db:migrate
npm run dev                     # nodemon server.js on :8080

# 3. Load the client's data, then teach the agent it exists
npm run crawl                   # ingest {{clientdomain.com}}
npm run ingest                  # ingest local documents (optional)
npm run vectorize               # vectorize table metadata (all DBs)

# 4. Frontend
cd ../frontend
npm install --legacy-peer-deps
npm run dev                     # Next.js on :3000
```

Open `http://localhost:3000/ai-chat`, log in with `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`.

---

## Part 10 — Deployment (Render Blueprint)

`render.yaml` provisions four resources, renamed per client (`{{client-slug}}-backend`, `-frontend`, `-db`, `-redis`):

- **Backend web service:** `rootDir: backend`, `npm install` / `npm start`, `healthCheckPath: /health`. Env wired from the blueprint: `DATABASE_URL` fromDatabase, `REDIS_URL` fromService, `FRONTEND_URL` from the frontend's `RENDER_EXTERNAL_URL`, `JWT_SECRET` generateValue. All secrets `sync: false` (set in dashboard): AI keys, admin bootstrap, secondary DB URLs, Graph credentials, webhook secrets.
- **Frontend web service:** `rootDir: frontend`, build `npm install --legacy-peer-deps --include=dev && npm run build`, `NEXT_PUBLIC_API_BASE_URL` from the backend's `RENDER_EXTERNAL_URL`.
- **Managed Postgres 15** (plan names use hyphens, e.g. `basic-256mb`) + **managed Redis** (`allkeys-lru`).

**Deployment lessons baked in:** frontend build needs `--include=dev` so `typescript` exists; force IPv4 + disable keep-alive on the outbound LLM HTTPS agent (`agentic/utils/httpAgent.js`) and `dns.setDefaultResultOrder('ipv4first')` — this pair fixed persistent `ERR_STREAM_PREMATURE_CLOSE`; put secondary DBs in the same region as the platform when possible; the SSO redirect URI goes through the **frontend** domain.

---

## Part 11 — The Feedback & Learning Loop

Four reinforcing mechanisms — port all of them:

1. **Immediate personal memory:** any thumbs-down comment or explicit `training_instruction` is extracted into that user's long-term memory right away ("treat as a standing preference").
2. **Admin approval queue → global guidance:** `GET /feedback/pending` lists feedback with context; `POST /feedback/:id/approve` promotes it. Approved instructions become `LEARNED FROM USER FEEDBACK (admin-approved — always apply)` lines in every system prompt (latest 15, cached 5 min, cache busted on approval). Personal preferences apply instantly; **global behavior changes require a human in the loop.**
3. **Output templates** (`/api/output-templates`): standing format rules, global or per-user, injected as `OUTPUT FORMAT GUIDANCE`.
4. **Query history** (`agent_metadata.query_history`): every NL→SQL run logged for tuning table descriptions and prompts.

---

## Part 12 — Observability, Usage & Cost Analytics

- **Agent traces** (`agent_traces`): one row per turn — mode, sub-questions, tools used, memory hits, validator issues, confidence, tokens, latency. `GET /admin/traces` for debugging "why did it answer that".
- **Confidence dashboard:** `GET /confidence` aggregates per-message confidence.
- **Usage & cost (`GET /api/admin/ops/usage?days=N`):** daily messages+tokens; top-20 users by tokens; by-model responses/tokens with **directional cost estimates** (a `MODEL_RATES` table of blended $/1M-token rates by model-family regex, explicitly "for directional tracking, not billing"); by-mode runs with avg latency and avg confidence from traces.
- **Pipeline health (`GET /api/admin/ops/health`):** everything an admin needs to answer "is the agent's data fresh?" in one call.
- **Failure inbox:** every background failure lands in `ingest_failures` with source/reference; admins resolve from the UI.

---

## Part 13 — Onboarding Features (cheap, high-"wow" — keep all three)

1. **Self-inventory tool (`list_data_sources`):** the agent answers "what are we connected to? / what do you know?" with a live, accurate, friendly list — table counts/rows/freshness per DB (from `table_vectors`), email mailbox/message/attachment counts, meeting counts, knowledge collections, uploads capability, and the user's own memory count. The prompt instructs plain-English grouping, never raw table dumps.
2. **Chat migration/import:** `GET /migration-prompt` returns a copy-paste prompt users run in their old ChatGPT/Claude to export everything it learned about them as Markdown; `POST /import` ingests it as a seeded session AND seeds long-term memory from it. The new brain starts with their accumulated context on day one.
3. **The tips page (`/tips`):** what to ask, example prompts per connected source, how uploads/artifacts/feedback/memory work.

---

## Part 14 — ⭐ The Data-Source Playbook (the part that changes per client)

The agent answers data questions through one generic mechanism: **discover relevant tables → generate read-only SQL → execute → synthesize** (plus purpose-built tools for anything not in SQL). So "connecting the new client's data" reduces to: *get the data queryable from Postgres (or behind a tool), then teach the agent it exists.*

**Step 0 — inventory the client's sources.** Typical categories: core operational system (ERP/FSM/CRM/PMS), finance/billing, people/timekeeping, assets/fleet, compliance/safety, telemetry/real-time systems, documents & knowledge (SOPs, manuals, the website), email/calendar/files, meeting recordings.

**Choose a pattern per source:**

1. **Native Postgres tables (simplest).** Load/replicate into the platform DB (ETL, nightly sync, CSV import). The NL→SQL tool works immediately after vectorization. Best for: exports, warehouses, structured business data.
2. **Existing live database → secondary read-only pool + dedicated tool (Part 5.8, the proven default)** — or `postgres_fdw` if cross-DB joins are genuinely needed.
3. **Third-party API → dedicated tool (Part 5.5).** Best for: real-time systems, write actions, anything not worth replicating. Follow the permission-scoped pattern if the data is per-user.
4. **Documents/website → vector store.** `ingest-local-documents.js` / `crawl-website.js` → hybrid search. Best for: SOPs, manuals, policies, site content.
5. **Streams/webhooks → ingest service.** Follow the meeting-transcript pattern (5.11): signed webhook → ACK fast → async parse → structured table + embedded chunks. Best for: meeting recorders, event feeds.
6. **Workspace suite → the Graph pattern (5.10):** synced email + attachments, live calendar, live files — all permission-scoped.
7. **Authoritative high-volume domain table → purpose-built tool.** If one giant, accuracy-critical table exists (telemetry time-series, a costing ledger), build a focused tool over it and instruct the model to prefer it over raw SQL.

**After wiring ANY source, you MUST (this is the difference between "connected" and "the agent knows"):**
- Run vectorization (`npm run vectorize`) so discovery + schema context include it.
- Update the **`AVAILABLE DATA` block** in `orchestrator.buildToolUseSystemPrompt` and the capability lines in `client-config.orchestrator_base` — name the real tables/systems, what each contains, and explicit ROUTING rules ("topic X → tool Y").
- Add infra/noise tables to `multiSourceQueryService.excludedTables` (and ALWAYS exclude permission-scoped stores like email from generic SQL).
- Update `list_data_sources` so the self-inventory reflects the new source.
- Add starter prompts exercising it, and a line on the tips page.
- Add domain guardrails to the specialized prompt modules if the source enables new judgment calls.

**Safety invariants regardless of source:** SELECT-only SQL + keyword denylist + 30s timeout + 100-row cap; read-only credentials AND `default_transaction_read_only=on` for secondary DBs; `requiresApproval: true` on any write/destructive tool; per-user scoping enforced in the tool, not the prompt.

---

## Part 15 — Step-by-Step Build Plan

1. **Scaffold the repo** per Part 4 (`/backend`, `/frontend`, `render.yaml`, `docker-compose.yml`; deps from Part 3).
2. **Stand up infra** (`docker compose up -d`), create `.env` (Part 8) with at least Anthropic + OpenAI + DB + Redis + admin bootstrap.
3. **Bring over the brain (mostly verbatim):** `server.js`, the entire `/agentic` tree, `/middleware`, `/bootstrap`, `/scripts`, and migrations 001–037.
4. **Rewrite `client-config.js`** for the client: identity, brand (verify colors/fonts against the real site), features, and — most importantly — the system prompts: company identity, brand voice, capabilities, 2–4 domain agent modules, and MODULE_TRIGGERS to route them. Keep the tool-use mechanics and ARTIFACTS spec unchanged.
5. **Run migrations** (`npm run db:migrate`) and boot the backend; confirm `/health` and the admin login.
6. **Wire the client's data sources** (Part 14): tables, secondary read-only pools + tools, API tools, document/website ingestion, workspace-suite integration, meeting webhooks — whichever apply.
7. **Vectorize** (`npm run vectorize`) and confirm via `GET /api/admin/database-info` that the tables appear; update the `AVAILABLE DATA` prompt block and `list_data_sources`.
8. **Bring over the frontend:** all of `/components/ai-chat/*`, `/lib/*`, the app pages, `/components/ui/*`, `next.config.ts`, `middleware.ts`. Re-theme Tailwind tokens, swap the logo, rewrite the tips page and prompt-library starters.
9. **Smoke-test the full loop:** a data question (tool_use + SQL + streamed answer + SQL-provenance citation), a chart/diagram request (artifact panel), a follow-up "chart that" (structured-result reuse), a screenshot + PDF upload (vision + extraction), an email/calendar question if wired (permission scoping as both admin and regular user), "what are we connected to?" (self-inventory), thumbs-down with a reason (feedback → memory), a "deep dive…" prompt (deep research), and a long conversation past 20 messages (rolling summary).
10. **Author remaining domain tools** and tune the specialized prompts/guardrails from real usage (query_history + traces are your tuning data).
11. **Set up integrations' admin sides:** IdP app registration + admin consent for Graph permissions; meeting-recorder webhook pointed at `/api/webhooks/.../<secret>`; schedule intervals.
12. **Deploy** via `render.yaml` (renamed services, dashboard secrets), verify `/health`, run vectorize + crawl in production, and confirm the schedulers log on boot.

---

## Part 16 — Customization Checklist (per new client)

- [ ] `client-config.js`: CLIENT_NAME, CLIENT_ID, BRAND_COLORS (verified against the real site + logo, date-stamped), BRAND_LOGO_URL, PINECONE_INDEX.
- [ ] `client-config.js` `SYSTEM_PROMPTS.orchestrator_base`: rewrite company identity, services, brand voice, capabilities, and data-source descriptions; keep MANDATORY TOOL USE + ARTIFACTS mechanics verbatim.
- [ ] Specialized agent modules: author the client's domain agents (replace estimating_reviewer etc.); update `MODULE_TRIGGERS` in the orchestrator to match.
- [ ] `orchestrator.buildToolUseSystemPrompt`: the `AVAILABLE DATA` + ROUTING lines reflect the client's real tables/tools.
- [ ] `/agentic/tools`: keep the generic set; author client domain tools; remove anything inapplicable; rename secondary-DB tools to fit (`query_billing_database` → whatever the system actually is).
- [ ] `multiSourceQueryService.excludedTables`: adjusted for the client's schema; permission-scoped stores excluded.
- [ ] `listDataSourcesTool`: descriptions match the client's actual sources.
- [ ] Integrations: `msGraph.js` tenant config (or the Google Workspace equivalent), SSO_ALLOWED_DOMAIN, webhook secrets, `readaiIngest` adapted to the client's meeting recorder.
- [ ] Migrations: keep 001–037; add the client's business-data migrations.
- [ ] Frontend: Tailwind tokens, logo, header/landing copy, tips-page content, prompt-library starters, login-page branding.
- [ ] `render.yaml`: service names, identity vars, all `sync: false` secrets listed.
- [ ] `.env` + deploy secrets: AI keys, admin bootstrap, secondary DB URLs (dedicated read-only roles!), Graph creds, webhook secrets.
- [ ] Feature flags decided (code-exec OFF in prod; voice/video per client).
- [ ] Smoke-test list from Part 15 step 9 passes end-to-end.

---

## Part 17 — Production Lessons Baked In (keep every one)

**LLM reliability**
- Retry/backoff on every Anthropic call (`withRetry` + `sanitizeAnthropicParams`); SDK `maxRetries: 0` so retry behavior is ours and observable. 429/529 surface as friendly auto-retrying messages; connection errors (`ERR_STREAM_PREMATURE_CLOSE`, `ECONNRESET`, `ETIMEDOUT`) are retryable.
- Force IPv4 + disable keep-alive on the outbound LLM HTTPS agent AND `dns.setDefaultResultOrder('ipv4first')` — the fix for persistent "Premature close" on cloud runtimes.
- Streaming retries only when zero text has been emitted; otherwise fail forward gracefully.
- Newer OpenAI models need `max_completion_tokens` and default temperature — handle by model-ID prefix in one place (modelRouter).
- Cap output at 32k tokens (64k streams for minutes and bloats memory); heuristic complexity analysis sets the budget without an LLM call.
- 1.5s cooldown between tool-loop iterations; stop after 3 consecutive empty results; max 15 tool calls/turn; cheap models for titles/summaries so a primary-model backoff never blocks UX.

**Streaming & UX**
- 15s SSE heartbeat; frontend handles dropped streams gracefully; server-side cancellation via `res.on('close')` + `isCancelled()` so closed tabs stop burning tokens.
- Discard intermediate tool-loop "thinking" text via `response_reset`; users only see the final answer. Same event powers self-correction replacement.
- Structured-result retention makes "chart that" work without re-querying — massive perceived-intelligence win for one JSONB column.

**Data safety**
- SELECT-only SQL + keyword denylist + 30s statement timeout + 100-row cap. Secondary pools DB-enforced read-only (`default_transaction_read_only=on`) on top of read-only credentials.
- Permission scoping enforced in tool SQL/API calls, never just in the prompt. Permission-scoped stores excluded from generic NL→SQL.
- Vectorize table metadata (with sample rows) so the model writes correct SQL; re-profile on a schedule to catch drift.

**Background-job resilience**
- Document extraction in an isolated child process (memory cap + SIGKILL timeout) — a corrupt PDF once crash-looped the whole API; never again.
- `unhandledRejection`/`uncaughtException` handlers keep the service alive and record to the failure inbox; every background pipeline records failures there.
- In-flight locks on sync jobs (never two email syncs at once); ACK-fast webhooks with async ingest; idempotent upserts everywhere (message ids, session ids, content hashes) so re-delivery/re-runs never duplicate.
- Attachment-processing existence checks so hourly syncs don't re-extract the same files forever; initial-vs-incremental page caps so first syncs backfill and steady-state stays cheap.

**Auth & ops**
- Cookie auth + same-origin proxy for REST and WS. Token-version revocation. Idempotent boot migrations + `ensureAdmin`. Health check runs a real `SELECT 1`. SSO callback through the frontend domain; domain-scoped auto-provisioning.
- Everything in the intelligence layer is flag-gated and best-effort — memory/validators/traces/summaries/self-correction failures must never break a chat turn.

---

## Appendix A — Generic tools that port as-is

`smartDatabaseTool` (one instance per DB), `vectorSearchTool` / `hybridSearchTool`, `listDataSourcesTool`, `emailSearchTool` / `calendarSearchTool` / `fileSearchTool` (if a workspace suite is wired), `pdfGenerateTool`, `docsCreateTool`, `taskCreateTool`, `pythonExecuteTool` (flag-gated, off in prod). Author per-client: domain tools, template-driven document generators (proposals/SOWs/reports in the client's format).

## Appendix B — Model IDs are config, not code

All real API model IDs live in exactly two places: `client-config.AI_MODEL` and `modelRouter.MODEL_REGISTRY` (both env-overridable). Update them there and nowhere else. When *talking to users* about models, reference the current generation names (per nBrain standards: GPT-5, Claude Opus 4, Gemini 3); the working API IDs in config may differ and that's fine.

## Appendix C — The SSE contract is the platform's spine

The event table in 5.17 is the contract between every backend mode and the entire frontend. New capabilities (new modes, new tools, new progress detail) extend the payloads — never change the event names or the `data: {json}\n\n` framing — and the existing frontend keeps working.

## Appendix D — What "done" feels like

A user logs in with their company SSO, asks "what are we connected to?", gets a friendly accurate inventory; asks a hard question about their own business data and watches the agent silently query two databases, cite the actual SQL, and render a chart in the side panel; says "now just Q3, as a table" and it reuses the same rows; asks "what did we decide in Tuesday's call?" and gets the meeting's action items; uploads a vendor PDF and gets it analyzed; thumbs-downs a formatting choice, an admin approves the note, and every answer after that respects it. That's the platform this document rebuilds.
