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
| `deploy-all.sh` | Main deployment script (loops through all servers) |
| `verify-deployment.sh` | Verify all servers have the key deployed correctly |
| `DEPLOYMENT.md` | This file |

## Quick Start

```bash
# Deploy to all servers
cd /Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents/ops/infra-ops/remote
./deploy-all.sh

# Verify deployment worked
./verify-deployment.sh
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

# Use password for bootstrap (needs sshpass installed)
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

### verify-deployment.sh

Tests that the infra-ops key works on each server:

```bash
./verify-deployment.sh
```

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

Once infra-ops key is deployed to all servers:

1. The infra-ops agent can now perform actions on those servers
2. All actions still require explicit user confirmation (confirmation gate in AGENT.md)
3. Actions are logged and reported back to the user
4. Run `./verify-deployment.sh` regularly to ensure all keys are still working

## Integration with infra-watcher

Both infra-watcher and infra-ops keys can coexist on the same server:

- **infra-watcher key**: Read-only, forced-command restricted, used for monitoring
- **infra-ops key**: Full-access, used for actions (with confirmation gate in agent)

This provides defense-in-depth: if one key is compromised, the other is still scoped to its intended use.

## Next Steps

1. Run `./deploy-all.sh` to deploy infra-ops key to all servers
2. Run `./verify-deployment.sh` to confirm
3. Test infra-ops agent with a real action (e.g., restart a service with user confirmation)
4. (Future) Deploy forced-command wrapper for SSH-level enforcement of the allowlist
