# OpenClaw Multi-Agent System — Project Brief

## Infrastructure

- **n8n**: still running on Ubuntu server but **no longer the default execution layer** (see DECIDED section below)
- **OpenClaw**: running on Mac Mini (reasoning layer + WhatsApp relay via wacli)
- **Connected via Tailscale**: `gateway.bind: "loopback"` in OpenClaw config, with
  `gateway.tailscale.mode: "serve"` exposing it over the tailnet — not a raw tailnet bind
  (as an earlier version of this doc claimed; confirmed against the live config 2026-08-11)
- **Model routing — DECIDED 2026-08-12: free-first with a paid `cc` terminator, no local
  models.** OpenClaw reaches four 9Router providers — `kr` (Kiro, free), `oc` (OpenCode,
  free, custom-registered so it never appears in 9Router's `/v1/models` catalog but still
  routes fine), `gemini` (free), and `cc` (Claude Code, paid). Local LM Studio is **not
  used anywhere** (chat generation, not embeddings — too slow for agent work; local is
  still fine for `agents.defaults.memorySearch`, which is embeddings).
  - **Rule**: `cc` is never a primary model except **Invoicing** (client-facing, quality
    justifies paying unconditionally). Every other agent's chain starts on a free
    provider and ends on `cc` as the last-resort tier — nothing is more reliable than
    `cc`, so nothing gets added after it.
  - **Rule**: chain length isn't fixed. A free model earns a slot only if it adds a real
    capability or genuine provider diversity for that specific cluster; otherwise the
    chain is short (2 tiers). Padding a chain with a model that doesn't help just adds
    failure modes.
  - **Known gotcha, tested 2026-08-12**: 9Router's `kr/*` "agentic"-tagged variants
    (`-agentic`, `-thinking`, `-thinking-agentic` suffixes) return HTTP 400
    `REQUEST_BODY_INVALID` on every request shape — the `agentic:true` capability flag
    describes an internal Kiro routing mode, not something reachable via
    `/v1/chat/completions`. **Use base `kr/*` IDs only** (e.g. `kr/glm-5`, not
    `kr/glm-5-agentic`).
  - Current live mapping (`agents.defaults` + `agents.list[].infra-ops`, applied and
    verified against `~/.openclaw/openclaw.json` 2026-08-12):
    - **Orchestrator** (`main` + subagent default): `kr/claude-haiku-4.5` →
      `oc/deepseek-v4-flash-free` → `gemini/gemini-3.6-flash` → `cc/claude-haiku-4-5-20251001`
    - **infra-ops**: `kr/claude-sonnet-4.5` → `oc/deepseek-v4-flash-free` →
      `cc/claude-sonnet-5`
    - **`agents.defaults.utilityModel`** (global — session/thread title generation only,
      not an agent's reasoning model): `cc/claude-haiku-4-5-20251001`. Set once at
      `agents.defaults` rather than per-agent since it's a generic, agent-agnostic task;
      uses `cc` because `utilityModel` has no fallback field (`string` only, unlike
      `model`'s `{primary, fallbacks}`), so the one slot should be the reliable one.
  - The other 8 clusters (coding, business analytics, study, assignment drafting,
    infra-watcher, invoicing) have a designed mapping but no `agents.list[]` entry yet
    since those agents aren't built — see [ROUTING.md](ROUTING.md) for the per-specialist
    `sessions_spawn` model chains used until then.
  - `gh` (GitHub Copilot, ~200 token context, single-line/narrow tasks only) has **no
    live provider connection in 9Router right now** — don't route anything to it until
    a GitHub Copilot account is connected there.
  - Full design rationale, the complete active-model inventory, and every model verdict
    (kept vs. dropped, and why) live in the planning doc this decision came from —
    ask the assistant if you need that level of detail; it's not duplicated here.

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

## Architecture decision — DECIDED: Coding cluster stays flat (no nested orchestrator)

**The three coding specialists (code review, debug/triage, app-dev) remain independent subagent task briefs spawned directly by the main dispatcher at `maxSpawnDepth: 1`.** This is a deliberate rejection of the alternative "nested orchestrator" design where a coding-orchestrator subagent would itself spawn further sub-subagents for decomposed work.

**Rationale:**

- Matches how the other 10 specialists already work — consistency
- Cheaper (no extra LLM hop for an orchestrator layer)
- Avoids subagent sprawl for work that doesn't need decomposition
- No config change needed (stays at OpenClaw's default `maxSpawnDepth: 1`)
- Can be revisited later if a concrete case emerges where a coding specialist genuinely needs to decompose into sub-work it can't do inline — at that point, raising `maxSpawnDepth` to 2 (plus likely tuning `maxChildrenPerAgent`) would be a one-line config patch, not a redesign

## Architecture decision — DECIDED: app-dev remains generalist (no stack-specific specialists)

**Do NOT split app-dev into stack-specific subagents (Python/Django, PHP/Laravel, Dart/Flutter, JS/React, AI/ML).** Keep one generalist app-dev agent.

**Rationale:**

- Avoids routing ambiguity — "build me an app" would require upfront disambiguation ("which stack?") before routing, violating ROUTING.md's hard rule: "never delegate uncertainty"
- Stack is task detail, not a routing axis — the user's message ("build a Django app") already contains the stack; the app-dev task-brief forwards the verbatim user message, so app-dev knows what to build
- Split only if/when evidence emerges (e.g., DeepSeek Flash struggles with Laravel patterns, or a stack needs dedicated tooling like baked-in artisan CLI) — capability gaps, not naming gaps
- Consistent with the "coding cluster stays flat" decision above

**Future improvement (noted, not yet applied):** Update app-dev's task template to explicitly prompt for stack if the user didn't specify one (e.g., user says "build me a web app" → app-dev asks "Django, Laravel, Next.js, etc.?" before proceeding). Low priority — apply only once this becomes a real friction point.

## Architecture decision — DECIDED: Skill Workshop migration deferred

**The plain-markdown-file pattern (specialist briefs like `watchers/infra-watcher/AGENT.md`, referenced by literal file path in `sessions_spawn` task text) stays as-is for now. Skill Workshop conversion is deferred, not rejected — it will only be revisited once the roster has grown past the current 2 built specialists (infra-watcher, infra-ops) and hand-maintaining plain markdown files actually becomes a real pain point in practice.**

**Rationale:**

- The plain-markdown-via-sessions_spawn(task: "Read X.md...") pattern already works — infra-watcher and infra-ops both prove it in production
- This isn't fixing something broken; Skill Workshop trades upfront conversion effort for better long-term hygiene as the roster scales — a maturity improvement, not a functional gap
- Converting now means converting briefs that already work purely for process hygiene, while 13 unbuilt specialists are still ahead
- Better sequencing: build a few more specialists as plain AGENT.md files first (matching the proven pattern), see if "N hand-maintained markdown files" pain actually shows up, then decide if Skill Workshop conversion is worth it — rather than converting before the pain is confirmed
- Lower priority than the other punch-list items — no urgency, purely optional hygiene

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

## Agent inventory (15 total)

### Task agents (ask → respond, no shared dispatcher — domains don't overlap)

- **Coding & dev**: code review (gh for line comments, cc for cross-file), debug/triage, app-dev (needs high-context route, not gh)
- **Business analytics**: SEO research, metrics reporting, competitive watcher, **cost tracking** (new — Vultr billing API now, Hostinger + others later)
- **Study**: research assistant, study scheduler, assignment drafting (approval gate before submission)

### Autonomous watchers (OpenClaw-native cron, scheduled, silent unless anomaly, no LLM cost)

- **Infra watcher** — built and live (Vultr MCP, Hostinger MCP, WHOIS, SSH all connected and verified). See `watchers/infra-watcher/AGENT.md` and `README.md` for current operational detail — that's the source of truth, not the section below.
- CI watcher (not started)
- Pipeline QA (not started)

### Approval-gated agents (act, but need sign-off on risky steps)

- **Infra ops** — built and live (SSH, restarts, DB fixes — separate from infra watcher, which is read-only). Mutate-capable key deployed and verified on all 6 servers; a forced-command wrapper (`ops-check.sh`) exists and is toggled per server depending on what that server needs (e.g. left open during a migration). See `ops/infra-ops/AGENT.md` and `remote/DEPLOYMENT.md` — check `instances.json`'s `_ops_note` for current per-server restriction status, it changes.
- Invoicing (client-facing, needs approval before sending) — not started

## Infra watcher — DECIDED: MCP-first architecture (no n8n for this agent)

This agent was originally planned as an n8n-driven cron workflow. Redesigned from zero to
be a natural-language, read-only Q&A agent instead — better fit for questions like "what's
CPU% of ulak server" or "which instance has low disk space" than n8n's rigid workflow logic.
**This decision is closed and the agent is built and live** — the architecture below is why,
not a spec to implement. For current operational detail (tool names, thresholds, exact
capabilities, what's connected) see `watchers/infra-watcher/AGENT.md` and `README.md` —
those are the source of truth and get updated as things change; this file won't be kept in
sync with that level of detail going forward.

**Purpose**: answer infra questions conversationally via WhatsApp. READ-ONLY — no reboot,
no delete, no modify. Any agent that controls/acts on servers is a SEPARATE agent (infra-ops).

**Architecture**

```
You → WhatsApp → OpenClaw (read-only tool scope)
                     ├─ Vultr MCP (community server) — live
                     │    → billing/DNS/etc via MCP; instance list/status via a direct-API
                     │      fallback script (this package version has no MCP tool for it)
                     ├─ Hostinger MCP (official) — connected and live
                     │    → VPS list, CPU/RAM/disk/network metrics — READ-ONLY tools only
                     ├─ WHOIS lookup (script) — live
                     │    → domain expiration, ANY registrar, since expiration is public
                     │      WHOIS data — no registrar-specific credential needed
                     └─ SSH (read-only, forced-command restricted) — deployed and verified
                          on all 6 servers in instances.json
                          → cPanel checks per-instance, live resource % for Vultr instances
```

**Why no n8n here**: n8n's workflow logic is rigid (good for scheduled, deterministic
checks) but MCP is a better fit for ad-hoc natural language questions — the agent picks
which tool to call based on what's actually asked, rather than following a fixed branch.
OpenClaw's native cron provides the scheduled/proactive alert path (daily digest, see
"Cron job patterns for watchers" below).

**Safety constraint — hard requirement**
Both Vultr MCP and Hostinger MCP can also write/act (reboot, delete, modify DNS), not just
read. This agent must be scoped to read-only tools only. No destructive capability should
reach this agent under any circumstance; that capability belongs only to the separate
infra-ops agent.

**Cost tracking (lives in Business analytics cluster, not infra watcher)**

- Vultr: `GET /v2/billing/history` and `GET /v2/billing/invoices`
- Fully autonomous, read-only, no approval gate
- Scope to expand to Hostinger and other service costs later

## Repo strategy

Single repo to start (not one-per-agent, not split-by-domain yet). Split later once boundaries
are proven by actual use — moving a folder into its own repo later is cheap, premature splitting
isn't.

```
openclaw-multi-agents/
├── CLAUDE.md              # this file
├── .env.example
├── instances.example.json # placeholder for per-instance SSH keys, real file gitignored
├── shared/                # 9Router config, common prompts/utils
├── task-agents/
│   ├── coding/{code-review,debug-triage,app-dev}/
│   ├── business/{seo-research,metrics-reporting,competitive-watcher,cost-tracking}/
│   └── study/{research-assistant,study-scheduler,assignment-drafting}/
├── watchers/
│   ├── infra-watcher/      # Cron- and MCP-driven — built and live
│   ├── ci-watcher/         # not started
│   └── pipeline-qa/        # not started
└── ops/
    ├── infra-ops/          # built and live
    └── invoicing/          # not started
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

| Watcher               | Pattern                            | Frequency    | Rationale                                                                                                                                        |
| --------------------- | ---------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ci-watcher**  | `trigger.script` + `--command` | Every 15 min | CI status rarely changes; spam on every tick is worse than a short silence. Fire only when a check transitions (e.g. pending→fail, fail→pass). |
| **pipeline-qa** | `trigger.script` + `--command` | Every 15 min | Same reasoning as ci-watcher — pipeline failures are exceptions, not the norm. Only alert on change.                                            |

For the trigger scripts, follow the same structure as `infra-watcher/daily-digest.mjs`:
standalone Node.js, no OpenClaw agent context, no MCP tools, pure `execSync`/fetch/stdout.
The `daily-digest.mjs` source (at `watchers/infra-watcher/daily-digest.mjs`) is the proven
template — modelled on its `execSync` calls, error handling, and threshold checks.

## Current status / next steps

1. ✅ Tailscale connected, OpenClaw gateway reachable from n8n server
2. ✅ `/hooks/agent` webhook confirmed working end-to-end (WhatsApp message delivery confirmed)
3. ✅ Infra watcher: MCP-first architecture built and live — Vultr MCP, Hostinger MCP, WHOIS
   lookup, and per-instance SSH (forced-command restricted) all connected and verified.
   Daily digest cron job (`infra-watcher-daily`) running. See `watchers/infra-watcher/AGENT.md`.
4. ✅ DECIDED: OpenClaw-native cron for all scheduled watchers. n8n kept only if a specific
   future need requires something cron genuinely can't do (credential vault/workflow UI) —
   not as default execution layer. See "Cron job patterns for watchers" below.
5. ✅ Infra ops built and live — mutate-capable SSH key (`infra_ops_ed25519`) deployed and
   verified on all 6 servers. Forced-command wrapper (`ops-check.sh`) built, covering
   read-only diagnostics + service/container restart-reload; toggled per server rather than
   applied uniformly (some servers restricted, some left full-access for tasks that need the
   broader toolset). See `ops/infra-ops/AGENT.md` and `remote/DEPLOYMENT.md` — check
   `instances.json`'s `_ops_note` for current per-server status, it changes.
6. ⬜ CI watcher — not started
7. ⬜ Pipeline QA — not started
8. ⬜ Task agents (coding, business analytics, study clusters) — not started
9. ⬜ Invoicing (approval-gated ops agent) — not started

## Security notes

- `OPENCLAW_HOOKS_TOKEN` must be different from `gateway.auth.token` — do not reuse
- SSH access should use key files, not passwords
- Rotate any token that's been shared in chat/screenshots before going live
- `.env` is gitignored — only `.env.example` (no real values) gets committed
- `instances.json` is gitignored — only `instances.example.json` (placeholder values) gets committed
- `domains.json` is fine to commit (just domain names, no credentials) unless the
  list itself reveals sensitive client/business info — use judgment per repo visibility
- Test each SSH key manually (`ssh -i <key> user@host`) before wiring into any workflow
- MCP servers (Vultr, Hostinger) must be scoped to READ-ONLY tools for this agent — verify
  tool permissions explicitly rather than assuming defaults are safe
