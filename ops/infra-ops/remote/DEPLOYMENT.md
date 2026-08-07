# Infra-Ops SSH Key Deployment

Automated deployment of the infra-ops SSH key to all servers listed in `instances.json`.

## What This Does

Deploys a **full-access SSH key** to all your servers that:
- Can execute any command (no restrictions yet — confirmation gate is enforced at the agent level in AGENT.md)
- Works non-interactively (no password prompts)
- Enables infra-ops agent to perform infrastructure actions (restarts, deployments, etc.)

## Files

| File | Purpose |
|------|---------|
| `deploy-all.sh` | Deploys to all servers, and (`--verify-only`) verifies them too |
| `DEPLOYMENT.md` | This file |

## Quick Start

```bash
# Deploy to all servers
cd /Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents/ops/infra-ops/remote
./deploy-all.sh

# Verify deployment worked (no changes made)
./deploy-all.sh --verify-only
```

## Detailed Usage

### deploy-all.sh

```bash
# Deploy to all servers
./deploy-all.sh

# Deploy but skip servers that already have the key
./deploy-all.sh --skip-deployed

# Dry-run mode (shows what would happen, doesn't deploy)
./deploy-all.sh --verify-only

# Interactive password bootstrap — ssh prompts you directly at the terminal,
# once per server; the script never sees, stores, or passes the password
./deploy-all.sh --password

# Use a specific key for bootstrap
./deploy-all.sh --key ~/.ssh/my-bootstrap-key
```

**What happens per server:**
1. Ensures `~/.ssh` directory exists with correct permissions
2. Adds the infra-ops public key to `/root/.ssh/authorized_keys` (idempotent)
3. Sets correct permissions on authorized_keys (600)
4. Verifies the key works by connecting and running a test command

**Output colors:**
- 🟢 Green = Success
- 🔴 Red = Failed
- 🟡 Yellow = Skipped or warning

## Prerequisites

Your local system must have:
- SSH key at `~/.ssh/infra_ops_ed25519` (private key)
- `jq` installed (`brew install jq` on macOS)
- SSH access to all servers in `instances.json` via existing key or password

## Which Servers Get Deployed To

The script reads `instances.json` at the repo root and attempts to deploy to **all servers** that don't already have the infra-ops key working.

Bootstrap access priority:
1. Existing ops_ssh_key_path (if already deployed)
2. Existing ssh_key_path (infra-watcher key)
3. Keys passed via `--key` flag
4. `~/.ssh/id_ed25519`, `~/.ssh/id_rsa`
5. Root password (only with `--password` flag)

## Security Model

**Full-access key (no forced-command restriction):**

```bash
# This is what gets added to authorized_keys (just the plain key)
ssh-ed25519 AAAA... infra-ops@mac-mini
```

**Important**: This key has NO SSH-level restrictions. The safety boundary is:
- **Agent-level**: infra-ops AGENT.md implements the confirmation gate and command allowlist
- **Model-level**: OpenClaw's tool scoping restricts what the agent can call
- **Self-discipline**: The agent is responsible for following the allowlist

If you want SSH-level enforcement (recommended for production), deploy a forced-command wrapper similar to infra-watcher's `readonly-check.sh` that enforces the allowlist at the server level. That's a future hardening step.

## Troubleshooting

### "Permission denied" during deployment
- The initial SSH access requires an existing working key or password
- Make sure you can SSH to the server manually first: `ssh root@<ip>` or `ssh -i ~/.ssh/infra_watcher_ed25519 root@<ip>`

### Deploy fails midway through
- Check which step failed (1/3, 2/3, 3/3)
- Re-run `./deploy-all.sh --skip-deployed` to retry failed servers
- Manually check the server state if needed

### "jq: command not found"
- Install jq: `brew install jq` (macOS) or `apt-get install jq` (Linux)

### "no existing SSH access to this server"
- Use `--password` flag and provide root password: `./deploy-all.sh --password`
- Or manually add your public key to the server first via Vultr web console
- Or use `--key ~/.ssh/your-existing-key` if you have another key that works

## Manual Steps (if needed)

If the script fails and you need to deploy manually to one server:

```bash
# 1. Ensure ~/.ssh exists
ssh root@<ip> mkdir -p ~/.ssh && chmod 700 ~/.ssh

# 2. Add infra-ops key
ssh root@<ip> 'cat >> ~/.ssh/authorized_keys' < ~/.ssh/infra_ops_ed25519.pub

# 3. Fix permissions
ssh root@<ip> chmod 600 ~/.ssh/authorized_keys

# 4. Test
ssh -i ~/.ssh/infra_ops_ed25519 root@<ip> "echo test"
```

## After Deployment

The infra-ops key is deployed and verified on all 6 servers (GRADIEN, SIGAP
GERINDRA, ULAK WAYKANAN, ULAK-NEW, ERP BUMIADIL, HAMS ERP31):

1. The infra-ops agent can perform actions on all of them
2. All actions still require explicit user confirmation (confirmation gate in AGENT.md)
3. Actions are logged and reported back to the user
4. Run `./deploy-all.sh --verify-only` regularly to ensure all keys are still working

## Integration with infra-watcher

Both infra-watcher and infra-ops keys can coexist on the same server:

- **infra-watcher key**: Read-only, forced-command restricted, used for monitoring
- **infra-ops key**: Full-access, used for actions (with confirmation gate in agent)

This provides defense-in-depth: if one key is compromised, the other is still scoped to its intended use.

## Forced-command wrapper (built, toggleable per server)

`remote/ops-check.sh` is a forced-command wrapper for SSH-level enforcement,
built the same way as infra-watcher's `readonly-check.sh` — arguments are
split via plain word-splitting (never `eval`/`sh -c`) and validated against
a strict charset before being passed as real argv elements, so injection
isn't possible regardless of input. It covers `AGENT.md` Category A
(read-only) and the Category B restart/reload actions. Categories C–F
(deploy, database/WordPress, package install, file transfer) aren't
implemented in the wrapper — turning it on for a server hard-blocks those
at the SSH layer for that server, so it's toggled per server as needed
rather than applied everywhere permanently.

**Current live status is tracked in `instances.json`**, per server, in each
entry's `_ops_note` field (that file is gitignored — real state, not
committed — so it's the actual source of truth, not this doc). As of
2026-08-07: SIGAP GERINDRA, ERP BUMIADIL, and HAMS ERP31 are restricted;
ULAK WAYKANAN, ULAK-NEW, and GRADIEN are full-access (left open to support
the ULAK -> ULAK-NEW migration that weekend). Don't trust a stale copy of
this status in your head — check `instances.json` or run the probe below.

Toggle with `shared/sync-forced-command.mjs` (repo root), which replaces
the same key's `authorized_keys` line either way — safe to switch back and
forth as needed:

```bash
# Turn ON — restrict the key to ops-check.sh's allowlist
node shared/sync-forced-command.mjs \
  --script ops/infra-ops/remote/ops-check.sh \
  --pubkey ~/.ssh/infra_ops_ed25519.pub \
  --remote-path /opt/infra-ops/ops-check.sh \
  --key-comment infra-ops@mac-mini \
  --only "<server name>"

# Turn OFF — revert to full access
node shared/sync-forced-command.mjs \
  --pubkey ~/.ssh/infra_ops_ed25519.pub \
  --key-comment infra-ops@mac-mini \
  --unrestricted \
  --only "<server name>"
```

Add `--dry-run` to preview either command first. Drop `--only` to target
all 6 at once. After toggling, update that server's `_ops_note` in
`instances.json` to match — it's manual, nothing keeps it in sync
automatically.

**Quick live probe** (bypasses whatever `instances.json` currently says):

```bash
ssh -i ~/.ssh/infra_ops_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes \
  -o ConnectTimeout=6 root@<ip> "echo probe"
# "probe" back  -> full access
# "rejected: ..." back -> restricted
```

### Gotcha: a restricted key can't unrestrict itself

If `ops-check.sh` is already on for a server, running the `--unrestricted`
command above will fail — the tool needs to run a plain shell command to
edit `authorized_keys`, and the restricted key rejects that command the
same as it would reject anything else outside its allowlist. This is
correct behavior, not a bug, but it means recovery needs a *different*
credential:

- If another unrestricted key exists on that server (e.g. a bootstrap key),
  use `-i` with `-o IdentitiesOnly=yes` to force `sync-forced-command.mjs`'s
  underlying `ssh` calls to use it instead of whatever `ssh-agent` offers.
- Otherwise, fall back to the root password directly:
  `ssh -o PubkeyAuthentication=no root@<ip>` (add this flag even if you
  think no key would match — `ssh-agent` offers loaded identities
  automatically, including a restricted one, before falling through to
  password). Once in, manually edit `authorized_keys`: strip the line for
  the infra-ops key's blob, re-add it as a bare `ssh-ed25519 AAAA...
  infra-ops@mac-mini` line with no `command=` prefix.
- Also double-check `ssh-add -l` doesn't still have the restricted key
  loaded from a previous session — `ssh-add -d ~/.ssh/infra_ops_ed25519`
  removes it so plain `ssh root@<ip>` doesn't silently pick it up again.
