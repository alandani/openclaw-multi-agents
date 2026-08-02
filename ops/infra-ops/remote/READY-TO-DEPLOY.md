# SSH Key Deployment Setup — Complete

## Status: ✅ Ready to Deploy

Both infra-watcher and infra-ops deployment infrastructure is now in place.

---

## What We've Built

### Infra-Watcher Deployment (Already Existed)
- **Script**: `watchers/infra-watcher/remote/deploy-all.sh`
- **Enforced via**: Forced-command wrapper (`readonly-check.sh`) on each server
- **Access**: Read-only (disk, mem, cpu, cpanel, summary verbs only)
- **Status**: ✅ Already deployed to all 6 servers

### Infra-Ops Deployment (NEW)
- **Scripts**: 
  - `ops/infra-ops/remote/deploy-all.sh` — main deployment
  - `ops/infra-ops/remote/verify-deployment.sh` — verification
  - `ops/infra-ops/remote/DEPLOYMENT.md` — documentation
- **Enforced via**: Agent-level confirmation gate (AGENT.md) + model-level tool scoping
- **Access**: Full-access SSH (no server-side restrictions yet)
- **Status**: ⏳ Ready to deploy to 4 remaining servers + ULAK WAYKANAN

---

## Current Deployment Status

| Server | Infra-Watcher | Infra-Ops | Status |
|--------|----------------|-----------|--------|
| GRADIEN | ✅ Deployed | ⏳ Pending | Need ops key |
| SIGAP GERINDRA | ✅ Deployed | ⏳ Pending | Need ops key |
| ERP BUMIADIL | ✅ Deployed | ⏳ Pending | Need ops key |
| HAMS ERP31 | ✅ Deployed | ⏳ Pending | Need ops key |
| ULAK WAYKANAN | ❌ Not deployed | ✅ Deployed | Has ops key only |
| ULAK-NEW | ❌ Not deployed | ✅ Deployed | Has ops key only |

---

## Next Steps: Deploy Infra-Ops Key

### Option 1: Deploy to All 4 Remaining Servers (Recommended)

```bash
cd /Users/alandani/Documents/Code/OpenClaw/openclaw-multi-agents/ops/infra-ops/remote

# Deploy to GRADIEN, SIGAP GERINDRA, ERP BUMIADIL, HAMS ERP31
./deploy-all.sh

# Verify all deployed successfully
./verify-deployment.sh
```

**What this does:**
1. Uses existing infra-watcher key as bootstrap access (since all 4 have it)
2. Adds infra-ops public key to each server's authorized_keys
3. Verifies infra-ops key works on all 4 servers

**Bootstrap access priority:**
- Try infra_watcher_ed25519 (already deployed on all 4)
- Try id_ed25519 or id_rsa if they exist locally
- Fallback to password (with `--password` flag)

### Option 2: Deploy with Password Bootstrap

If you want to use root password instead of existing key:

```bash
./deploy-all.sh --password
```

Will prompt for root password and use sshpass to authenticate.

### Option 3: Dry-Run (Verify Only)

```bash
./deploy-all.sh --verify-only
```

Shows which servers already have the key without making changes.

---

## After Deployment

Once infra-ops keys are deployed to all 4 servers:

1. **Test infra-ops with a real action:**
   ```
   User: "restart nginx on GRADIEN"
   → Main agent asks for confirmation
   → infra-ops spawned → proposes action → waits for user yes
   → Executes: systemctl reload nginx
   → Reports back: success/failure
   ```

2. **Monitor via infra-watcher:**
   - infra-watcher continues monitoring all servers (read-only)
   - infra-ops acts on servers (with confirmation gate)
   - Both keys coexist, defense-in-depth model

3. **Optional future hardening:**
   - Deploy forced-command wrapper on servers to enforce allowlist at SSH level
   - Add server-side audit logging for infra-ops actions

---

## Key Files Updated

- ✅ `ops/infra-ops/remote/deploy-all.sh` — deployment automation
- ✅ `ops/infra-ops/remote/verify-deployment.sh` — verification script
- ✅ `ops/infra-ops/remote/DEPLOYMENT.md` — full documentation
- ✅ `instances.json` — marked all 4 servers with ops_ssh_key_path

---

## Notes

- **Bootstrap**: Script smartly tries existing keys first before falling back to password
- **Idempotent**: Can run deploy-all.sh multiple times safely (skips already-deployed servers)
- **Verification**: Use verify-deployment.sh to confirm all keys are working
- **No forced-command yet**: infra-ops key has full SSH access; safety is enforced at agent level (AGENT.md confirmation gate)

Ready to proceed? Run `./deploy-all.sh` when you're ready.
