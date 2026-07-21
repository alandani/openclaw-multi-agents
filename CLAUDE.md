# OpenClaw Multi-Agent System — Project Brief

## Infrastructure
- **n8n**: running on Ubuntu server (execution/plumbing layer — no LLM calls, holds credentials)
- **OpenClaw**: running on Mac Mini (reasoning layer + WhatsApp relay via wacli)
- **Connected via Tailscale**: `gateway.bind: "tailnet"` in OpenClaw config, NOT loopback
- **Model routing**: OpenClaw uses 9Router to reach Claude Code (`cc`), OpenCode/Kiro (free),
  GitHub Copilot (`gh` — ~200 token context, use ONLY for single-line/narrow tasks, never
  multi-file or long-context work), and local LM Studio (Qwen/Gemma — default/primary route,
  free). Escalate to paid routes only when local models genuinely can't handle the task.

## Architecture principle
n8n = execution (API calls, thresholds, scheduling, no LLM cost).
OpenClaw = reasoning (parsing intent, judgment calls) + acts as WhatsApp relay since it's the
only thing holding the wacli session.

Flow for cron/scheduled alerts:
```
n8n cron → checks APIs/SSH → threshold breach? → n8n formats message →
n8n POSTs to OpenClaw /hooks/agent → OpenClaw relays via wacli → user
```

Flow for on-demand questions (user messages OpenClaw's WhatsApp number):
```
User → WhatsApp → OpenClaw (parses intent) → OpenClaw calls n8n webhook →
n8n does the work → n8n POSTs back to OpenClaw /hooks/agent → OpenClaw relays → user
```

## OpenClaw hooks config (already working)
```json
{
  "hooks": {
    "enabled": true,
    "token": "${OPENCLAW_HOOKS_TOKEN}",
    "path": "/hooks",
    "defaultSessionKey": "hook:wa-relay",
    "allowRequestSessionKey": false,
    "allowedSessionKeyPrefixes": ["hook:"]
  }
}
```
Endpoint: `POST /hooks/agent` with `{ message, deliver: true, channel: "whatsapp", to, model, timeoutSeconds }`.
`message` is a prompt, not verbatim text — phrase it as "reply with exactly this text and nothing
else: ..." to force verbatim relay and avoid the model adding commentary.

**Known gotcha**: env vars set via shell `export` are NOT visible to the gateway unless the
gateway process is started AFTER the export, in the same shell, or the var is set at the level
the gateway process actually reads from (shell profile, launchd plist, pm2 ecosystem file —
depends how the gateway is run). Confirm before assuming `${VAR}` substitution works.

## Agent inventory (13 total)

### Task agents (ask → respond, no shared dispatcher — domains don't overlap)
- **Coding & dev**: code review (gh for line comments, cc for cross-file), debug/triage, app-dev (needs high-context route, not gh)
- **Business analytics**: SEO research, metrics reporting, competitive watcher, **cost tracking** (new — Vultr billing API now, Hostinger + others later)
- **Study**: research assistant, study scheduler, assignment drafting (approval gate before submission)

### Autonomous watchers (n8n-run, scheduled, silent unless anomaly, no LLM cost)
- **Infra watcher** ← currently being built, see spec below
- CI watcher (not started)
- Pipeline QA (not started)

### Approval-gated agents (act, but need sign-off on risky steps)
- Infra ops (SSH, restarts, DB fixes — separate from infra watcher, which is read-only)
- Invoicing (client-facing, needs approval before sending)

## Infra watcher — full spec

**Schedule**: daily cron, silent unless anomaly. Also supports on-demand check via WhatsApp message.

**Vultr**
- Reachability/down status: available via API (`GET /v2/instances` — check `power_status`/`server_status`)
- CPU / RAM / disk %: **NOT available via Vultr API** (confirmed — API only exposes bandwidth
  and disk read/write ops, not utilization percentages). Must SSH into the instance and run
  `df -h`, `free`, `top -bn1` instead.
- Thresholds: CPU >90%, disk >90%, RAM >90%

**Hostinger**
- Domain/hosting expiration via API
- Tiered alerts: 30 days out (quiet heads-up) → 14 days (repeat, more urgent) → 7 days (urgent, daily until resolved)

**cPanel** (via SSH — no API, SSH access only)
- Disk quota full
- Backup failure
- SSL certificate expiring (same 30/14/7 tiers as Hostinger)

**Alerting**
- WhatsApp only, via OpenClaw relay (see hooks flow above)
- Severity marker: 🔴 critical / 🟡 warning
- Multiple issues on the same day = ONE combined message, not separate pings
- On-demand: message the number anytime, triggers immediate check regardless of cron schedule

**Cost tracking (new, lives in Business analytics cluster, not infra watcher)**
- Vultr: `GET /v2/billing/history` and `GET /v2/billing/invoices`
- Fully autonomous, read-only, no approval gate
- Scope to expand to Hostinger and other service costs later

## Repo strategy
Single repo to start (not one-per-agent, not split-by-domain yet). Split later once boundaries
are proven by actual use — moving a folder into its own repo later is cheap, premature splitting
isn't.

```
openclaw-agents/
├── CLAUDE.md              # this file
├── .env.example
├── shared/                # 9Router config, common prompts/utils
├── task-agents/
│   ├── coding/{code-review,debug-triage,app-dev}/
│   ├── business/{seo-research,metrics-reporting,competitive-watcher,cost-tracking}/
│   └── study/{research-assistant,study-scheduler,assignment-drafting}/
├── watchers/
│   ├── infra-watcher/      # n8n workflow export + docs — BUILD THIS FIRST
│   ├── ci-watcher/
│   └── pipeline-qa/
└── ops/
    ├── infra-ops/
    └── invoicing/
```

`ops/` and anything touching real credentials/client data should stay private even if the rest
of the repo goes public later.

## Current status / next steps
1. ✅ Tailscale connected, OpenClaw gateway reachable from n8n server
2. ✅ `/hooks/agent` webhook confirmed working end-to-end (WhatsApp message delivery confirmed)
3. ⬜ Build n8n workflow: Vultr API (reachability) + SSH (CPU/RAM/disk) + Hostinger API +
   cPanel SSH → threshold logic → combined message → POST to OpenClaw hooks endpoint
4. ⬜ Test cron path end-to-end with a forced threshold breach
5. ⬜ Test on-demand path (message the number, get a live check back)
6. ⬜ Confirm Vultr billing endpoint response format, build cost-tracking on-demand branch
7. ⬜ Only after infra-watcher is solid: move to CI watcher, then task agents, then ops agents

## Security notes
- `OPENCLAW_HOOKS_TOKEN` must be different from `gateway.auth.token` — do not reuse
- SSH access should use key files, not passwords
- Rotate any token that's been shared in chat/screenshots before going live
- `.env` is gitignored — only `.env.example` (no real values) gets committed
