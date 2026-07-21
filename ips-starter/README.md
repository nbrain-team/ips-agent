# IPS Starter Kit

Drop-in, pre-customized files to bootstrap the IPS (IPS, Inc.) AI agent platform
in the new Cursor project. Pair this with `IPS-AGENT-PLATFORM-BUILD-CONTEXT.md`
(the full architecture blueprint at the project root).

IPS, Inc. — oilfield electrical services contractor serving Southeast New Mexico
and the Permian Basin. Website: https://ipsaecorp.com

## What's here

| File | Move it to | Notes |
|------|------------|-------|
| `client-config.js` | `backend/agentic/config/client-config.js` | ⭐ Identity, branding, system prompts. IPS facts + red/charcoal palette are pre-filled; a few `⚠️ TODO`s to verify from ipsaecorp.com. |
| `agentFlags.js` | `backend/agentic/config/agentFlags.js` | Generic intelligence feature flags — use as-is. |
| `env.template.txt` | `backend/env.template.txt` | Copy to `backend/.env` and fill in keys. |
| `render.yaml` | project root `render.yaml` | Deployment blueprint (`ips-*` services). |
| `CURSOR-KICKOFF-PROMPT.md` | keep for reference | Contains the prompt to paste into Cursor to start the build. |

## How to start

1. Put these in the new IPS project, alongside `IPS-AGENT-PLATFORM-BUILD-CONTEXT.md`
   and the logo `ips-logo.png` (both in the project root).
2. Open `CURSOR-KICKOFF-PROMPT.md`, copy the prompt under "PROMPT TO PASTE", and
   paste it into the Cursor chat of the new project.
3. The agent will read the blueprint, pull branding from ipsaecorp.com, wire the
   logo, move these starter files into place, and scaffold the platform.

## What's pre-filled vs. to confirm

Pre-filled from ipsaecorp.com + the logo:
- Identity, services (oil & gas electrical, automation, fiber optics, powerline,
  hydro excavation, safety), offices, and brand voice in `client-config.js`.
- Brand palette: IPS red `#EC1C24` + charcoal `#231F20` + steel-blue accent.
- Two starter domain modules: `estimating_reviewer` and `qa_validator`.

To confirm / finish during the build:
- Exact brand hex, fonts, and logo treatment (sample from ipsaecorp.com).
- Any additional services, offices, or positioning details.
- Data-source descriptions + tables — once IPS's sources (ERP/job-costing,
  FSM, labor/crews, fleet, SCADA/automation, safety/EHS, CRM) are wired.
