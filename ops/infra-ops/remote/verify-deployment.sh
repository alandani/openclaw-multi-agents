#!/bin/bash
# Verify infra-ops SSH key deployment on all servers

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INSTANCES_JSON="$REPO_ROOT/instances.json"
INFRA_OPS_KEY="$HOME/.ssh/infra_ops_ed25519"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

# Sanity checks
[[ -f "$INSTANCES_JSON" ]] || { echo -e "${RED}ERROR: $INSTANCES_JSON not found${NC}"; exit 1; }
[[ -f "$INFRA_OPS_KEY" ]] || { echo -e "${RED}ERROR: $INFRA_OPS_KEY not found${NC}"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo -e "${RED}ERROR: jq not installed${NC}"; exit 1; }

echo -e "${BLUE}=== Infra-Ops SSH Key Verification ===${NC}"
echo ""

# Load servers
SERVERS=()
while IFS='|' read -r name ip user port; do
  SERVERS+=("$name|$ip|$user|$port")
done < <(jq -r '.[] | "\(.name)|\(.ip)|\(.ssh_user // "root")|\(.ssh_port // 22)"' "$INSTANCES_JSON")

pass_count=0
fail_count=0

for entry in "${SERVERS[@]}"; do
  IFS='|' read -r name ip user port <<<"$entry"
  
  echo -n "Testing $name ($ip) ... "
  
  if ssh -i "$INFRA_OPS_KEY" -o BatchMode=yes -o ConnectTimeout=6 -p "$port" "$user@$ip" "echo ok" >/dev/null 2>&1; then
    echo -e "${GREEN}✓ OK${NC}"
    pass_count=$((pass_count + 1))
  else
    echo -e "${RED}✗ FAILED${NC}"
    fail_count=$((fail_count + 1))
  fi
done

echo ""
echo -e "${BLUE}=== Summary ===${NC}"
echo -e "  Passed: ${GREEN}$pass_count${NC}  Failed: ${RED}$fail_count${NC}"

if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi
exit 0
