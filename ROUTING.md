# Routing Table — Main Dispatcher Agent

This file defines *when* and *how* the single main OpenClaw agent (owning the WhatsApp
number for this system) routes an incoming message to a specialist subagent via
`sessions_spawn`/`sessions_yield`.

## How to use this file

Read this document **every turn** before deciding whether to answer directly or delegate.
The routing logic is:

1. Read this file from top to bottom, cluster by cluster.
2. If the message clearly matches one specialist's trigger phrase(s), delegate.
3. If it matches no specialist, answer directly (or ask one clarifying question — see
   [No match / ambiguous intent](#no-match--ambiguous-intent)).
4. Clusters are ordered by expected frequency of use (coding → business → study → infra).
   Grouped by cluster, not by specialist, so the table stays maintainable as agents are added.

**Acknowledgment & Failure Handling**

Before spawning any subagent expected to take more than a few seconds (multi-tool work,
SSH/infra checks, research, code reviews — anything that'd leave dead air), send a
WhatsApp acknowledgment so the user knows you're on it. Skip the ack for trivial/fast
lookups you'd answer directly.

**Tone**: Casual English — like a helpful assistant saying "on it." No corporate filler,
no robotic status-speak. Keep it conversational.

**Example phrasings** (vary these rather than repeating the same line every time):

1. **Infra/server check**: "On it — let me go check, back in a sec 👀"
2. **Coding/review**: "Let me look through the code — gimme a moment ⏳"
3. **Research/synthesis**: "Let me dig into that and pull together what I find 🔍"
4. **General/slow task**: "Looking this up now — won't be long 🙏"
5. **Assignment/essay**: "Got it, working on a draft — I'll share it soon 🖊️"

The delivery mechanism (unchanged from the earlier ack-first rule):

```
Hook: POST /hooks/agent
Body: { "message": "reply with exactly: <pick the relevant phrasing from above, adjust slightly to context>", "deliver": true, "channel": "whatsapp", "to": "<sender-number>" }
```

Then spawn the subagent and `sessions_yield`. The subagent's return arrives as the next
message — relay its answer.

**When the subagent fails** (completion Status: `failed`, `timed out`, or `unknown`):

1. **Silent retry**: If the specialist lists a fallback model and the primary failed,
   retry once with the fallback — a second `sessions_spawn` + `sessions_yield` loop
   without sending another ack.
2. **If the fallback also fails or no fallback exists**: Send a short honest follow-up:
   *"That didn't go through — want me to try again?"* or similar. **Never leave an acked
   message unanswered.** The user got "on it" and then heard nothing — close that loop.

---

## Cluster 1: Coding & Dev

Three specialists share this cluster — domain overlap is high, so disambiguate carefully
(see the "ambiguitity" note at the end of each entry and the [No match](#no-match--ambiguous-intent)
section for guidance).

> **Flat design note**: The independent spawning of each coding specialist directly by the main dispatcher (rather than through a nested orchestrator) is a deliberate architecture decision — see the "DECIDED: Coding cluster stays flat" section in [PROGRESS.md](./PROGRESS.md) for the full rationale.

### code-review

**Delegate when**: user asks for a code review, PR review, feedback on code quality, or
asks "can you look at this code?" with an attached snippet. Example phrases:
- "review this code"
- "can you check my PR"
- "does this look right" *(with code attached)*
- "give me feedback on this function"

**Do NOT delegate when**: user is reporting a specific error/stack trace (that's
debug/triage) or asking to build something from scratch (that's app-dev). If a message is
code-adjacent but ambiguous with another coding specialist, see disambiguation in
[No match](#no-match--ambiguous-intent).

```
sessions_spawn(
  task: "You are a code-review specialist. Review the code the user provided. Give structured feedback: correctness, edge cases, style, performance. The user's message was: <insert verbatim user message>",
  model: "9router/kr/qwen3-coder-next",
  label: "code-review",
  taskName: "code_review"
)
```
If that fails, retry with model: `9router/ollama/gpt-oss:120b`, then `9router/oc/deepseek-v4-flash-free`, then `9router/cc/claude-sonnet-5`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### debug-triage

**Delegate when**: user reports a bug, error, crash, unexpected behaviour, stack trace,
or asks "why is X not working". Example phrases:
- "I'm getting this error"
- "this isn't working"
- "debug this"
- "why is it failing"
- *any message containing a stack trace or error log*

**Do NOT delegate when**: user wants general code feedback without a specific error
(that's code-review), or wants a new feature built (that's app-dev).

```
sessions_spawn(
  task: "You are a debug/triage specialist. The user has an error or unexpected behaviour. Reproduce, identify root cause, and suggest a fix. The user's message was: <insert verbatim user message>",
  model: "9router/kr/qwen3-coder-next",
  label: "debug-triage",
  taskName: "debug_triage"
)
```
If that fails, retry with model: `9router/ollama/gpt-oss:120b`, then `9router/oc/deepseek-v4-flash-free`, then `9router/cc/claude-sonnet-5`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### app-dev

**Delegate when**: user wants something built from scratch — a new feature, project,
script, or app. Example phrases:
- "build me a..."
- "create an app that..."
- "I need a script to..."
- "make a tool that..."

**Do NOT delegate when**: user is reporting a bug (debug-triage) or asking for a review
of existing code (code-review).

```
sessions_spawn(
  task: "You are an app-development specialist. Build the requested feature/script/app. Prioritise correctness, complete implementation, and clear documentation. The user's message was: <insert verbatim user message>",
  model: "9router/kr/qwen3-coder-next",
  label: "app-dev",
  taskName: "app_dev"
)
```
If that fails, retry with model: `9router/ollama/gpt-oss:120b`, then `9router/oc/deepseek-v4-flash-free`, then `9router/cc/claude-sonnet-5`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

## Cluster 2: Business Analytics

### seo-research

**Delegate when**: user asks about SEO, search rankings, keyword research, backlinks,
site optimisation for search engines. Example phrases:
- "check our SEO"
- "keyword research for..."
- "how is X ranking"
- "SEO audit for..."

```
sessions_spawn(
  task: "You are an SEO research specialist. Analyse search rankings, keywords, backlinks, or site SEO as requested. Use any available web search or API tools. The user's message was: <insert verbatim user message>",
  model: "9router/kr/glm-5",
  label: "seo-research",
  taskName: "seo_research"
)
```
If that fails, retry with model: `9router/gemini/gemini-3.6-flash`, then `9router/oc/deepseek-v4-flash-free`, then `9router/cc/claude-haiku-4-5-20251001`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### metrics-reporting

**Delegate when**: user asks for a report, metrics, dashboard data, numbers about
business performance. Example phrases:
- "give me this week's metrics"
- "how are we performing this month"
- "report on X"
- "show me the numbers"

```
sessions_spawn(
  task: "You are a metrics reporting specialist. Compile and present the requested metrics or report. The user's message was: <insert verbatim user message>",
  model: "9router/kr/glm-5",
  label: "metrics-reporting",
  taskName: "metrics_reporting"
)
```
If that fails, retry with model: `9router/gemini/gemini-3.6-flash`, then `9router/oc/deepseek-v4-flash-free`, then `9router/cc/claude-haiku-4-5-20251001`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### competitive-watcher

**Delegate when**: user asks about competitors, industry landscape, competitive
intelligence. Example phrases:
- "what are competitors doing"
- "check on competitor X"
- "competitive analysis for..."
- "how does X compare to Y"

```
sessions_spawn(
  task: "You are a competitive intelligence specialist. Research the competitor(s) or market landscape the user asked about. The user's message was: <insert verbatim user message>",
  model: "9router/kr/glm-5",
  label: "competitive-watcher",
  taskName: "competitive_watcher"
)
```
If that fails, retry with model: `9router/gemini/gemini-3.6-flash`, then `9router/oc/deepseek-v4-flash-free`, then `9router/cc/claude-haiku-4-5-20251001`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### cost-tracking

**Delegate when**: user asks about billing, invoices, costs, spending, or budget. This
includes Vultr billing and (future) Hostinger/service costs. Example phrases:
- "how much did we spend this month"
- "check my Vultr bill"
- "what's our current balance"
- "cost report"
- "billing summary"

> **Distinction from infra-watcher**: cost-tracking is purely about *invoices/billing*
> (dollars spent, balance, invoice history). If the user asks about *server health or
> resource usage* (CPU%, disk, uptime) even in a cost-adjacent way ("which server is
> costing me the most"), route to [infra-watcher](#infra-watcher-on-demand-mode) instead.

```
sessions_spawn(
  task: "You are a cost-tracking specialist. Check billing/invoice data as requested (Vultr billing API, etc.) and answer the user's cost question. The user's message was: <insert verbatim user message>",
  model: "9router/kr/glm-5",
  label: "cost-tracking",
  taskName: "cost_tracking"
)
```
If that fails, retry with model: `9router/gemini/gemini-3.6-flash`, then `9router/oc/deepseek-v4-flash-free`, then `9router/cc/claude-haiku-4-5-20251001`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

## Cluster 3: Study

### research-assistant

**Delegate when**: user asks a research question — needing to gather, synthesise, or
summarise information from web sources. Example phrases:
- "research X"
- "what does the literature say about..."
- "find information on..."
- "summarise the latest on..."

```
sessions_spawn(
  task: "You are a research assistant. Gather and synthesise information on the requested topic from web sources. Cite sources. The user's message was: <insert verbatim user message>",
  model: "9router/gemini/gemini-3.6-flash",
  label: "research-assistant",
  taskName: "research_assistant"
)
```
If that fails, retry with model: `9router/kr/deepseek-3.2`, then `9router/cc/claude-sonnet-5`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### study-scheduler

**Delegate when**: user asks about study planning, scheduling, creating a study
timetable, or organising study sessions. Example phrases:
- "make a study schedule"
- "plan my study time"
- "study timetable for..."
- "when should I study X"

```
sessions_spawn(
  task: "You are a study scheduler. Create or adjust a study plan/timetable based on the user's request. The user's message was: <insert verbatim user message>",
  model: "9router/gemini/gemini-3.6-flash",
  label: "study-scheduler",
  taskName: "study_scheduler"
)
```
If that fails, retry with model: `9router/kr/deepseek-3.2`, then `9router/cc/claude-sonnet-5`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### assignment-drafting

**Delegate when**: user asks to draft, write, or polish an assignment, essay, or
submission. Example phrases:
- "draft an assignment on..."
- "write an essay about..."
- "help me with my assignment"
- "can you write this for me"

> **⚠️ Approval gate**: This specialist produces text intended for submission. The
> task should instruct the subagent to produce a draft *and* flag any content that
> the user must verify/fact-check before submission. The main agent should then
> relay the draft and add a clear warning: *"This is a draft — review it carefully
> before submitting. I haven't verified every fact/claim."*

```
sessions_spawn(
  task: "You are an assignment-drafting specialist. Draft/revise the assignment text the user requested. Include a note at the end listing any claims, figures, or facts the user should independently verify before submission. The user's message was: <insert verbatim user message>",
  model: "9router/kr/claude-sonnet-4.5",
  label: "assignment-drafting",
  taskName: "assignment_drafting"
)
```
If that fails, retry with model: `9router/cc/claude-sonnet-5`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

## Cluster 4: Infra / Hosting / Domain (On-Demand Mode)

### infra-watcher (on-demand)

**Delegate when**: user asks about server status, VPS metrics, Vultr, Hostinger,
WordPress hosting, cPanel, domain expiry, or any hosting/infrastructure question.
Watchers (CI, pipeline-qa) are NOT routed here — see [Pure cron watchers](#pure-cron-watchers-ci-watcher--pipeline-qa).

Example phrases (from the existing AGENTS.md entry):
- "check my servers"
- "cek server"
- "CPU% of X"
- "closest expiring domain"
- "semua server aman?"
- "what's the status of..."
- "vultr bill" *(if purely cost-related, consider cost-tracking instead — see note below)*
- "which vultr instances"
- "is the site down?"
- *any message mentioning: server, VPS, domain, hosting, cPanel, uptime, disk, cpu, ram*

**Distinction from cost-tracking**: If the user is asking about *dollars spent* (billing,
invoices, balance), route to [cost-tracking](#cost-tracking) under Business Analytics.
If the user is asking about *server resources or status* (CPU%, disk, uptime, instance
list), even if dollars are mentioned tangentially, route here.

**Distinction from infra-ops (root-cause diagnosis)**: infra-watcher reports *status*
only (CPU%, disk%, uptime, instance list) — it has no process list, container/service
logs, or `top`/`docker stats` access. If the user asks *why* something is happening —
"what's causing high CPU", "why is X slow", "what's eating memory on Y" — that's a
root-cause question, not a status check. infra-watcher will (correctly) say it can't
answer; route those to [infra-ops](#infra-ops-approval-gated) instead, which has
read-only diagnostic verbs (`procs`, `docker-ps`, `docker-logs`, `service-status`,
`service-logs`, `compose-ps`) for exactly this.

```
sessions_spawn(
  task: "Read /Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents/watchers/infra-watcher/AGENT.md, then answer this question using only what it describes: <insert verbatim user message>",
  model: "9router/kr/claude-haiku-4.5",
  label: "infra-watcher",
  taskName: "infra_watcher_on_demand"
)
```
If that fails, retry with model: `9router/oc/deepseek-v4-flash-free`, then `9router/cc/claude-haiku-4-5-20251001`.

> **Ack**: yes — send ack before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

> **Canonical delegation rule**: The live main OpenClaw agent reads the
> delegation rule from `/Users/alandani/.openclaw/workspace/AGENTS.md` every turn.
> This ROUTING.md entry is a repo-local copy for reference and should be kept in
> sync if `watchers/infra-watcher/AGENT.md`'s scope or the spawn parameters change.

---

## Approval-Gated Agents

These agents can *act* on your infrastructure or send external communications — they
are **not** read-only. Do NOT delegate to them without explicit user confirmation.

> **Status note**: `infra-ops`, `dns-edge`, and `app-platform` are all real
> `agents.list[]` entries in `openclaw.json` with their own tool scoping (restricted
> MCP/SSH tool sets) and access controls — the safety boundary for those three comes
> from OpenClaw's agent-level tool scoping, not from this routing table. `invoicing`
> is not yet a registered agent; its `sessions_spawn` routing below is still the
> temporary bridge described in the original architecture review. For all four, the
> main agent **must** get explicit user sign-off before delegating.

### infra-ops (approval-gated)

**Status**: ✅ Deployed — `agents.list[]` entry applied to `openclaw.json` and live.
Use `agentId: "infra-ops"` for direct agent delegation.

Can restart services, run migrations, diagnose deeper than the read-only watcher
(process lists, container/service logs), apply fixes. Two flavors below —
**diagnosis needs an ack, not a confirmation gate; mutation needs both.**

**Trigger phrase A — read-only diagnosis** (infra-ops's Category A verbs:
`procs`, `docker-ps`, `docker-logs`, `service-status`, `service-logs`,
`compose-ps`, `uptime` — none of these can change anything, enforced
server-side by `ops-check.sh`). Route here when infra-watcher can't answer a
"why"/root-cause question. Example phrases:
- "what's causing high CPU on X"
- "why is X slow"
- "what process is eating memory on Y"
- "show me the logs for Z"
- "is nginx even running"

**Trigger phrase B — mutating actions** (Category B: writes, restarts, anything
that changes server state). Example phrases:
- "restart nginx"
- "deploy the latest build"
- "fix the DB connection"
- "run the migration"
- "reboot the server"
- "update WordPress"

**The main agent's pre-delegation flow**:
- **Flavor A (diagnosis)**: no confirmation gate — it's read-only, same trust
  level as infra-watcher. Ack ("On it, digging into X — back in a sec"), then
  delegate immediately.
- **Flavor B (mutation)**:
  1. Send a warning: *"I can look into this, but infra-ops can make changes to your servers. Do you want me to proceed?"*
  2. Wait for explicit "yes" (or equivalent confirmation).
  3. If confirmed, proceed with the delegate-and-ack flow below.
  4. If declined or ambiguous, answer what you can without acting (read-only).
- **Ambiguous / mixed request** ("check the DB connection and fix it if it's
  broken"): treat as Flavor B — the confirmation gate is about what the
  request *could* trigger, not just its first step.

```
sessions_spawn(
  agentId: "infra-ops",
  task: "<insert verbatim user message>"
)
```
Model chain: `kr/claude-sonnet-4.5` → `oc/deepseek-v4-flash-free` → `cc/claude-sonnet-5` (configured in `agents.list[].infra-ops.model` in openclaw.json — not repeated here since it can drift; check the live config, not this file, if precision matters).

> **Ack**: yes — send ack after user confirms, before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### dns-edge (approval-gated)

**Status**: ✅ Deployed — `agents.list[]` entry applied to `openclaw.json` and live.
Use `agentId: "dns-edge"` for direct agent delegation. Not yet exercised with a real
user request.

Mutating counterpart to infra-watcher's read-only DNS/domain lookups. Acts on
Cloudflare only (DNS record CRUD, SSL/TLS mode, zone info) via the `cloudflare`
MCP server's code-mode tools. Every mutation requires a `yes`/`no` confirmation
gate — see `ops/dns-edge/AGENT.md` for the exact propose/confirm wording.

**Trigger phrase — read-only DNS/domain questions**: do NOT route here. These go to
[infra-watcher](#infra-watcher-on-demand-mode) instead. Examples:
- "what's the DNS status for X"
- "list all DNS records for Z zone"
- "when does my domain expire"
- "what's the SSL mode for this zone"

**Trigger phrase — DNS/SSL/edge mutations**: route here. Examples:
- "add an A record for X pointing to Y"
- "update the CNAME for X to Y"
- "change SSL mode from flexible to full"
- "delete the old TXT record for X"

**The main agent's pre-delegation flow**:
1. Send a warning: *"I can do that via dns-edge — it will change [record/setting] on [zone]. Do you want me to proceed?"*
2. Wait for explicit "yes" (or equivalent confirmation).
3. If confirmed, proceed with the delegate-and-ack flow below.
4. If declined or ambiguous, do not proceed — answer what you can from cached/read-only info instead.

```
sessions_spawn(
  agentId: "dns-edge",
  task: "<insert verbatim user message>"
)
```
Model: `9router/Infra-Ops` (configured in `agents.list[].dns-edge.model` in openclaw.json — not repeated here since it can drift; check the live config, not this file, if precision matters).

> **Ack**: yes — send ack after user confirms, before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

**Cross-agent note**: dns-edge never calls app-platform and vice versa. If a request
needs both (e.g. "add a custom domain to my Vercel project" = a CNAME record *and*
a Vercel domain-add), the main agent orchestrates it as two separate spawns —
dns-edge first, then app-platform — each with its own confirmation gate.

---

### app-platform (approval-gated)

**Status**: ✅ Deployed — `agents.list[]` entry applied to `openclaw.json` and live.
Use `agentId: "app-platform"` for direct agent delegation. `~/.openclaw/secrets/app_platform_projects.json`
still only has the placeholder `example-project` entry — no real project has been
wired in, so treat the first real request as untested until it's confirmed working.

Mutating agent for the application lifecycle: Supabase (DB, migrations, RLS, edge
functions, branches) via MCP, and Vercel (deploys, env vars, domains) via `exec`
(Vercel CLI / REST API — Vercel's own MCP is remote-OAuth-only and incompatible
with unattended spawning). Every mutation requires a `yes`/`no` confirmation gate —
see `ops/app-platform/AGENT.md` for the exact propose/confirm wording.

**Trigger phrase**: Supabase or Vercel app-lifecycle mutations. Examples:
- "apply the pending migrations"
- "deploy this to production" / "trigger a Vercel deploy"
- "set the env var X on Vercel"
- "deploy the edge function"
- "merge/create a Supabase branch"

**Distinction from infra-ops**: infra-ops is host-level (SSH, service restarts,
server config). app-platform is application-level (DB schema, deploy pipeline,
env vars). A request needing both (e.g. "deploy the new version and restart the
nginx container") should spawn **both** agents, not one trying to do everything.

**The main agent's pre-delegation flow**:
1. Send a warning: *"I can do that via app-platform — it will [migrate/deploy/change env var] on [supabase/vercel]. Do you want me to proceed?"*
2. Wait for explicit "yes" (or equivalent confirmation).
3. If confirmed, proceed with the delegate-and-ack flow below.
4. If declined or ambiguous, do not proceed.

```
sessions_spawn(
  agentId: "app-platform",
  task: "<insert verbatim user message>"
)
```
Model: `9router/Infra-Ops` (configured in `agents.list[].app-platform.model` in openclaw.json — not repeated here since it can drift; check the live config, not this file, if precision matters).

> **Ack**: yes — send ack after user confirms, before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

### invoicing (approval-gated)

**Delegate only after explicit user confirmation**. Can create, send, or modify
invoices — client-facing, financial impact.

**Trigger phrase**: user asks to generate, send, or manage invoices. Example phrases:
- "send an invoice to X"
- "create an invoice for Y"
- "update invoice #..."
- "remind client about payment"

**The main agent's pre-delegation flow**:
1. Summarise what will be sent: *"I can draft/send an invoice for [amount] to [client]. Do you want me to proceed?"*
2. Wait for explicit "yes" (or equivalent confirmation).
3. If confirmed, proceed with the delegate-and-ack flow below.
4. If declined or ambiguous, do not proceed.

```
sessions_spawn(
  task: "You are an invoicing specialist. Handle the user's invoicing request — draft, send, or update invoices as appropriate. The user's message was: <insert verbatim user message>",
  model: "9router/cc/claude-opus-5",
  label: "invoicing",
  taskName: "invoicing"
)
```
If that fails, retry with model: `9router/cc/claude-sonnet-5`.

> **Ack**: yes — send ack after user confirms, before spawning (see [Acknowledgment & Failure Handling](#acknowledgment--failure-handling) above).

---

## Pure Cron Watchers (CI Watcher & Pipeline QA)

These two are **not** part of this on-demand routing table. They run exclusively via
OpenClaw-native cron (per the "Cron job patterns for watchers" section in PROGRESS.md)
and only interact with WhatsApp through cron's `--announce` delivery mechanism. They:

- Never receive on-demand questions from this dispatcher.
- Never use `sessions_spawn` routing.
- Fire only on their cron schedule (ci-watcher: every 15 min trigger.script;
  pipeline-qa: every 15 min trigger.script).
- Announce anomalies directly to WhatsApp via the cron job's `--announce --channel whatsapp` flags.

If a user asks "check my CI status" or "is the pipeline green?", answer what you can from
prior cron announcements in your session history (or tell them the next cron check will
pick it up), but do **not** attempt to spawn a subagent for ci-watcher or pipeline-qa.

**Infra watcher** is the exception — it has both a daily cron job *and* an on-demand
routing entry (see [infra-watcher (on-demand)](#infra-watcher-on-demand-mode) above).
Do not extend this exception to the other two watchers.

---

## No Match / Ambiguous Intent

If you've read all sections above and the message doesn't clearly match any specialist:

1. **Answer directly** using your own capabilities (Orchestrator model:
   `9router/kr/claude-haiku-4.5`). This covers routine questions, quick lookups,
   status checks, and conversation.
2. **If genuinely ambiguous**, ask **one** short clarifying question — don't guess the
   intent and don't spawn a subagent speculatively. Keep follow-ups minimal; if the
   user is still unclear after one round, answer what you can directly.

### Common ambiguity patterns

| Message | Could be... | Clarifying question |
|---|---|---|
| *"Can you look at this code?"* | **code-review** (general feedback) vs **debug-triage** (specific error) | *"Is there a specific error/bug, or do you want general code feedback?"* |
| *"Check my servers"* | **infra-watcher** (health/resources) vs **cost-tracking** (billing) | *"Server health/resources or billing/costs?"* |
| *"Build a website"* | **app-dev** (from scratch) vs **assignment-drafting** (academic submission) | *"Is this a project/feature to build, or an assignment to write?"* |
| *"How's my site doing?"* | **metrics-reporting** (traffic/KPIs) vs **infra-watcher** (uptime/resources) | *"Business metrics (traffic, conversions) or technical health (uptime, performance)?"* |
| *"Fix the server"* | **infra-watcher** (read-only check) vs **infra-ops** (will act) | ⚠️ *"What's wrong? I can check read-only status first, or if you need me to make changes, I'll need your explicit go-ahead."* |

### Hard rule

Never spawn a subagent speculatively ("I think this might be a coding question so I'll
send it to the coding subagent and see what happens"). If unsure, answer directly or
ask one clarifying question — never delegate uncertainty.
