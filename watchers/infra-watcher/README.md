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

Currently just this README. The actual integration points are:
- **Vultr MCP** (community server) and **Hostinger MCP** (official) — connected
  directly to OpenClaw, scoped read-only. Configured on the Mac Mini
  (OpenClaw's MCP server config), not in this repo.
- **WHOIS lookup** — for domain expiry, provider-agnostic.
- **SSH** (read-only commands only) — for cPanel checks and Vultr resource %,
  per-instance, keyed off `instances.json` (gitignored; see
  `instances.example.json` at repo root).

As pieces get built (Vultr MCP connected, Hostinger MCP connected, WHOIS
capability, SSH wiring) they'll land here as config/docs specific to this
agent. See CLAUDE.md's "Current status / next steps" for the build order.

## Example questions this agent should answer

- "What's the CPU percentage of [server]?" → Hostinger MCP if on Hostinger; SSH if on Vultr
- "Tell me the closest expiring domain" → WHOIS lookup across `domains_to_watch.json`
- "Which instance is active in Vultr?" → Vultr MCP, read-only instance list
- "Which instance has low disk space?" → Hostinger MCP (direct) or SSH (Vultr instances)

## Safety

Both Vultr MCP and Hostinger MCP can also write/act (reboot, delete, modify
DNS) — this agent must only ever be given the read-only tools from each, via
either scoped tool exposure or a read-only API key. No destructive capability
reaches this agent under any circumstance.
