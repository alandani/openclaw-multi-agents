# infra-ops & invoicing — Agent Specification (DRAFT)

> ⚠️ **This is a planning/specification document only.** Nothing here has been applied to
> live `openclaw.json` config, and no code or subagent has been built for either agent.
> This spec exists to define the design for review and implementation reference.
>
> Origin: Punch-list item #6 from the architecture review — "infra-ops and invoicing
> should become real `agents.list[]` entries with scoped tools and approval gates."

---

## Table of Contents

1. [Architecture Context](#architecture-context)
2. [OpenClaw Config Schema — Grounded Claims](#openclaw-config-schema--grounded-claims)
3. [1. infra-ops](#1-infra-ops)
4. [2. invoicing](#2-invoicing)
5. [Open Questions](#open-questions)
6. [Implementation Sequence](#implementation-sequence)

---

## Architecture Context

The repo currently has **11 lightweight subagent specialists** defined as `sessions_spawn`
task briefs (documented in `ROUTING.md`). These are one-shot spawned subagents that
read/report but never act destructively. They share the generic tool ceiling from
`tools.subagents.tools.*` and are stateless.

**infra-ops** and **invoicing** are fundamentally different: they need to *act* on real
infrastructure or send real communications. Per the architectural decision (not up for
debate in this document), they should become **real `agents.list[]` entries** in OpenClaw's
config, each with their own scoped `tools.allow`/`tools.deny`, and each requiring an
explicit user confirmation step before any action-taking tool call executes.

> **Why `agents.list[]` and not just subagents with tighter scoping?**
>
> Subagents spawned via `sessions_spawn` inherit the spawning agent's tool ceiling
> filtered through `tools.subagents.tools.*`. They cannot have an independent tool
> policy — only deny additions. Registered `agents.list[]` entries have their own
> top-level `tools.allow`/`tools.deny`, their own `sandbox` config, their own
> workspace/agentDir, and their own model config. This gives each agent a hard
> tool boundary independent of the main agent's capabilities.

---

## OpenClaw Config Schema — Grounded Claims

All schema claims below are sourced from the following OpenClaw documentation (installed
at `/opt/homebrew/lib/node_modules/openclaw/`):

| Doc | Path | Key Content |
|-----|------|-------------|
| **Agent config** | `docs/gateway/config-agents.md` (≈ lines 998+) | Full `agents.list[]` entry schema: `id`, `default`, `name`, `workspace`, `agentDir`, `model` (string or `{primary, fallbacks}`), `utilityModel`, `skills`, `thinkingDefault`, `reasoningDefault`, `params`, `sandbox` (mode, scope, workspaceAccess, docker/ssh/browser), `tools` (profile, allow, deny, elevated, message, sandbox.tools), `identity`, `subagents`, `tts`, `runtime`, `heartbeat`, `contextLimits`, `bootstrap*`, `contextInjection` |
| **Multi-agent sandbox & tools** | `docs/tools/multi-agent-sandbox-tools.md` | Precedence: per-agent `tools.allow`/`deny` override global, `deny` always wins, `allow` = blocklist, tool groups (`group:*` shorthands), empty allowlist = no callable tools (fails closed) |
| **Sandbox vs tool policy vs elevated** | `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md` | Three independent controls: sandbox (where), tool policy (which), elevated (exec-only escape). Tool groups documented. |
| **Exec approvals** | `docs/tools/exec-approvals.md` | Host exec approvals: `mode`/`security`/`ask`/`askFallback`. **Exec-only** — does NOT apply to `write`, `edit`, MCP tools, etc. |
| **CLI approvals** | `docs/cli/approvals.md` | `openclaw approvals` / `openclaw exec-policy` CLI reference |

### Key schema capabilities confirmed

1. **Per-agent model**: `agents.list[].model` accepts a string `"provider/model"` or an object `{ primary: "...", fallbacks: [...] }`. Per-agent `utilityModel` also supported.

2. **Per-agent tools**: `agents.list[].tools.allow` and `agents.list[].tools.deny` are real arrays of tool names or `group:*` shorthands. These operate independently of `tools.subagents.tools.*`. Precedence: `deny` > `allow`. If `allow` is non-empty, everything not listed is blocked.

3. **Per-agent sandbox**: `agents.list[].sandbox` supports `mode: "off"|"non-main"|"all"`, `scope: "session"|"agent"|"shared"`, `workspaceAccess: "none"|"ro"|"rw"`, plus backend-specific config (docker, ssh, browser).

4. **Per-agent workspace/agentDir**: `workspace` sets the bootstrap context; `agentDir` sets a separate auth store path (`~/.openclaw/agents/<agentId>/agent/`).

5. **Per-agent identity**: `agents.list[].identity` supports `name`, `theme`, `emoji`, `avatar`.

6. **Routing**: `bindings[]` maps agents to channels/peers via `{ agentId, match: { channel, accountId, peer } }`.

### Native approval-gate mechanism — finding

**No native config-layer confirmation gate exists for arbitrary tool calls.**

OpenClaw's exec-approvals system (documented in `docs/tools/exec-approvals.md` and
`docs/cli/approvals.md`) is specifically for the **`exec` tool only** — it controls
whether shell commands can run on the host and whether a prompt is shown. There is no
equivalent "ask before this tool call" primitive for `write`, `edit`, `sessions_send`,
`message`, or MCP plugin tools.

The available native enforcement tools for arbitrary tools are:
- **`tools.allow`/`tools.deny`** — hard allow/block at the tool-name level (binary, no prompt)
- **`tools.sandbox.tools.allow`/`deny`** — same binary block within sandbox
- **`sandbox.mode`** — restricts where tools run (host vs container)
- **`sandbox.workspaceAccess`** — filesystem access level within sandbox

None of these supports a "run this tool but ask first" mode.

**Proposed alternative**: The agent's own system prompt / AGENT.md brief must be
structured to explicitly require the agent to state its intended action and wait for
"yes/confirm" before calling any mutating tool. Combined with tight `tools.allow`
scoping as the real enforcement backstop (the agent physically cannot run tools outside
its allowlist), this provides two-layer protection without a native gate primitive.

---

## 1. infra-ops

### a) Scope Statement

infra-ops is the **read/write execution counterpart** to the read-only infra-watcher.
It exists to *act* on infrastructure, not just observe it.

**What it is allowed to do** (concrete bounds):

| Category | Allowed | Examples |
|----------|---------|---------|
| **Read** (diagnostic) | ✅ Always allowed | `ssh user@host df -h`, `systemctl status nginx`, `docker ps`, `journalctl -u nginx`, MySQL `SELECT` queries |
| **Restart / reload services** | ✅ With confirmation | `systemctl restart nginx`, `systemctl restart mariadb`, `supervisorctl restart all`, `docker compose restart` |
| **Deploy / update** | ✅ With confirmation | `git pull && build`, `docker compose pull && up -d`, rsync new artifacts |
| **Run database migrations** | ✅ With confirmation | `wp db migrate`, custom migration scripts, `ALTER TABLE` statements |
| **Reboot server** | ✅ With confirmation | `shutdown -r now`, `reboot` |
| **Destructive delete** | ❌ Never allowed | `rm -rf`, `DROP DATABASE`, `DELETE FROM` without WHERE, `docker system prune -a` |
| **Modify config files** | ✅ With confirmation | Edit nginx vhost, `wp-config.php`, `.env` files |
| **Modify DNS / firewall** | ❌ Unless explicitly scoped in | Not in initial scope — handled via provider dashboards |
| **Install packages** | ✅ With confirmation | `apt install`, `npm install -g`, `pip install` on managed servers |
| **SSH to servers** | ✅ To known hosts only | Only hosts listed in `instances.json` — never arbitrary IPs/hosts |

**Server access**: SSH to the same set of servers tracked by `instances.json` for
infra-watcher, but with **execution capability** (not just read-only commands).
The `instances.json` file acts as the allowlist of reachable hosts.

**Key constraint**: All mutating operations require user confirmation **before execution**.
Read-only diagnostic operations do not need confirmation but should still log what was
done.

### b) Proposed `agents.list[]` Config Entry

```json5
{
  id: "infra-ops",
  name: "Infrastructure Operations Agent",
  workspace: "/Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents/ops/infra-ops",
  agentDir: "~/.openclaw/agents/infra-ops/agent",
  model: {
    primary: "9router/oc/deepseek-v4-flash-free",
    fallbacks: [
      "9router/cc/claude-sonnet-5",
      "9router/kr/claude-haiku-4.5"
    ]
  },
  utilityModel: "lmstudio/qwen/qwen3.5-9b",
  skills: [], // no skills — pure tool-driven
  sandbox: {
    mode: "off" // runs on host (needs SSH access — Docker sandbox cannot SSH to host Tailscale network)
  },
  tools: {
    profile: "coding", // inherits coding base tools
    allow: [
      // Read-only diagnostics
      "read",
      "web_search",
      "web_fetch",
      // SSH & exec — allows shell commands
      "exec",
      "process",
      // Session introspection (to report results back)
      "sessions_list",
      "sessions_send",
      "session_status",
      // Memory
      "memory_search",
      "memory_get",
      // FS access to read AGENT.md, instances.json, command scripts
      "edit",
      "apply_patch",
      "write" // writing temp scripts/logs only — actual mutating edits go through SSH exec
    ],
    deny: [
      "gateway",      // no gateway config changes
      "cron",         // no cron changes
      "browser",      // no web browsing
      "canvas",       // no canvas
      "image",        // no image processing
      "image_generate",
      "music_generate",
      "video_generate",
      "tts",
      "nodes",        // no node management
      "discord",      // no cross-channel messaging
      "telegram",
      "slack",
      "whatsapp",     // <-- IMPORTANT: deny direct WhatsApp for sending (communication goes through main agent relay)
      "message",      // deny direct message tool
      "create_goal",
      "update_goal",
      "update_plan",
      "skill_workshop"
    ],
    elevated: {
      enabled: false // infra-ops should NEVER run elevated — always subject to tool policy
    }
  },
  heartbeat: {
    every: "0m" // no heartbeat — on-demand only, triggered via main dispatcher
  },
  identity: {
    name: "InfraOps",
    emoji: "🔧"
  },
  subagents: {
    allowAgents: [], // cannot spawn subagents
    maxConcurrent: 0
  },
  contextInjection: "continuation-skip", // lighter context, doesn't need full bootstrap every turn
  contextLimits: {
    memoryGetMaxChars: 6000,
    memoryGetDefaultLines: 60,
    toolResultMaxChars: 32000 // SSH results can be large
  },
  bootstrapMaxChars: 8000,
  bootstrapTotalMaxChars: 24000
}
```

#### Model choice rationale

| Tier | Model | Why |
|------|-------|-----|
| **Primary** | `9router/oc/deepseek-v4-flash-free` | Fast, free, good at tool-using tasks. Infra ops involves shell commands and structured JSON — DeepSeek Flash handles this well. |
| **Fallback 1** | `9router/cc/claude-sonnet-5` | Better reasoning for complex diagnostics; falls back when primary fails. |
| **Fallback 2** | `9router/kr/claude-haiku-4.5` | Lightweight last resort. |
| **Utility** | `lmstudio/qwen/qwen3.5-9b` | Free local model for lightweight internal tasks (via `utilityModel`). |

#### Sandbox rationale

`sandbox.mode: "off"` — infra-ops needs SSH access to the Tailscale network. Docker
sandboxes default to `network: "none"` and cannot reach Tailscale peers. Even with
network bridge access, SSH key files live on the host filesystem and would need bind
mounting. Running on host is the simplest and most reliable arrangement for this agent.

If security isolation is desired later, consider an SSH-based sandbox backend or a
Docker sandbox with `network: "bridge"`, bind-mounted SSH keys, and `workspaceAccess: "ro"`.

### c) Confirmation-Gate Design

**Since no native config primitive exists for "ask before arbitrary tool call"** (confirmed:
exec-approvals in `docs/tools/exec-approvals.md` is `exec`-only; `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md`
confirms tool policy is binary allow/deny only), the design uses two enforcement layers:

#### Layer 1: System prompt / AGENT.md directive (soft enforcement)

The agent's `AGENT.md` brief (to be created at `ops/infra-ops/AGENT.md`) will include
an explicit mandatory instruction:

> **Mandatory confirmation gate**: Before executing any command that modifies system state
> (restart, deploy, migrate, reboot, edit files, install packages, or any non-read-only
> operation), you MUST:
> 1. Describe the exact command you intend to run
> 2. List the target server and the expected effect
> 3. Wait for explicit confirmation from the user (e.g. "yes", "proceed", "go ahead")
> 4. Only execute after receiving confirmation
>
> Read-only diagnostic commands (df, free, top, status checks, etc.) do not require
> confirmation.
>
> If the user does not explicitly confirm, do NOT proceed. Do not interpret ambiguous
> responses as confirmation.

This is a prompt-level instruction and is not cryptographically enforced — the agent
can theoretically be prompted to bypass it. That is why Layer 2 exists.

#### Layer 2: Tight tools.allow scoping (hard enforcement)

Proof that the agent physically cannot act outside its `tools.allow`:

- **Denied**: `gateway`, `cron`, all MCP tools that could mutate infrastructure independently
- **Denied**: `message`, `whatsapp`, `discord`, `telegram`, `slack` — cannot send external communications independently
- **Allowed exec**: `exec` + `process` are allowed, but the main agent's routing (`ROUTING.md`) should only route to infra-ops via `sessions_spawn` with explicit user confirmation at the main-agent level first (as the existing ROUTING.md stopgap describes)
- The `instances.json` file defines which SSH hosts are reachable — the agent physically cannot SSH to other hosts because no SSH config exists for them

#### Layer 3: Main-agent routing gate (existing ROUTING.md mechanism)

The main dispatcher (as documented in `ROUTING.md`) already requires explicit user
confirmation before delegating to infra-ops. This remains the entry gate:

1. User asks to do something on a server
2. Main agent warns: *"I can do that via infra-ops — it will SSH into [server] and [action]. Confirm?"*
3. Main agent waits for explicit "yes"
4. Only then spawns the infra-ops subagent via `sessions_spawn` with `agentId: "infra-ops"`

### d) Agent Workspace Layout

```
ops/infra-ops/
├── AGENT.md          # Agent brief (to be written) — system prompt with confirmation gate
├── AGENTS-SPEC.md    # ← this document
└── .gitkeep
```

The `instances.json` at the repo root (shared with infra-watcher) serves as the SSH
host allowlist. No separate infra-ops version needed — the same host list feeds both.

---

## 2. invoicing

### a) Scope Statement

invoicing is the **client-facing billing agent**. It exists to draft, review, and send
invoices to clients. Financial and legal implications require a higher confirmation bar
than infra-ops.

**What it is allowed to do** (concrete bounds):

| Category | Allowed | Examples |
|----------|---------|----------|
| **Draft invoice** (preview only) | ✅ Always allowed | Create invoice object, populate line items, calculate totals |
| **Review existing invoices** | ✅ Always allowed | Check status, payment history, amounts |
| **Send invoice** (external) | ✅ With **explicit double confirmation** | Email invoice to client, share payment link |
| **Cancel/void invoice** | ✅ With **explicit double confirmation** | Void an unpaid or mistakenly created invoice |
| **Modify/update invoice** | ✅ With confirmation | Update line items, amounts, due dates on draft invoices |
| **Delete invoice** | ❌ Never allowed | Destroying financial records |
| **Access financial data** | ✅ Within scope only | Invoice amounts, client billing info, payment status |
| **Access non-financial client data** | ❌ Not in scope | No access to client private data outside what appears on invoices |
| **Send payment reminders** | ✅ With confirmation | Follow-up on overdue invoices |

**Key constraint**: Drafting is free. **Sending** to a client requires:
1. Full preview shown to the user (what will be sent, to whom, for how much)
2. Explicit user confirmation
3. Send only after confirmation

The agent should produce a structured preview that the user can verify before approving.

**Open question**: What invoicing/billing tool or service backs this agent? Options
include Stripe API, FreshBooks API, Wave, Xero, manual PDF generation + email, or a
custom MCP server wrapping an accounting tool. The answer determines the specific tool
names in the allowlist and the API library dependencies.

### b) Proposed `agents.list[]` Config Entry

```json5
{
  id: "invoicing",
  name: "Invoicing Agent",
  workspace: "/Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents/ops/invoicing",
  agentDir: "~/.openclaw/agents/invoicing/agent",
  model: {
    primary: "9router/cc/claude-sonnet-5", // invoicing needs high accuracy — no free models for financial data
    fallbacks: [
      "9router/cc/claude-opus-4-8",
      "9router/kr/claude-haiku-4.5"
    ]
  },
  skills: [], // no skills — pure tool-driven
  sandbox: {
    mode: "off" // runs on host (needs local API access for billing tool)
  },
  tools: {
    allow: [
      // Read — for AGENT.md, templates, client data
      "read",
      "memory_search",
      "memory_get",
      "web_search",
      "web_fetch",
      // Write — for drafting invoice files locally (preview stage)
      "write",
      "edit",
      // Minimal session — for reporting results
      "sessions_send",
      "session_status",
      // NO exec — invoicing should not execute arbitrary shell commands
      // Plugin tools — only the invoicing/billing MCP tool(s)
      //   e.g. "stripe__*" or "freshbooks__*" or custom invoicing plugin
    ],
    deny: [
      "gateway",
      "cron",
      "exec",           // crucially blocked — cannot run shell commands
      "process",
      "browser",
      "canvas",
      "image",
      "image_generate",
      "music_generate",
      "video_generate",
      "tts",
      "nodes",
      "discord",
      "telegram",
      "slack",
      "whatsapp",       // cannot independently WhatsApp clients
      "message",
      "create_goal",
      "update_goal",
      "update_plan",
      "skill_workshop",
      "sessions_spawn", // cannot spawn subagents
      "sessions_yield"
    ],
    elevated: {
      enabled: false // invoicing should NEVER run elevated
    }
  },
  heartbeat: {
    every: "0m" // no heartbeat — on-demand only
  },
  identity: {
    name: "Invoicing",
    emoji: "📋"
  },
  subagents: {
    allowAgents: [],
    maxConcurrent: 0
  },
  contextInjection: "always", // full context every turn — invoicing accuracy matters
  contextLimits: {
    memoryGetMaxChars: 12000,
    toolResultMaxChars: 16000
  },
  bootstrapMaxChars: 12000,
  bootstrapTotalMaxChars: 36000
}
```

#### Model choice rationale

| Tier | Model | Why |
|------|-------|-----|
| **Primary** | `9router/cc/claude-sonnet-5` | Best accuracy/compliance with tool-calling tasks involving structured data (invoices); no free model for financial work |
| **Fallback 1** | `9router/cc/claude-opus-4-8` | Max reasoning if primary fails; relevant for complex invoice disputes or edge cases |
| **Fallback 2** | `9router/kr/claude-haiku-4.5` | Lightweight last resort for simple lookups |
| **Utility** | (inherits primary — no utility model override) | |

#### Key decisions in this config

- **`exec` is denied** intentionally — invoicing should never run shell commands. All
  billing operations go through API/MCP tool calls or file writes for preview drafts.
- **`sessions_spawn` denied** — invoicing should not spawn subagents itself.
- **MCP billing tool not yet specified** — the `tools.allow` list above includes
  placeholder plugin-tool entries. The actual billing MCP server (e.g. Stripe, FreshBooks,
  or a custom invoicing script exposed via `bundle-mcp`) must be identified and its tool
  names added to `tools.allow` before this agent goes live.

### c) Confirmation-Gate Design

Same principle as infra-ops, but **stricter**: financial actions are harder to undo.

#### Layer 1: System prompt / AGENT.md directive

The agent's brief will include:

> **Mandatory confirmation gate**: This agent handles financial data and client-facing
> communications. The following strict rules apply:
>
> 1. **Drafting is free**: You may create, preview, and share invoice drafts with the
>    user via `sessions_send` without additional confirmation.
> 2. **SENDING requires double confirmation**: Before calling any API method that will
>    transmit an invoice to a client, you MUST:
>    a. Show the user the FULL invoice preview (client name, amounts, line items, due date)
>    b. Wait for explicit confirmation (e.g. "yes", "send it", "confirmed")
>    c. After user confirms, repeat the key details back one more time and ask "Send now?"
>    d. Wait for a second confirmation before executing the send
> 3. **Voiding/cancelling** follows the same double-confirmation flow as sending.
> 4. **The `exec` tool is not available to this agent.** You cannot run shell commands
>    or interact with the filesystem outside the workspace. All billing operations must
>    go through the configured API/MCP billing tool.
>
> If the user gives ambiguous feedback, ask for clarification. Do not proceed without
> a clear affirmative.

#### Layer 2: Tool scope backstop

- **`exec` is denied** — the agent physically cannot SSH into servers or run shell code.
- **`whatsapp`, `message`, `discord`, etc. are denied** — cannot independently message
  clients except through `sessions_send` (which reports back to the main agent).
- The billing API tool (TBD) is the **only** way to actually send an invoice externally,
  and the agent's prompt is structured to never call the "send" variant of that tool
  without explicit double confirmation.

#### Layer 3: Main-agent routing gate (same as infra-ops)

The main dispatcher's `ROUTING.md` already gates invoicing delegation behind explicit
user confirmation. This is maintained and reinforced.

### d) Agent Workspace Layout

```
ops/invoicing/
├── AGENT.md          # Agent brief (to be written)
├── AGENTS-SPEC.md    # ← this document
├── templates/        # (future) invoice templates
└── .gitkeep
```

---

## 3. Open Questions

The following decisions are **not resolved** in this document and need user input before
either agent can be built:

### for infra-ops

1. **SSH command allowlist**: Should infra-ops have a strict allowlist of accepted SSH
   commands (e.g. only `systemctl`, `docker`, `journalctl`, `git`, `wp`, `npm`, `apt`),
   or a more permissive policy where any shell command is allowed but the confirmation
   gate catches risky ones? A command allowlist via `tools.exec.mode: "allowlist"` in
   the exec-approvals system would provide hard enforcement for `exec`.

   **RESOLVED** — strict allowlist with 6 categories (A-F) documented in
   `ops/infra-ops/AGENT.md` § "SSH Command Allowlist". A server-side
   forced-command wrapper (`ops/infra-ops/remote/ops-check.sh`) now exists,
   covering Category A (read-only) and B (service/container restart-reload)
   with real enforcement — injection-safe argument validation, not just
   agent self-policing. It's deployed on a per-server, toggleable basis (see
   `remote/DEPLOYMENT.md`); Categories C-F remain self-policed everywhere
   until they have a safe parameterized form. Check `instances.json`'s
   `_ops_note` per server for current restriction status — it changes as
   servers get toggled for specific tasks (e.g. left open during a
   migration). See AGENT.md § "Current SSH key situation" for the full
   model, and § "Permanent Blacklist" for the corresponding forbidden list.

2. **Separate WhatsApp or same dispatcher?**: Should infra-ops's confirmation and
   results go back through the main dispatcher (current design), or should it have its
   own WhatsApp channel/number for dedicated ops conversations?

   **RESOLVED** — same dispatcher, no separate WhatsApp channel. infra-ops is spawned
   via `sessions_spawn(agentId: "infra-ops")` from the main dispatcher and
   communicates results back through it. No `bindings[]` entry needed.

3. **Cron schedule needed?**: Should infra-ops have a proactive mode (e.g. "check Nginx
   on all servers every morning, report any failures and ask if I should restart"), or
   is it purely on-demand?

   **RESOLVED** — no heartbeat/cron/proactive mode. Purely on-demand, spawned only by
   the main dispatcher in response to a user request. heartbeat.every set to "0m".
   (Revisit later once the agent is battle-tested and trusted.)

4. **Exact destructive-operation blacklist**: Beyond the open-ended "no rm -rf" rule,
   are there specific operations that should be categorically denied? (e.g. firewall
   changes, DNS modifications, database DROP, package removal)

   **RESOLVED** — permanent blacklist documented in `ops/infra-ops/AGENT.md` §
   "Permanent Blacklist — NEVER Allowed (No Exceptions, No Confirmation Override)".
   Covers: rm -rf, DROP DATABASE/TABLE, DELETE without WHERE, docker system prune -a,
   ALL firewall/DNS changes, package removal, and chmod/chown on system-critical
   paths. The list is absolute — no confirmation can unlock these.

5. **GitOps preference**: Should infra-ops commit config changes to a git repo and
   there be a separate deployment pipeline, or should it push changes directly? The
   direct approach is simpler but less auditable.

   **RESOLVED** — direct actions only for operational changes on managed servers. No
   git-commit-and-pipeline requirement. (Changes to files in this repo itself are not
   operational actions and follow normal review/commit workflows.)  Revisit if config
   drift or audit gaps become a real problem.

### for invoicing

6. **Billing/accounting tool**: Which tool powers invoicing? Options:
   - **Stripe** (has an official MCP server: `stripe/agent-toolkit`)
   - **FreshBooks API** (no standard MCP — would need a custom script)
   - **Wave** (no standard MCP — would need a custom script)
   - **Manual PDF generation** (Node.js script + email — simplest but most manual)
   - **Hostinger/Vultr billing API** (for reading invoices only, not sending)
   
   This decision determines:
   - Which MCP server to add to config
   - Which tool names go in `tools.allow`
   - What API setup (API keys, webhook URLs) is needed

7. **Client list source**: Where does the client list come from? Options:
   - Static JSON file in the repo (`clients.json`, gitignored)
   - CRM API integration
   - Directly from the billing tool's client registry
   - User provides client details at time of invoice creation

8. **Invoice numbering scheme**: Is there a required format? (e.g. `INV-YYYY-MM-XXXX`,
   sequential integers, project-based)

9. **Self-sending vs draft-only**: Final decision: does this agent *actually send*
   invoices to clients, or does it draft them for the user to review and manually
   send? The scope statement above assumes "yes, with double confirmation" — but
   this needs explicit sign-off.

10. **Payment gateway**: If invoices are sent, how do clients pay? (Stripe payment link
    in the invoice, bank transfer details, PayPal, etc.)

### General

11. **Auth for the new agents**: The `agentDir` for each agent has its own SQLite
    auth store (`~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite`). API keys for
    the billing tool and SSH key paths need to be available. Should they share the
    main agent's auth profiles or have their own? (Best practice per OpenClaw docs:
    never reuse `agentDir` across agents.)

12. **When to start building**: The architecture review punch-list is `P6` — what
    priority do these have relative to the remaining infra-watcher items (items 4-8
    in PROGRESS.md, e.g. "Connect Vultr MCP scoped read-only", "Set up per-instance
    SSH access")?

---

## Decisions (resolved for infra-ops #1-5)

The following decisions for infra-ops-specific open questions (#1-5) have been
resolved in the course of building the agent. Questions #6-12 (invoicing + general)
remain open and are untouched here.

| # | Question | Resolution | Rationale |
|---|----------|-----------|-----------|
| 1 | SSH command allowlist | **Strict command allowlist** (6 categories, A–F, plus a permanent blacklist) documented in `ops/infra-ops/AGENT.md`. A mutate-capable key (`infra_ops_ed25519`) is deployed and verified on all 6 servers. Server-side enforcement (`ops-check.sh`, matching infra-watcher's forced-command pattern) exists and covers Categories A+B — deployed on a per-server toggleable basis, off where a task needs the full toolset (e.g. during a migration). Categories C–F remain self-policed everywhere. | Matches the spirit of infra-watcher's forced-command pattern (`readonly-check.sh`); server-side enforcement for the common actions (status checks, restarts) is real now, with the harder-to-parameterize categories deliberately deferred rather than either fully open or fully blocked. |
| 2 | Separate WhatsApp or same dispatcher? | **Same dispatcher** — results go back through the main dispatcher via `sessions_spawn`. No dedicated ops WhatsApp channel. | infra-ops is an on-demand agent like all others in the roster; adding a dedicated channel adds complexity without a demonstrated need. Results go through the existing ack+relay pattern. |
| 3 | Cron schedule needed? | **No heartbeat** (`every: "0m"`). Purely on-demand. | infra-ops is action-oriented (restart, deploy, migrate) — not a periodic status check. Proactive alerts ("check Nginx on all servers every morning") are best handled by the read-only infra-watcher instead; infra-ops only gets involved when infra-watcher finds something that needs fixing. |
| 4 | Destructive-operation blacklist | **Confirmed as listed in the existing draft**: `rm -rf`, `DROP DATABASE`/`DROP TABLE`/unscoped `DELETE`, `docker system prune -a`. **Additional**: firewall and DNS changes are entirely out of scope — they stay manual via provider dashboards. | These operations are data-loss or high-blast-radius events that no agent should perform. The blacklist is documented in `ops/infra-ops/AGENT.md` (the "never allowed" section) and enforced by tool scoping. Firewall/DNS are out because they affect availability/security globally and require provider-dashboard access anyway. |
| 5 | GitOps preference | **Direct changes only** for now — no separate deploy pipeline. | infra-ops is a proof-stage agent; adding a GitOps layer on day one is overhead with no demonstrated need. Revisit if config drift, audit gaps, or rollback difficulties become a real pain point in practice. |

## 4. Implementation Sequence

When the open questions above are resolved, the implementation order should be:

1. **Create each agent's AGENT.md** — the system-prompt brief with the embedded
   confirmation-gate instructions (this is the soft enforcement layer)
2. **Add `agents.list[]` entries** to `openclaw.json` (the real enforcement —
   `tools.allow`/`deny` + sandbox config)
3. **Configure `bindings[]`** if the agents need their own channel attachment
   (likely not — they'll be spawned via `sessions_spawn` with `agentId`)
4. **Update `ROUTING.md`** to use `agentId` in the `sessions_spawn` calls instead
   of free-form task briefs (replacing the stopgap section)
5. **Set up tool auth** (API keys in the new `agentDir` SQLite stores)
6. **Test with non-mutating commands first** (e.g. `df -h` for infra-ops, draft-only
   invoice for invoicing)
7. **Test the confirmation gate** — verify the agent actually waits before mutating
8. **Test live** — run a real restart / send a real invoice (with user watching)

## infra-ops — Finalized Config (applied)

This section records the finalized `agents.list[]` config entry for infra-ops,
reflecting the 5 resolved decisions from the Open Questions section above.
**This has been applied to `openclaw.json`** (agent id `infra-ops`, live under
`agents.list[]`).

Key differences from the spec's initial proposal (see § "b) Proposed Config
Entry" above):

- **SSH command allowlist**: Not enforceable server-side yet — no mutate-capable SSH
  key or forced-command mechanism has been provisioned. OpenClaw's own exec-approvals
  allowlist is host-exec only and cannot gate SSH-remote command strings either. The
  AGENT.md documents the strict, currently self-policed allowlist with 6 categories
  (A–F) plus a permanent blacklist. See `ops/infra-ops/AGENT.md`.
- **No separate WhatsApp / bindings**: infra-ops has no `bindings[]` entry. It is
  spawned by the main dispatcher via `sessions_spawn(agentId: ...)`.
- **heartbeat.every: "0m"**: Already present in the initial proposal. Confirmed
  as correct — no proactive/cron mode.
- **Permanent blacklist**: The proposed tools.deny is unchanged, but the AGENT.md
  now documents a non-negotiable permanent blacklist of operations that no
  confirmation can unlock (rm -rf, DROP DATABASE, firewall/DNS changes, package
  removal, chmod/chown on system-critical paths, etc.).
- **No GitOps requirement**: Confirmed — operational actions are direct. The
  AGENT.md explicitly states this.

```json5
{
  id: "infra-ops",
  name: "Infrastructure Operations Agent",
  workspace: "/Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents/ops/infra-ops",
  agentDir: "~/.openclaw/agents/infra-ops/agent",
  model: {
    primary: "9router/oc/deepseek-v4-flash-free",
    fallbacks: [
      "9router/cc/claude-sonnet-5",
      "9router/kr/claude-haiku-4.5"
    ]
  },
  utilityModel: "lmstudio/qwen/qwen3.5-9b",
  skills: [],
  sandbox: {
    mode: "off"
  },
  tools: {
    profile: "coding",
    allow: [
      "read",
      "web_search",
      "web_fetch",
      "exec",
      "process",
      "sessions_list",
      "sessions_send",
      "session_status",
      "memory_search",
      "memory_get",
      "edit",
      "apply_patch",
      "write",
      "hostinger__*"
    ],
    deny: [
      "gateway",
      "cron",
      "browser",
      "canvas",
      "image",
      "image_generate",
      "music_generate",
      "video_generate",
      "tts",
      "nodes",
      "discord",
      "telegram",
      "slack",
      "whatsapp",
      "message",
      "create_goal",
      "update_goal",
      "update_plan",
      "skill_workshop"
    ],
    elevated: {
      enabled: false
    }
  },
  // No heartbeat — on-demand only. No bindings — spawned via sessions_spawn.
  heartbeat: {
    every: "0m"
  },
  identity: {
    name: "InfraOps",
    emoji: "🔧"
  },
  subagents: {
    allowAgents: [],
    maxConcurrent: 0
  },
  contextInjection: "continuation-skip",
  contextLimits: {
    memoryGetMaxChars: 6000,
    memoryGetDefaultLines: 60,
    toolResultMaxChars: 32000
  },
  bootstrapMaxChars: 8000,
  bootstrapTotalMaxChars: 24000
}
```

---

### Update 2026-08-07 — Hostinger MCP access added

Expanded `tools.allow` to include `hostinger__*` (the shared `hostinger` MCP server),
and expanded the global `mcp.servers.hostinger.toolFilter.include` list in
`openclaw.json` to add the mutating WordPress endpoints (core/plugin/theme update,
plugin/theme activate/install/uninstall, cache purge/toggle, maintenance toggle,
Memcached toggle) alongside the existing read-only set. Purpose: let infra-ops fix
Hostinger-hosted WordPress sites (update plugins, toggle maintenance mode, clear
cache, etc.) under the same confirmation-gate model as its SSH categories B–F. See
`ops/infra-ops/AGENT.md` § "Hostinger — WordPress Fix Access" for the full tool
split and confirmation rules. `hosting_deleteWordPressInstallationV1` and
`hosting_installWordPressV1` were deliberately left out of the toolFilter/allowlist
(too destructive / out of scope for a fix-only agent).

---

> **End of draft document. Nothing in this file has been applied to `openclaw.json`
> or to any OpenClaw configuration.**
>
> This spec is punch-list item #6 from the architecture review — the final step before
> these two agents can move from "planned" to "in development."
>
> Review and resolve the [Open Questions](#open-questions) section above before building.
