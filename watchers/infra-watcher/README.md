# Infra Watcher

MCP-first, natural-language Q&A agent. OpenClaw answers infra questions (e.g.
"what's CPU% of ulak server", "which instance has low disk space") by calling
read-only tools directly rather than following a fixed workflow branch. Full
architecture and rationale live in [CLAUDE.md](../../CLAUDE.md) under
"Infra watcher — RESET, MCP-first architecture" — this file only covers
what's specific to this folder.

READ-ONLY. This agent never reboots, deletes, or modifies anything. Any agent
that acts on servers is a separate, not-yet-built agent (infra-ops).

## What lives here

All four integration points are built and live. Full operating detail
(tool names, thresholds, when to use which) is in [AGENT.md](AGENT.md) —
this README only covers what's in the folder:
- **Vultr MCP** (community server) — connected, read-only, 145 tools
  (billing, DNS, firewall, etc.). Instance list/status has no MCP tool in
  this package version, so `vultr-status.mjs` calls the API directly instead.
- **Hostinger MCP** (official) — connected, read-only, 50 tools (VPS metrics,
  hosting, WordPress, mail).
- **WHOIS lookup** — `domain-check.mjs`, provider-agnostic, reads
  `domains.json` at the repo root.
- **SSH** (read-only, forced-command restricted) — deployed and verified on
  all 5 servers via `remote/deploy-all.sh`; see `remote/DEPLOYMENT.md` for
  the deploy/verify tooling and `remote/readonly-check.sh` for the restricted
  remote-side script.

Both MCP servers are configured on the Mac Mini (OpenClaw's MCP server
config), not in this repo.

## Files

| File | Purpose |
|---|---|
| `AGENT.md` | Full operating instructions for the agent (tool names, thresholds, daily digest logic) |
| `daily-digest.mjs` | Runs once a day via the `infra-watcher-daily` cron job, produces one combined WhatsApp summary |
| `domain-check.mjs` | WHOIS-based domain expiry check across `domains.json` |
| `vultr-status.mjs` | Vultr instance list/status (API fallback, no MCP tool for this) |
| `test-threshold.mjs`, `production-test.mjs` | Test scripts |
| `remote/` | SSH key deployment + verification tooling, and the restricted remote-side script |

## Example questions this agent should answer

- "What's the CPU percentage of [server]?" → Hostinger MCP if on Hostinger; SSH if on Vultr
- "Tell me the closest expiring domain" → WHOIS lookup across `domains.json`
- "Which instance is active in Vultr?" → Vultr MCP, read-only instance list
- "Which instance has low disk space?" → Hostinger MCP (direct) or SSH (Vultr instances)

## Safety

Both Vultr MCP and Hostinger MCP can also write/act (reboot, delete, modify
DNS) — this agent must only ever be given the read-only tools from each, via
either scoped tool exposure or a read-only API key. No destructive capability
reaches this agent under any circumstance.
