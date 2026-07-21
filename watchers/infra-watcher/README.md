# Infra Watcher

Read-only infrastructure monitoring. Runs daily via n8n cron, stays **silent unless
something is wrong**, and supports on-demand checks. All alerting goes to WhatsApp
through the OpenClaw `/hooks/agent` relay as **one combined message** per run
(🔴 critical / 🟡 warning, critical lines first).

## What it checks

| Target | How | Checks |
|---|---|---|
| Vultr instances | API `GET /v2/instances` | reachability (`power_status`), locked state |
| Vultr CPU/RAM/disk | SSH (`df`/`free`/`top`) | >90% thresholds (Vultr API doesn't expose utilization) |
| Hostinger VPS | API `GET /api/vps/v1/virtual-machines` + `/{id}/metrics` | state + CPU/RAM/disk %, no SSH needed |
| Hostinger domains | API `GET /api/domains/v1/portfolio` | ALL domains in the account, expiry tiers 30/14/7 days |
| DomaiNesia / any cPanel host | SSH (static host from `instances.json`) | CPU/RAM/disk, /home quota, backup freshness (48h), plus SSL |
| SSL certificates | TLS probe on port 443 (no SSH needed) | expiry tiers 30/14/7 days, per `ssl_domains` in `instances.json` |

Failed checks (API down, SSH refused, unresolvable host) surface as 🟡 warnings —
the watcher never fails silently.

## Files

```
bin/infra-check.mjs   # all check + threshold + message logic (Node ≥18, zero deps)
workflow.json         # importable n8n workflow (cron + on-demand webhook)
test/run-tests.mjs    # fixture-driven test suite: node test/run-tests.mjs
test/fixtures.json    # demo fixture with forced breaches (see below)
```

## Setup on the n8n server

1. Clone this repo (the workflow assumes `/opt/openclaw-multi-agents` — edit the two
   Execute Command nodes if it lives elsewhere), install Node 18+.
2. Create `.env` and `instances.json` at the repo root (copy the `.example` files).
   Hosts for Vultr/Hostinger entries are resolved from the provider APIs by
   `instance_id`; DomaiNesia entries need a static `host` (no list API exists).
3. Test each SSH key manually first: `ssh -i <key> user@host`.
4. Dry-run from the shell before wiring into n8n:
   ```sh
   node watchers/infra-watcher/bin/infra-check.mjs --verbose        # human output
   node watchers/infra-watcher/bin/infra-check.mjs --json           # what n8n sees
   node watchers/infra-watcher/bin/infra-check.mjs --json --send    # actually alerts
   ```
5. Import `workflow.json` into n8n, activate. Cron fires daily at 08:00 server time.

## On-demand path

OpenClaw (or anything else) triggers an immediate check by calling the webhook:

```sh
curl -X POST https://<n8n-host>/webhook/infra-watcher
```

The on-demand run always sends a WhatsApp reply — `✅ all checks passed (...)` when
healthy — and returns the full JSON result to the webhook caller. The cron run sends
nothing when everything is healthy.

## Demo / test

```sh
node test/run-tests.mjs                                  # 11 scenario tests
node bin/infra-check.mjs --mock test/fixtures.json       # forced-breach demo message
```

## Design notes

- **The script does the POST to OpenClaw** (`--send`) instead of a separate n8n HTTP
  node. Same plumbing, fewer moving parts: n8n contributes scheduling, the webhook,
  and execution; all check/threshold/format logic is in one testable script. Still
  zero LLM cost — the hooks `message` is wrapped in "reply with exactly this text and
  nothing else:" to force verbatim relay.
- The Hostinger **metrics response shape** (`cpu_usage`/`ram_usage`/`disk_space` maps)
  is parsed defensively; if the real API returns a different shape, the watcher emits
  a 🟡 "could not read metrics" warning rather than crashing — fix `latestMetric()` /
  field names in `checkHostingerVms()` when confirming against the live account.
- Backup freshness = any file under `backup_path` (default `/backup`) modified in the
  last 48h. Point `backup_path` at wherever your cPanel backups actually land.
- Exit code is 0 whether or not issues were found (result is in the JSON); 2 means
  fatal config error (no API keys at all).
