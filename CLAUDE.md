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

## Infra watcher — RESET, MCP-first architecture (no n8n for this agent)

This agent was originally planned as an n8n-driven cron workflow. Redesigned from zero to
be a natural-language, read-only Q&A agent instead — better fit for questions like "what's
CPU% of ulak server" or "which instance has low disk space" than n8n's rigid workflow logic.

**Purpose**: answer infra questions conversationally via WhatsApp. READ-ONLY — no reboot,
no delete, no modify. Any agent that controls/acts on servers is a SEPARATE agent (infra-ops,
not yet built), not this one.

**Architecture**
```
You → WhatsApp → OpenClaw (read-only tool scope)
                     ├─ Vultr MCP (community server, e.g. rsp2k/mcp-vultr)
                     │    → instance list, status — READ-ONLY tools only
                     ├─ Hostinger MCP (official: hostinger/api-mcp-server)
                     │    → VPS list, CPU/RAM/disk/network metrics — READ-ONLY tools only
                     ├─ WHOIS lookup (shell or MCP)
                     │    → domain expiration, ANY registrar (Hostinger + DomaiNesia +
                     │      future ones), since expiration is public WHOIS data — no
                     │      registrar-specific credential needed for this check
                     └─ SSH (read-only commands only: df, free, top, cPanel UAPI reads)
                          → cPanel checks per-instance (both Vultr and Hostinger instances)
```

**Why no n8n here**: n8n's workflow logic is rigid (good for scheduled, deterministic
checks) but MCP is a better fit for ad-hoc natural language questions — the agent picks
which tool to call based on what's actually asked, rather than following a fixed branch.
n8n may still be reintroduced later specifically for the scheduled/proactive alert path if
OpenClaw doesn't have its own heartbeat scheduling — TBD, not blocking on this decision to
start building the Q&A path.

**Confirmed provider capabilities**
- **Vultr**: MCP wraps the same public API — does NOT add CPU/RAM/disk metrics that the raw
  API doesn't have. Reachability/instance status: yes. Live resource %: NO, needs SSH
  regardless of MCP.
- **Hostinger**: MCP + underlying API genuinely expose real-time CPU/RAM/disk/network
  metrics per VPS. One list call returns all instances under the account — no hardcoded IDs.
- **DomaiNesia**: no MCP, no consumer API (their public API is reseller-only, requires a
  reseller account — not applicable for checking your own domain list). Use WHOIS lookup
  instead — provider-agnostic, works for domains at DomaiNesia, Hostinger, or anywhere else.
- **cPanel**: no MCP for any provider. Always SSH, always per-instance (each instance runs
  its own separate cPanel install — no way to check multiple from one connection).

**What still needs a maintained list (not credentials, just identifiers)**
```
domains_to_watch.json   # domain names only, e.g. ["site-a.com", "site-b.id"]
instances.json          # per-instance SSH user + key path, matched against each
                         # provider's MCP-returned instance ID at query time
```

**Safety constraint — hard requirement**
Both Vultr MCP and Hostinger MCP can also write/act (reboot, delete, modify DNS), not just
read. This agent must be scoped to read-only tools only — either by restricting which MCP
tools are exposed to it, or using a scoped/read-only API key if the provider supports one.
No destructive capability should reach this agent under any circumstance; that capability
belongs only to the separate infra-ops agent (not yet built).

**Original questions this agent should answer** (from the redesign brief):
- "What's the CPU percentage of [server]?" → Hostinger MCP if on Hostinger; SSH if on Vultr
- "Tell me the closest expiring domain" → WHOIS lookup across `domains_to_watch.json`
- "Which instance is active in Vultr?" → Vultr MCP, read-only instance list
- "Which instance has low disk space?" → Hostinger MCP (direct) or SSH (Vultr instances)

**Alerting** (still applies once proactive/scheduled path is added)
- WhatsApp only, via OpenClaw relay (see hooks flow above)
- Severity marker: 🔴 critical / 🟡 warning
- Multiple issues on the same day = ONE combined message, not separate pings
- Thresholds: CPU >90%, disk >90%, RAM >90%, domain/SSL expiry tiers at 30/14/7 days

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
├── instances.example.json # placeholder for per-instance SSH keys, real file gitignored
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
3. ✅ Infra watcher architecture RESET: MCP-first (Vultr MCP + Hostinger MCP), WHOIS for
   domains, SSH only for cPanel and Vultr resource metrics, read-only scope only
4. ⬜ Connect Vultr MCP (community server) to OpenClaw, scoped read-only, test with a live
   query ("which Vultr instances are active")
5. ⬜ Connect Hostinger MCP (official) to OpenClaw, scoped read-only, test with a live query
   ("what's the CPU% of [instance]")
6. ⬜ Set up WHOIS lookup capability + `domains_to_watch.json`, test "closest expiring domain"
7. ⬜ Set up per-instance SSH access (`instances.json`) for cPanel checks + Vultr resource %
8. ⬜ Test all four original example questions end-to-end via WhatsApp
9. ⬜ Decide proactive/scheduled alert mechanism (OpenClaw native heartbeat vs. reintroducing
   n8n just for the cron trigger) — not blocking on-demand Q&A work
10. ⬜ Only after infra-watcher is solid: move to CI watcher, then task agents, then ops agents
    (infra-ops — the separate agent that CAN act — is a distinct future build, not this one)

## Security notes
- `OPENCLAW_HOOKS_TOKEN` must be different from `gateway.auth.token` — do not reuse
- SSH access should use key files, not passwords
- Rotate any token that's been shared in chat/screenshots before going live
- `.env` is gitignored — only `.env.example` (no real values) gets committed
- `instances.json` is gitignored — only `instances.example.json` (placeholder values) gets committed
- `domains_to_watch.json` is fine to commit (just domain names, no credentials) unless the
  list itself reveals sensitive client/business info — use judgment per repo visibility
- Test each SSH key manually (`ssh -i <key> user@host`) before wiring into any workflow
- MCP servers (Vultr, Hostinger) must be scoped to READ-ONLY tools for this agent — verify
  tool permissions explicitly rather than assuming defaults are safe
