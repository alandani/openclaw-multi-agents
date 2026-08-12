# OpenClaw Multi-Agent System

A multi-agent automation setup running on two machines, with OpenClaw's native
cron as the primary execution layer for all scheduled agents:

- **OpenClaw** (Mac Mini) — the reasoning and execution layer: parses intent,
  makes judgment calls, runs scheduled checks via native cron, and relays messages
  over WhatsApp via wacli. Model routing goes through 9Router — free routes
  (Kiro, OpenCode, Gemini) by default, paid Claude Code routes reserved as the
  last-resort tier in each chain (client-facing Invoicing is the one exception).
  No local models — see [PROGRESS.md](PROGRESS.md)'s Model routing section for the
  full per-cluster mapping.
- **n8n** (Ubuntu server) — still running but **no longer the default execution
  layer** (see [PROGRESS.md](PROGRESS.md)'s DECIDED section for the full rationale).
  OpenClaw's native cron has replaced n8n for all scheduled-agent needs; n8n is
  retained only if a specific future need requires workflow UI or credential
  vaulting that cron doesn't provide.

The two machines are connected over Tailscale.

## How it works

**Watchers in general (OpenClaw-native cron, no n8n):**

```
OpenClaw cron → command payload → checks APIs/SSH → stdout captured →
OpenClaw announces via wacli → user
```

**Infra watcher specifically (MCP-first on-demand Q&A, no cron):**

```
User → WhatsApp → OpenClaw (parses intent, read-only tool scope) →
Vultr MCP / Hostinger MCP / WHOIS / SSH → OpenClaw answers → user
```

## Repository layout

```
├── PROGRESS.md            # full project brief and specs
├── .env.example           # env template (copy to .env, never commit real values)
├── instances.example.json # per-instance SSH credentials template (real instances.json gitignored)
├── shared/                # 9Router config, common prompts/utils
├── task-agents/           # ask → respond agents
│   ├── coding/            #   code-review, debug-triage, app-dev
│   ├── business/          #   seo-research, metrics-reporting, competitive-watcher, cost-tracking
│   └── study/             #   research-assistant, study-scheduler, assignment-drafting
├── watchers/              # autonomous, silent unless anomaly (mostly n8n-scheduled)
│   ├── infra-watcher/     #   Vultr + Hostinger + cPanel Q&A — MCP-first, no n8n — BUILD THIS FIRST
│   ├── ci-watcher/
│   └── pipeline-qa/
└── ops/                   # approval-gated agents (act, but need sign-off on risky steps)
    ├── infra-ops/         #   SSH, restarts, DB fixes
    └── invoicing/         #   client-facing, approval before sending
```

`ops/` and anything touching real credentials or client data stays private even if the
rest of the repo goes public later.

## Agent inventory

| Cluster | Agents | Mode |
|---|---|---|
| Coding & dev | code-review, debug-triage, app-dev | ask → respond |
| Business analytics | seo-research, metrics-reporting, competitive-watcher, cost-tracking | ask → respond |
| Study | research-assistant, study-scheduler, assignment-drafting | ask → respond (drafting has an approval gate) |
| Watchers | infra-watcher, ci-watcher, pipeline-qa | autonomous, scheduled, silent unless anomaly |
| Ops | infra-ops, invoicing | approval-gated |

## Getting started

1. Copy the templates and fill in your values:
   ```sh
   cp .env.example .env
   cp instances.example.json instances.json
   ```
   Both `.env` and `instances.json` are gitignored — real tokens and keys never get
   committed. `instances.json` holds per-instance SSH credentials (each instance has its
   own key); hosts/IPs are not stored anywhere — they come from the provider APIs at
   runtime, matched by instance ID.
2. Test each SSH key manually (`ssh -i <key> user@host`) before wiring it into any agent.
3. Make sure the OpenClaw gateway is reachable over Tailscale and the `/hooks/agent`
   endpoint responds (see `PROGRESS.md` for the hooks config). Hooks are used for
   WhatsApp relay, not for n8n.
4. Build order: **infra-watcher first**, then the cron and on-demand paths end-to-end,
   then cost-tracking, then the remaining watchers, task agents, and ops agents.

## Current status

- ✅ Tailscale connectivity, OpenClaw gateway reachable from n8n
- ✅ Infra-watcher architecture RESET to MCP-first (no n8n) — the n8n workflow,
  credentials, and standalone script from an earlier build were unwound and
  deleted from both this repo and the n8n instance
- ⬜ Connect Vultr MCP + Hostinger MCP to OpenClaw (read-only scope), WHOIS
  lookup, and per-instance SSH — see `watchers/infra-watcher/` and PROGRESS.md
  for the full build order
- ⬜ Cost-tracking (Vultr billing endpoints)

Full specs, thresholds, and security notes live in [PROGRESS.md](PROGRESS.md).
