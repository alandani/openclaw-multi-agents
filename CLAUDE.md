# OpenClaw Multi-Agent System — Project Brief

## Infrastructure
- **n8n**: still running on Ubuntu server but **no longer the default execution layer** (see DECIDED section below)
- **OpenClaw**: running on Mac Mini (reasoning layer + WhatsApp relay via wacli)
- **Connected via Tailscale**: `gateway.bind: "tailnet"` in OpenClaw config, NOT loopback
- **Model routing**: OpenClaw uses 9Router to reach Claude Code (`cc`), OpenCode/Kiro (free),
  GitHub Copilot (`gh` — ~200 token context, use ONLY for single-line/narrow tasks, never
  multi-file or long-context work), and local LM Studio (Qwen/Gemma — default/primary route,
  free). Escalate to paid routes only when local models genuinely can't handle the task.

## Architecture principle — DECIDED: OpenClaw-native cron as default

**n8n is no longer the default execution layer.** OpenClaw's built-in cron now covers
all scheduled-agent needs. This repo replaces the earlier n8n-as-execution architecture
with OpenClaw-native scheduling. See "Cron job patterns for watchers" below for the
concrete templates to follow.

### Flow for cron/scheduled alerts (current, working)
```
OpenClaw cron → command payload (runs daily-digest.mjs) → stdout captured →
OpenClaw announces via wacli → user
```
No webhooks, no n8n round-trip, no LLM cost.

### Flow for on-demand questions (no change)
```
User → WhatsApp → OpenClaw (parses intent, calls read-only MCP/SSH tools directly) →
OpenClaw answers → user
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

### Autonomous watchers (OpenClaw-native cron, scheduled, silent unless anomaly, no LLM cost)
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
OpenClaw's native cron now provides the scheduled/proactive alert path that was previously
marked as TBD. See "Cron job patterns for watchers" below for the concrete patterns —
this decision is closed.

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
│   ├── infra-watcher/      # Cron- and MCP-driven — BUILD THIS FIRST
│   ├── ci-watcher/
│   └── pipeline-qa/
└── ops/
    ├── infra-ops/
    └── invoicing/
```

`ops/` and anything touching real credentials/client data should stay private even if the rest
of the repo goes public later.

## Cron job patterns for watchers (copy-pasteable)

OpenClaw-native cron uses two payload patterns for watcher agents. Both avoid n8n entirely
— no webhooks, no workflow server, no LLM cost for deterministic checks.

### 1. Command payload — always-run digest (proven: infra-watcher-daily)

Best for: scheduled checks that always produce output, like a daily summary or heartbeat.

**Working example (infra-watcher-daily):**
```bash
openclaw cron add \
  --name "ci-watcher-daily" \
  --cron "0 8 * * *" \
  --tz "Australia/Sydney" \
  --command "node /path/to/watchers/ci-watcher/daily-check.mjs" \
  --command-cwd "/Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents" \
  --announce \
  --channel whatsapp \
  --to "+6282261009500" \
  --session isolated
```

The command payload (`--command <shell>`) runs as `argv: ["sh", "-lc", <shell>]` inside
the Gateway process — no model spin-up, no LLM token burn. Stdout is captured and delivered
as the message. The `infra-watcher-daily` job (id `cb1f9446-...`, runs at `0 8 * * *`) uses
this pattern with `daily-digest.mjs` and is confirmed working with `lastRunStatus: ok`.

**For ci-watcher and pipeline-qa (always-run daily check):**
1. Create `watchers/ci-watcher/daily-check.mjs` (or similar) — a standalone Node.js script
   that calls the relevant API(s) and prints a formatted message. No OpenClaw agent context,
   no MCP, no subagent — just `execSync` / `fetch` / `fs` calls.
2. Register the cron job with the above `--command` pattern.
3. Use `--trigger-script` (see below) when you only want to fire on anomaly — but for
   daily watchers that always produce output, plain `--command` is sufficient.

### 2. Trigger.script — condition watcher (silent unless anomaly)

Best for: polling checks that should stay silent until something changes (e.g. CI status,
pipeline failure, threshold breach).

**Template:**
```bash
openclaw cron add \
  --name "pipeline-qa-watcher" \
  --cron "*/15 * * * *"           # every 15 minutes \
  --tz "Australia/Sydney" \
  --trigger-script "/path/to/run-check.mjs" \
  --command "node /path/to/alert.mjs"    # runs only when trigger fires \
  --announce \
  --channel whatsapp \
  --to "+6282261009500" \
  --session isolated
```

The trigger script (`--trigger-script <path>`) is a condition gate that runs on every
scheduled tick. It must return JSON `{ fire, message?, state? }`:
- `fire: true` → the command payload executes; the message is appended to its context
- `fire: false` → the tick is silently skipped
- `state` is persisted between runs (16 KB cap) so the script can diff against the last
  observation and only fire on state changes

**Example trigger script for ci-watcher** (`watchers/ci-watcher/ci-check.mjs`):
```js
#!/usr/bin/env node
// Reads trigger.state from env or stored state, compares current CI status,
// returns { fire, message, state }.
import { execSync } from 'child_process';
const prev = process.env.TRIGGER_STATE ? JSON.parse(process.env.TRIGGER_STATE) : {};
const status = execSync('gh pr checks --json state -q \'.\[\].state\' | sort -u', { encoding: 'utf8' }).trim();
const changed = status !== prev.status;
const result = { fire: changed, message: changed ? `CI status changed: ${prev.status ?? 'none'} → ${status}` : null, state: { status } };
console.log(JSON.stringify(result));
```

The trigger.script approach is exact for "silent unless anomaly" — no output at all on
healthy ticks, zero spam, fired only when the condition really changes.

### Which pattern to use for ci-watcher and pipeline-qa

| Watcher | Pattern | Frequency | Rationale |
|---|---|---|---|
| **ci-watcher** | `trigger.script` + `--command` | Every 15 min | CI status rarely changes; spam on every tick is worse than a short silence. Fire only when a check transitions (e.g. pending→fail, fail→pass). |
| **pipeline-qa** | `trigger.script` + `--command` | Every 15 min | Same reasoning as ci-watcher — pipeline failures are exceptions, not the norm. Only alert on change. |

For the trigger scripts, follow the same structure as `infra-watcher/daily-digest.mjs`:
standalone Node.js, no OpenClaw agent context, no MCP tools, pure `execSync`/fetch/stdout.
The `daily-digest.mjs` source (at `watchers/infra-watcher/daily-digest.mjs`) is the proven
template — modelled on its `execSync` calls, error handling, and threshold checks.

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
9. ✅ DECIDED: OpenClaw-native cron for all scheduled watchers. n8n kept only if a specific
   future need requires something cron genuinely can't do (credential vault/workflow UI) —
   not as default execution layer. See "Cron job patterns for watchers" below.
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
