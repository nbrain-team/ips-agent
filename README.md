# IPS AI Platform — Centralized AI Brain

Private, owned enterprise AI agent platform for **IPS, Inc.** (Ingram Professional
Services) — oilfield electrical services, Southeast New Mexico & the Permian Basin.
Built by nBrain on the proven reference-platform architecture documented in
`IPS-AGENT-PLATFORM-BUILD-CONTEXT.md`.

## What's inside

- **Backend** (`/backend`) — Node 20 + Express: multi-turn agentic orchestrator
  (tool_use / plan / deep-research modes), native text-to-SQL over Postgres,
  model-agnostic routing (Claude / GPT / Gemini), SSE streaming, artifacts,
  long-term memory, output validators, confidence scoring, agent traces,
  feedback loop, uploads (vision + document extraction), knowledge-base
  hybrid search, cookie auth + admin bootstrap.
- **Frontend** (`/frontend`) — Next.js 15 + Tailwind, IPS-branded chat UI with
  streaming, artifact side panel (HTML/SVG/Mermaid/Chart.js/Markdown),
  chat history (folders/search), prompt library, voice input, feedback,
  data-inventory page, user management.
- **Two databases** — a primary operational Postgres (created by this platform)
  and the existing **IPS Billing platform Postgres** connected read-only via a
  dedicated `query_billing_database` tool (Part 11.1, Option B).

## Local development

```bash
docker compose up -d                      # Postgres (:5433) + Redis (:6380)

cd backend
cp env.template.txt .env                  # fill in keys
npm install
npm run db:migrate
npm run dev                               # :8080

npm run crawl                             # ingest ipsaecorp.com
npm run vectorize                         # vectorize table metadata (both DBs)

cd ../frontend
npm install --legacy-peer-deps
npm run dev                               # :3000
```

Open http://localhost:3000/ai-chat and log in with `ADMIN_EMAIL` /
`ADMIN_INITIAL_PASSWORD` from `.env`.

## Deployment

`render.yaml` provisions the full stack on Render (backend, frontend, Postgres,
Redis). Set the `sync: false` secrets in the dashboard: AI keys, admin
bootstrap, and `IPS_BILLING_DATABASE_URL`.

## Adding IPS data sources

See Part 11 of `IPS-AGENT-PLATFORM-BUILD-CONTEXT.md`. Short version: get the
data into Postgres (or behind a tool), run `npm run vectorize`, and update the
"AVAILABLE DATA" descriptions in `backend/agentic/config/client-config.js` and
`orchestrator.buildToolUseSystemPrompt`.
