#!/bin/bash
# Deploy infra-watcher SSH key to all servers from instances.json
#
# Usage:
#   ./deploy-all.sh                       # deploy to all servers
#   ./deploy-all.sh --skip-deployed       # skip servers where the key already works
#   ./deploy-all.sh --verify-only         # no changes made — per-server, tests
#                                          # each verb (disk/mem/cpu/summary)
#                                          # AND confirms arbitrary commands
#                                          # are actually rejected
#   ./deploy-all.sh --password            # allow interactive root-password bootstrap
#   ./deploy-all.sh --key ~/.ssh/foo      # use a specific bootstrap key
#
# Bootstrap access: to install the key, the script first needs ANY working SSH
# login to each server. It tries, in order:
#   1. the ops key listed for that server in instances.json (if any)
#   2. keys passed via --key
#   3. ~/.ssh/id_ed25519, ~/.ssh/id_rsa
#   4. root password (only with --password) — ssh itself prompts you at the
#      terminal, once per server; the script never sees, stores, or passes
#      the password anywhere. See bootstrap_prefix() for how.
# If none work, that server is reported as FAILED with a hint.

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INSTANCES_JSON="$REPO_ROOT/instances.json"
READONLY_SCRIPT="$SCRIPT_DIR/readonly-check.sh"
INFRA_WATCHER_KEY="$HOME/.ssh/infra_watcher_ed25519"
INFRA_WATCHER_PUB="$INFRA_WATCHER_KEY.pub"

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
[[ -f "$INSTANCES_JSON" ]]     || { echo -e "${RED}ERROR: $INSTANCES_JSON not found${NC}"; exit 1; }
[[ -f "$READONLY_SCRIPT" ]]    || { echo -e "${RED}ERROR: $READONLY_SCRIPT not found${NC}"; exit 1; }
[[ -f "$INFRA_WATCHER_PUB" ]]  || { echo -e "${RED}ERROR: $INFRA_WATCHER_PUB not found${NC}"; exit 1; }
command -v jq >/dev/null 2>&1  || { echo -e "${RED}ERROR: jq not installed (brew install jq)${NC}"; exit 1; }

# Control sockets for password-bootstrapped servers live here — one
# interactive auth per server, reused for its 4 setup steps, closed right
# after. 700 because anyone who can reach the socket rides the open session.
CONTROL_DIR="$HOME/.ssh/controlmasters"
mkdir -p "$CONTROL_DIR"
chmod 700 "$CONTROL_DIR"

# Restricted key line built from the real .pub file (no hardcoding)
PUBKEY_BODY="$(cat "$INFRA_WATCHER_PUB")"
PUBKEY_FINGERPRINT="$(awk '{print $2}' <<<"$PUBKEY_BODY")"
PUBKEY_LINE="command=\"/opt/infra-watcher/readonly-check.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $PUBKEY_BODY"

# --- load servers (process substitution keeps us in the main shell, no subshell) ---
SERVERS=()
while IFS='|' read -r name ip user port opskey; do
  SERVERS+=("$name|$ip|$user|$port|$opskey")
done < <(jq -r '.[] | select(.ssh_key_path == "~/.ssh/infra_watcher_ed25519") | "\(.name)|\(.ip)|\(.ssh_user // "root")|\(.ssh_port // 22)|\(.ops_ssh_key_path // "")"' "$INSTANCES_JSON")

if [[ ${#SERVERS[@]} -eq 0 ]]; then
  echo -e "${RED}No servers with ssh_key_path=~/.ssh/infra_watcher_ed25519 in $INSTANCES_JSON${NC}"
  exit 1
fi

echo -e "${BLUE}=== Infra-Watcher SSH Key Deployment ===${NC}"
echo "Servers to process: ${#SERVERS[@]}"
echo ""

# --- helpers ------------------------------------------------------------------

# Return the ssh/scp command prefix that works for bootstrap, or "" if none.
bootstrap_prefix() { # $1=user $2=ip $3=port $4=opskey
  local user="$1" ip="$2" port="$3" opskey="$4" k
  local keys=()
  [[ -n "$opskey" ]] && keys+=("${opskey/#\~/$HOME}")
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
    # open so the 4 setup steps below reuse it instead of prompting 4 times.
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

verify_key() { # $1=user $2=ip $3=port  -> 0 if watcher key works
  ssh -i "$INFRA_WATCHER_KEY" -o BatchMode=yes -o ConnectTimeout=6 -p "$3" "$1@$2" summary >/dev/null 2>&1
}

# Deep check for --verify-only: tests each verb individually, then confirms
# the forced-command wrapper actually rejects arbitrary input — not just that
# the key connects. Returns 0 only if every check passes.
deep_verify() { # $1=user $2=ip $3=port
  local user="$1" ip="$2" port="$3" ok=0 verb
  for verb in disk mem cpu summary; do
    if ssh -i "$INFRA_WATCHER_KEY" -o BatchMode=yes -o ConnectTimeout=6 -p "$port" "$user@$ip" "$verb" >/dev/null 2>&1; then
      echo -e "    ${GREEN}✓${NC} $verb"
    else
      echo -e "    ${RED}✗${NC} $verb"
      ok=1
    fi
  done
  if ssh -i "$INFRA_WATCHER_KEY" -o BatchMode=yes -o ConnectTimeout=6 -p "$port" "$user@$ip" "rm -rf /" 2>&1 | grep -q '^rejected:'; then
    echo -e "    ${GREEN}✓${NC} restrictions enforced"
  else
    echo -e "    ${RED}✗${NC} restrictions NOT enforced (security issue!)"
    ok=1
  fi
  return "$ok"
}

# --- counters (use $((x+1)), NOT ((x++)) — the latter returns 0 when x=0 and kills the script under set -e) ---
deploy_count=0
skip_count=0
error_count=0
RESULTS=()

for entry in "${SERVERS[@]}"; do
  IFS='|' read -r name ip user port opskey <<<"$entry"

  echo -e "${BLUE}Processing: $name ($ip)${NC}"

  if [[ "$VERIFY_ONLY" -eq 1 ]]; then
    if deep_verify "$user" "$ip" "$port"; then
      skip_count=$((skip_count + 1))
      RESULTS+=("OK|$name (all checks passed)")
    else
      error_count=$((error_count + 1))
      RESULTS+=("FAIL|$name (see checks above)")
    fi
    echo ""
    continue
  fi

  # already deployed?
  if verify_key "$user" "$ip" "$port"; then
    echo -e "  ${GREEN}✓ already deployed, skipping${NC}"
    skip_count=$((skip_count + 1))
    RESULTS+=("OK|$name (already deployed)")
    echo ""
    continue
  fi

  # find bootstrap access
  ACCESS="$(bootstrap_prefix "$user" "$ip" "$port" "$opskey" || true)"
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

  # 1. mkdir
  echo "  [1/4] creating /opt/infra-watcher ..."
  if run_remote "$ACCESS" "$HOST" "$port" "mkdir -p /opt/infra-watcher" >/dev/null 2>&1; then
    echo -e "    ${GREEN}✓${NC}"
  else
    echo -e "    ${RED}✗ mkdir failed${NC}"; FAILED=1
  fi

  # 2. copy script
  if [[ "$FAILED" -eq 0 ]]; then
    echo "  [2/4] copying readonly-check.sh ..."
    if run_scp "$ACCESS" "$HOST" "$port" "$READONLY_SCRIPT" "/opt/infra-watcher/readonly-check.sh" >/dev/null 2>&1; then
      echo -e "    ${GREEN}✓${NC}"
    else
      echo -e "    ${RED}✗ scp failed${NC}"; FAILED=1
    fi
  fi

  # 3. chmod
  if [[ "$FAILED" -eq 0 ]]; then
    echo "  [3/4] chmod 755 ..."
    if run_remote "$ACCESS" "$HOST" "$port" "chmod 755 /opt/infra-watcher/readonly-check.sh" >/dev/null 2>&1; then
      echo -e "    ${GREEN}✓${NC}"
    else
      echo -e "    ${RED}✗ chmod failed${NC}"; FAILED=1
    fi
  fi

  # 4. append key (idempotent — skips if already present)
  if [[ "$FAILED" -eq 0 ]]; then
    echo "  [4/4] adding key to authorized_keys ..."
    if run_remote "$ACCESS" "$HOST" "$port" "grep -qF '$PUBKEY_FINGERPRINT' /root/.ssh/authorized_keys 2>/dev/null || echo '$PUBKEY_LINE' >> /root/.ssh/authorized_keys" >/dev/null 2>&1; then
      echo -e "    ${GREEN}✓${NC}"
    else
      echo -e "    ${RED}✗ adding key failed${NC}"; FAILED=1
    fi
  fi

  # verify
  if [[ "$FAILED" -eq 0 ]] && verify_key "$user" "$ip" "$port"; then
    echo -e "  ${GREEN}✓ Deployment successful — watcher key verified${NC}"
    deploy_count=$((deploy_count + 1))
    RESULTS+=("OK|$name (deployed)")
  else
    echo -e "  ${RED}✗ deployment incomplete — watcher key not working${NC}"
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
