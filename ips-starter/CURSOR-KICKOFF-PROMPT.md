# IPS — Cursor Kickoff Prompt

> Paste the block below into the Cursor chat of the **new IPS project** to start the build. Before you do, make sure these files are in the project root:
> - `IPS-AGENT-PLATFORM-BUILD-CONTEXT.md`  (the full architecture blueprint)
> - `ips-logo.png`  (the logo)
> - the `ips-starter/` folder  (client-config.js, agentFlags.js, env.template.txt, render.yaml)

---

## PROMPT TO PASTE

You are building **IPS's enterprise AI agent platform** — a private, owned "Centralized AI Brain" with a ChatGPT/Claude-grade chat experience wired into IPS's own data and workflows. IPS (IPS, Inc., ipsaecorp.com) is an oilfield electrical services contractor serving Southeast New Mexico and the Permian Basin. We are repurposing a proven, in-production reference platform (a media-agency AI brain that has already been re-skinned for other clients). The full architecture, components, patterns, and production lessons are documented in `IPS-AGENT-PLATFORM-BUILD-CONTEXT.md` in this project root.

**Step 0 — Read first.** Read `IPS-AGENT-PLATFORM-BUILD-CONTEXT.md` end to end before writing any code. It is the source of truth for the architecture (agentic orchestrator, multi-turn tool-use loop, native text-to-SQL data layer, model-agnostic routing, streaming SSE, artifacts, long-term memory, deep research, validators, feedback loop, multi-channel, uploads, voice). Treat everything above the "YOUR business data" line as reusable nearly verbatim; the data layer and branding are what we customize for IPS.

**Step 1 — Branding from the website + logo.**
- Use the logo file `ips-logo.png` in the project root as the platform logo. Copy it into `frontend/public/ips-logo.png` and reference it in the header and anywhere a brand mark is shown. `BRAND_LOGO_URL` is already set to `/ips-logo.png`.
- Visit **https://ipsaecorp.com** and extract the real branding to drive the whole build: primary/secondary/accent colors (sample the actual hex — the logo is red `#EC1C24`-ish on charcoal/black, with a steel-blue accent on the site), typography/fonts, logo treatment, imagery style, and — importantly — the **brand voice and positioning** (oilfield electrical, safety-first, turnkey, Permian Basin, upstream/midstream ONG). Check sub-pages: About, Services (Oil & Gas Electrical, Automation, Fiber Optics, Powerline, Hydro Excavation, Safety), Employment/Contact.
- Apply that palette as Tailwind theme tokens in `frontend/tailwind.config.ts` (use an `ips-*` token prefix), update `BRAND_COLORS` in `backend/agentic/config/client-config.js`, and set `BRAND_PRIMARY_COLOR` / `BRAND_SECONDARY_COLOR` in `.env` and `render.yaml` to the confirmed values.
- Use the real IPS facts and voice you gathered to verify/replace the `⚠️ TODO` sections inside `client-config.js` → `SYSTEM_PROMPTS.orchestrator_base` (the "IPS — BRAND & IDENTITY" block). Keep the `MANDATORY TOOL USE` rules and the entire `ARTIFACTS` spec unchanged.

**Step 2 — Use the pre-built starter files.** The `ips-starter/` folder already contains IPS-customized versions of the four highest-leverage files. Move them into place:
- `ips-starter/client-config.js`  →  `backend/agentic/config/client-config.js`
- `ips-starter/agentFlags.js`      →  `backend/agentic/config/agentFlags.js`
- `ips-starter/env.template.txt`   →  `backend/env.template.txt`  (then copy to `backend/.env` and fill in keys)
- `ips-starter/render.yaml`        →  project root `render.yaml`

**Step 3 — Scaffold the platform** following Part 4 (repo structure) and Part 12 (build plan) of the blueprint. Recreate the brain mostly verbatim from the documented patterns:
- Backend: `server.js` (with `dns.setDefaultResultOrder('ipv4first')` at the top and a real `SELECT 1` health check); the full `/agentic` tree (orchestrator with tool_use + plan + deep-research modes, toolRegistry, modelRouter, multiSourceQueryService, TableRouter, TableMetadataVectorization, queryAnalyzer, longTermMemory, deepResearch, outputValidators, confidenceScoring, agentTrace, websocket, utils/anthropicRetry, utils/embeddings, utils/httpAgent); `/middleware` (requireAuth/requireAdmin/requireUserManager); `/bootstrap` (autoMigrate + ensureAdmin); generic `/agentic/tools` (smartDatabaseTool, vectorSearchTool, hybridSearchTool, pdfGenerateTool, docsCreateTool, pythonExecuteTool, taskCreateTool); `/agentic/routes/index.js` (sessions, streaming message endpoint with the exact SSE event protocol in Part 5.10, uploads, import/migration, feedback, traces).
- Frontend: `ChatInterface.tsx`, `ArtifactPanel.tsx`, `ChatHistory.tsx`, `PlanDisplay.tsx`, `SourceCitation.tsx`, `VoiceInput.tsx`, `PromptLibrary.tsx`; `lib/artifactParser.ts`, `lib/artifactExport.ts`; `/app/ai-chat`, `/app/data`, `/app/login`, `/app/account`, `/app/admin/users`; the `/components/ui/*` primitives; `next.config.ts` proxy for `/api/*` and `/socket.io/*`; `middleware.ts`.
- Match the tech stack and dependency lists in Part 3, and keep all the production lessons in Part 14 (retry/backoff, IPv4 + no-keepalive HTTP agent, SSE heartbeat, 32k token cap, SELECT-only SQL safety, tool-loop cooldown, flag-gated intelligence, ensureAdmin).

**Step 4 — Database.** Create the migrations folder and run the core brain migrations described in Part 7: `001` (system tables: users, agent_chat_sessions, agent_chat_messages, agent_artifacts, agent_feedback, agent_user_preferences, presence, etc.), `002` (pgvector + knowledge/document table), `004` (agent_metadata: table_vectors, query_history, query_patterns), `028` (agent_memories + agent_traces), `029` (chat sharing + output templates). Skip the reference client's Microsoft/SharePoint and media-specific migrations.

**Step 5 — Data sources (the key difference for IPS).** Follow Part 11 (the Data-Source Playbook). For now, scaffold the generic text-to-SQL data layer so it works against whatever tables exist, and leave clearly-marked TODOs where IPS's real sources plug in. Ask me what IPS's data sources are (e.g. ERP/job-costing & estimating, FSM/work orders, labor/crews/timekeeping, fleet & equipment, SCADA/automation/well telemetry, safety/EHS + contractor-qual portals like ISNetworld/Avetta/Veriforce, accounting, CRM, inventory). For each source, recommend one of the five patterns (native tables / foreign data / API-as-a-tool / document ingestion / purpose-built tool). Also crawl/ingest ipsaecorp.com so the agent is brand-consistent from day one. After any source is wired, run table vectorization (`npm run vectorize`) and update the "AVAILABLE DATA" descriptions in `client-config.js` and the orchestrator's tool-use system prompt to name the real tables/sources.

**Step 6 — Verify & report.** Get it running locally per Part 9 (docker compose for Postgres+Redis, backend on :8080, frontend on :3000). Smoke-test: a data question (tool_use → SQL → streamed answer), a chart/diagram request (artifact renders), a screenshot/RFP upload (vision + doc extraction), and a thumbs-down (feedback). Then summarize what's done, what's stubbed with TODOs, and exactly what you need from me (data-source details, API keys, final brand hex values) to finish.

**Constraints.**
- Do not invent IPS facts — pull them from ipsaecorp.com; mark anything uncertain as a TODO and ask me.
- Keep the agent model-agnostic and the data layer SELECT-only/safe as documented.
- Reference current AI model names where shown to users; keep the real working model IDs in `client-config.js` and `modelRouter`.
- Build incrementally and tell me before any destructive action.

Start with Step 0 (read the blueprint) and Step 1 (pull branding from ipsaecorp.com + wire the logo), then propose your build order before scaffolding.
