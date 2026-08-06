# SSH Deployment Automation

Automated deployment of the infra-watcher SSH key to all servers listed in `instances.json`.

## What This Does

Deploys a **restricted SSH key** to all your servers that:

- Can only execute specific read-only commands (`disk`, `mem`, `cpu`, `cpanel`, `summary`)
- Cannot execute arbitrary commands, even if compromised
- Works non-interactively (no password prompts)
- Enables automated infrastructure monitoring

## Files

| File                  | Purpose                                                        |
| --------------------- | --------------------------------------------------------------- |
| `deploy-all.sh`      | Deploys to all servers, and (`--verify-only`) verifies them too |
| `readonly-check.sh`  | Forced-command script installed on each server                  |

`verify-deployment.sh` and `quick-test.sh` used to be separate scripts;
both were folded into `deploy-all.sh --verify-only`, which now runs the
same per-verb + restriction-enforcement checks in one place.

## Quick Start

```bash
# Deploy to all servers
cd /Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents/watchers/infra-watcher/remote
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

# Verify only — no changes made. Tests each verb (disk/mem/cpu/summary)
# individually and confirms arbitrary commands are actually rejected.
./deploy-all.sh --verify-only
```

**What happens per server:**

1. Creates `/opt/infra-watcher/` directory
2. Copies `readonly-check.sh` to the server
3. Sets execute permissions (755)
4. Adds the restricted public key to `/root/.ssh/authorized_keys`
5. Verifies the key works by running a `summary` command

**Output colors:**

- 🟢 Green = Success
- 🔴 Red = Failed
- 🟡 Yellow = Skipped or warning

## Prerequisites

Your local system must have:

- SSH key at `~/.ssh/infra_watcher_ed25519` (private key)
- `jq` installed (`brew install jq` on macOS)
- SSH access to all servers in `instances.json` via password/existing key

## Which Servers Get Deployed To

The script reads `instances.json` at the repo root and deploys only to servers that have:

```json
"ssh_key_path": "~/.ssh/infra_watcher_ed25519"
```

Currently (from instances.json):

- ✅ SIGAP GERINDRA (149.28.152.242)
- ✅ ULAK WAYKANAN (139.180.141.216) — has ops key, will add watcher key
- ✅ ERP BUMIADIL (139.180.216.195)
- ✅ HAMS ERP31 (149.28.142.7)
- ✅ GRADIEN (139.180.142.26) — already deployed manually

Servers **excluded** (different SSH setup):

- ULAK-NEW — has ops key only, no watcher key planned

## Security Model

**The SSH key is intentionally restricted:**

```bash
# This is what gets added to authorized_keys
command="/opt/infra-watcher/readonly-check.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... infra-watcher@mac-mini
```

**Even if the private key leaked**, an attacker could only:

- Read disk/memory/CPU stats
- Cannot execute arbitrary commands
- Cannot modify files
- Cannot access other services

The `readonly-check.sh` script on each server validates the command and rejects anything not in its whitelist.

## Troubleshooting

### "Permission denied" during deployment

- The initial SSH access (to create directory, copy script) requires password or existing key
- Make sure you can SSH to the server manually first: `ssh root@<ip>`

### Deploy fails midway through

- Check which step failed (1/4, 2/4, 3/4, 4/4)
- Re-run `./deploy-all.sh --skip-deployed` to retry failed servers
- Manually check the server state if needed

### `--verify-only` says "restrictions NOT enforced"

- This indicates a security issue — the key may not be properly restricted
- Check that the `command=...` prefix is present in `/root/.ssh/authorized_keys` on that server

### "jq: command not found"

- Install jq: `brew install jq` (macOS) or `apt-get install jq` (Linux)

## Manual Steps (if needed)

If the script fails and you need to deploy manually to one server:

```bash
# 1. Create directory
ssh root@<ip> mkdir -p /opt/infra-watcher

# 2. Copy script
scp readonly-check.sh root@<ip>:/opt/infra-watcher/readonly-check.sh

# 3. Make executable
ssh root@<ip> chmod 755 /opt/infra-watcher/readonly-check.sh

# 4. Add key (full line built from ~/.ssh/infra_watcher_ed25519.pub — see
#    PUBKEY_LINE in deploy-all.sh for the exact restriction flags)
ssh root@<ip> 'echo "command=\"/opt/infra-watcher/readonly-check.sh\"..." >> /root/.ssh/authorized_keys'

# 5. Test
ssh -i ~/.ssh/infra_watcher_ed25519 root@<ip> summary
```

## After Deployment

Once all servers have the key deployed:

1. The infra-watcher agent will automatically start monitoring all servers
2. SSH monitoring will replace the read-only checks in the daily digest
3. Any server state changes (disk >90%, memory issues, etc.) will be reported

Run `./deploy-all.sh --verify-only` regularly to ensure all keys are still working.
