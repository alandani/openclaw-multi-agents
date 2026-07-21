# OpenClaw Multi-Agent System

A multi-agent automation setup built on two layers:

- **n8n** (Ubuntu server) — the execution layer: API calls, SSH checks, thresholds,
  scheduling. Holds all credentials. No LLM calls, no LLM cost.
- **OpenClaw** (Mac Mini) — the reasoning layer: parses intent, makes judgment calls,
  and relays messages over WhatsApp via wacli. Model routing goes through 9Router
  (local LM Studio models by default, paid routes only when needed).

The two are connected over Tailscale. Alerts and on-demand answers are delivered to
WhatsApp through OpenClaw's `/hooks/agent` endpoint.

## How it works

**Scheduled alerts (cron):**

```
n8n cron → checks APIs/SSH → threshold breach? → n8n formats message →
n8n POSTs to OpenClaw /hooks/agent → OpenClaw relays via wacli → user
```

**On-demand questions (WhatsApp message in):**

```
User → WhatsApp → OpenClaw (parses intent) → n8n webhook → n8n does the work →
n8n POSTs back to /hooks/agent → OpenClaw relays → user
```

## Repository layout

```
├── CLAUDE.md              # full project brief and specs
├── .env.example           # env template (copy to .env, never commit real values)
├── shared/                # 9Router config, common prompts/utils
├── task-agents/           # ask → respond agents
│   ├── coding/            #   code-review, debug-triage, app-dev
│   ├── business/          #   seo-research, metrics-reporting, competitive-watcher, cost-tracking
│   └── study/             #   research-assistant, study-scheduler, assignment-drafting
├── watchers/              # autonomous, n8n-scheduled, silent unless anomaly
│   ├── infra-watcher/     #   Vultr + Hostinger + cPanel monitoring — BUILD THIS FIRST
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

1. Copy the env template and fill in your values:
   ```sh
   cp .env.example .env
   ```
   `.env` is gitignored — real tokens and keys never get committed.
2. Make sure the OpenClaw gateway is reachable from the n8n server over Tailscale
   and the `/hooks/agent` endpoint responds (see `CLAUDE.md` for the hooks config).
3. Build order: **infra-watcher first**, then the cron and on-demand paths end-to-end,
   then cost-tracking, then the remaining watchers, task agents, and ops agents.

## Current status

- ✅ Tailscale connectivity, OpenClaw gateway reachable from n8n
- ✅ `/hooks/agent` → WhatsApp delivery confirmed end-to-end
- ⬜ Infra-watcher n8n workflow (Vultr API + SSH + Hostinger API + cPanel SSH)
- ⬜ Cron path test with a forced threshold breach
- ⬜ On-demand path test
- ⬜ Cost-tracking (Vultr billing endpoints)

Full specs, thresholds, and security notes live in [CLAUDE.md](CLAUDE.md).
