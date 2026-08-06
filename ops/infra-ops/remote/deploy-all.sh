#!/bin/bash
# Deploy infra-ops SSH key to all servers from instances.json
#
# Usage:
#   ./deploy-all.sh                       # deploy to all servers
#   ./deploy-all.sh --skip-deployed       # skip servers where the key already works
#   ./deploy-all.sh --verify-only         # dry run: only report current status
#   ./deploy-all.sh --password            # allow interactive root-password bootstrap
#   ./deploy-all.sh --key ~/.ssh/foo      # use a specific bootstrap key
#
# Bootstrap access: to install the key, the script first needs ANY working SSH
# login to each server. It tries, in order:
#   1. the infra_watcher key listed for that server in instances.json (if any)
#   2. the ops key listed for that server in instances.json (if any)
#   3. keys passed via --key
#   4. ~/.ssh/id_ed25519, ~/.ssh/id_rsa
#   5. root password (only with --password) — ssh itself prompts you at the
#      terminal, once per server; the script never sees, stores, or passes
#      the password anywhere. See bootstrap_prefix() for how.
# If none work, that server is reported as FAILED with a hint.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INSTANCES_JSON="$REPO_ROOT/instances.json"
INFRA_OPS_KEY="$HOME/.ssh/infra_ops_ed25519"
INFRA_OPS_PUB="$INFRA_OPS_KEY.pub"

# Flags
SKIP_DEPLOYED=0
VERIFY_ONLY=0
USE_PASSWORD=0
EXTRA_KEYS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-deployed) SKIP_DEPLOYED=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    --password) USE_PASSWORD=1 ;;
    --key) EXTRA_KEYS+=("$2"); shift ;;
    *) echo "Usage: $0 [--skip-deployed] [--verify-only] [--password] [--key <path>]"; exit 1 ;;
  esac
  shift
done

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

# --- sanity checks ----------------------------------------------------------
[[ -f "$INSTANCES_JSON" ]]    || { echo -e "${RED}ERROR: $INSTANCES_JSON not found${NC}"; exit 1; }
[[ -f "$INFRA_OPS_PUB" ]]     || { echo -e "${RED}ERROR: $INFRA_OPS_PUB not found${NC}"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo -e "${RED}ERROR: jq not installed (brew install jq)${NC}"; exit 1; }

# Control sockets for password-bootstrapped servers live here — one
# interactive auth per server, reused for its setup steps, closed right
# after. 700 because anyone who can reach the socket rides the open session.
CONTROL_DIR="$HOME/.ssh/controlmasters"
mkdir -p "$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"

# Public key (full-access, no forced-command restriction for now)
PUBKEY_BODY="$(cat "$INFRA_OPS_PUB")"
PUBKEY_FINGERPRINT="$(awk '{print $2}' <<<"$PUBKEY_BODY")"
PUBKEY_LINE="$PUBKEY_BODY"

# --- load servers (process substitution keeps us in the main shell) ---
SERVERS=()
while IFS='|' read -r name ip user port ssh_watcher ops_key; do
  SERVERS+=("$name|$ip|$user|$port|$ssh_watcher|$ops_key")
done < <(jq -r '.[] | "\(.name)|\(.ip)|\(.ssh_user // "root")|\(.ssh_port // 22)|\(.ssh_key_path // "")|\(.ops_ssh_key_path // "")"' "$INSTANCES_JSON")

if [[ ${#SERVERS[@]} -eq 0 ]]; then
  echo -e "${RED}No servers in $INSTANCES_JSON${NC}"
  exit 1
fi

echo -e "${BLUE}=== Infra-Ops SSH Key Deployment ===${NC}"
echo "Servers to process: ${#SERVERS[@]}"
echo ""

# --- helpers ------------------------------------------------------------------

# Return the ssh/scp command prefix that works for bootstrap, or "" if none.
bootstrap_prefix() { # $1=user $2=ip $3=port $4=ssh_watcher_key $5=ops_key
  local user="$1" ip="$2" port="$3" ssh_watcher="$4" ops_key="$5" k
  local keys=()
  
  # Try existing keys in order of preference
  [[ -n "$ops_key" ]] && keys+=("${ops_key/#\~/$HOME}")
  [[ -n "$ssh_watcher" ]] && keys+=("${ssh_watcher/#\~/$HOME}")
  # ${arr[@]+"${arr[@]}"} — bash 3.2 (macOS) treats "${arr[@]}" on an empty
  # array as unbound under `set -u`; this guard expands to nothing instead.
  for k in ${EXTRA_KEYS[@]+"${EXTRA_KEYS[@]}"}; do keys+=("${k/#\~/$HOME}"); done
  keys+=("$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa")

  for k in "${keys[@]}"; do
    [[ -f "$k" ]] || continue
    if ssh -i "$k" -o BatchMode=yes -o ConnectTimeout=6 -p "$port" "$user@$ip" true >/dev/null 2>&1; then
      echo "key:$k"
      return 0
    fi
  done

  if [[ "$USE_PASSWORD" -eq 1 ]]; then
    # No key worked — fall back to an interactive password login. ssh reads
    # the password directly from the terminal (never from this script, never
    # stored anywhere); ControlMaster keeps that one authenticated session
    # open so the setup steps below reuse it instead of prompting repeatedly.
    local cpath="$CONTROL_DIR/$user@$ip:$port"
    echo -e "  ${YELLOW}No key access — enter the root password when prompted (once for this server):${NC}" >&2
    if ssh -o ControlMaster=yes -o ControlPersist=10m -o ControlPath="$cpath" \
           -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
           -p "$port" "$user@$ip" true; then
      echo "ctrl:$cpath"
      return 0
    fi
    return 1
  fi
  return 1
}

# Run a remote command. $1 = access ("key:/path" or "ctrl:/path/to/socket")
run_remote() { # $1=access $2=user@host $3=port $4=command...
  local access="$1" host="$2" port="$3" cmd="$4"
  if [[ "$access" == ctrl:* ]]; then
    local cpath="${access#ctrl:}"
    ssh -o ControlPath="$cpath" -p "$port" "$host" "$cmd"
  else
    local key="${access#key:}"
    ssh -i "$key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p "$port" "$host" "$cmd"
  fi
}

run_scp() { # $1=access $2=user@host $3=port $4=src $5=dst
  local access="$1" host="$2" port="$3" src="$4" dst="$5"
  if [[ "$access" == ctrl:* ]]; then
    local cpath="${access#ctrl:}"
    scp -o ControlPath="$cpath" -P "$port" "$src" "$host:$dst"
  else
    local key="${access#key:}"
    scp -i "$key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -P "$port" "$src" "$host:$dst"
  fi
}

verify_key() { # $1=user $2=ip $3=port  -> 0 if ops key works
  ssh -i "$INFRA_OPS_KEY" -o BatchMode=yes -o ConnectTimeout=6 -p "$3" "$1@$2" "echo test" >/dev/null 2>&1
}

# --- counters (use $((x+1)), NOT ((x++)) — the latter returns 0 when x=0 and kills the script under set -e) ---
deploy_count=0
skip_count=0
error_count=0
RESULTS=()

for entry in "${SERVERS[@]}"; do
  IFS='|' read -r name ip user port ssh_watcher ops_key <<<"$entry"

  echo -e "${BLUE}Processing: $name ($ip)${NC}"

  # already deployed?
  if verify_key "$user" "$ip" "$port"; then
    if [[ "$VERIFY_ONLY" -eq 1 ]]; then
      echo -e "  ${GREEN}✓ key works${NC}"
    else
      echo -e "  ${GREEN}✓ already deployed, skipping${NC}"
    fi
    skip_count=$((skip_count + 1))
    RESULTS+=("OK|$name (already deployed)")
    echo ""
    continue
  fi

  if [[ "$VERIFY_ONLY" -eq 1 ]]; then
    echo -e "  ${RED}✗ key NOT deployed${NC}"
    error_count=$((error_count + 1))
    RESULTS+=("FAIL|$name (key not deployed)")
    echo ""
    continue
  fi

  # find bootstrap access
  ACCESS="$(bootstrap_prefix "$user" "$ip" "$port" "$ssh_watcher" "$ops_key" || true)"
  if [[ -z "$ACCESS" ]]; then
    echo -e "  ${RED}✗ no existing SSH access to this server${NC}"
    echo -e "    ${YELLOW}Hints: run with --password (you'll be prompted, interactively, at the terminal), add your own key to this server first, or use the Vultr web console.${NC}"
    error_count=$((error_count + 1))
    RESULTS+=("FAIL|$name (no bootstrap access)")
    echo ""
    continue
  fi

  if [[ "$ACCESS" == ctrl:* ]]; then
    echo -e "  ${YELLOW}  bootstrap: interactive password (authenticated session reused for this server only)${NC}"
  else
    echo -e "  ${YELLOW}  bootstrap: ${ACCESS#key:}${NC}"
  fi

  HOST="$user@$ip"
  FAILED=0

  # Create ~/.ssh if needed
  echo "  [1/3] ensuring ~/.ssh exists ..."
  if run_remote "$ACCESS" "$HOST" "$port" "mkdir -p ~/.ssh && chmod 700 ~/.ssh" >/dev/null 2>&1; then
    echo -e "    ${GREEN}✓${NC}"
  else
    echo -e "    ${RED}✗ mkdir ~/.ssh failed${NC}"; FAILED=1
  fi

  # Add key (idempotent — skips if already present)
  if [[ "$FAILED" -eq 0 ]]; then
    echo "  [2/3] adding key to authorized_keys ..."
    if run_remote "$ACCESS" "$HOST" "$port" "grep -qF '$PUBKEY_FINGERPRINT' ~/.ssh/authorized_keys 2>/dev/null || echo '$PUBKEY_LINE' >> ~/.ssh/authorized_keys" >/dev/null 2>&1; then
      echo -e "    ${GREEN}✓${NC}"
    else
      echo -e "    ${RED}✗ adding key failed${NC}"; FAILED=1
    fi
  fi

  # Fix permissions
  if [[ "$FAILED" -eq 0 ]]; then
    echo "  [3/3] fixing permissions on authorized_keys ..."
    if run_remote "$ACCESS" "$HOST" "$port" "chmod 600 ~/.ssh/authorized_keys" >/dev/null 2>&1; then
      echo -e "    ${GREEN}✓${NC}"
    else
      echo -e "    ${RED}✗ chmod failed${NC}"; FAILED=1
    fi
  fi

  # verify
  if [[ "$FAILED" -eq 0 ]] && verify_key "$user" "$ip" "$port"; then
    echo -e "  ${GREEN}✓ Deployment successful — ops key verified${NC}"
    deploy_count=$((deploy_count + 1))
    RESULTS+=("OK|$name (deployed)")
  else
    echo -e "  ${RED}✗ deployment incomplete — ops key not working${NC}"
    error_count=$((error_count + 1))
    RESULTS+=("FAIL|$name (deploy incomplete)")
  fi

  # close the interactive session immediately rather than waiting out
  # ControlPersist — don't leave an authenticated root socket lying around
  if [[ "$ACCESS" == ctrl:* ]]; then
    ssh -O exit -o ControlPath="${ACCESS#ctrl:}" -p "$port" "$HOST" >/dev/null 2>&1 || true
  fi

  echo ""
done

# --- summary ------------------------------------------------------------------
echo -e "${BLUE}=== Summary ===${NC}"
for r in "${RESULTS[@]}"; do
  IFS='|' read -r status detail <<<"$r"
  if [[ "$status" == "OK" ]]; then echo -e "  ${GREEN}✓${NC} $detail"
  else echo -e "  ${RED}✗${NC} $detail"; fi
done
echo ""
echo -e "  Deployed: ${GREEN}$deploy_count${NC}  Skipped/already: ${YELLOW}$skip_count${NC}  Failed: ${RED}$error_count${NC}"

if [[ "$error_count" -gt 0 ]]; then
  echo -e "\n${YELLOW}Some servers failed. See per-server messages above for why.${NC}"
  exit 1
fi
exit 0
