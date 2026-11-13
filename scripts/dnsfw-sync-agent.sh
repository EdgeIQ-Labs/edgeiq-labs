#!/bin/bash
# EdgeIQ DNS Firewall — Local Pi-hole Sync Agent
# Runs on LAN, queries Pi-holes directly, pushes state to CF Pages sync endpoint
set -euo pipefail

SYNC_URL="https://edgeiqlabs.com/api/dnsfirewall/sync"
INTERNAL_KEY="3b36a0d8f2e1c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9"
PH1="http://10.5.1.117"
PH2="http://10.5.1.240"
PH_PASS="admin"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

ph_auth() {
  local base="$1"
  local sid
  sid=$(curl -sf -X POST "$base/api/auth" \
    -H 'Content-Type: application/json' \
    -d "{\"password\":\"$PH_PASS\"}" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('sid',''))" 2>/dev/null)
  echo "$sid"
}

ph_get() {
  curl -sf -H "X-FTL-SID: $2" "$1" 2>/dev/null || echo '{}'
}

# Auth to both Pi-holes
log "Authenticating to Pi-holes..."
SID1=$(ph_auth "$PH1")
SID2=$(ph_auth "$PH2")

if [ -z "$SID1" ] && [ -z "$SID2" ]; then
  log "ERROR: Could not authenticate to either Pi-hole"
  exit 1
fi

log "PH1 SID: ${SID1:0:10}... | PH2 SID: ${SID2:0:10}..."

# Collect current state
STATE=$(python3 -c "
import json, subprocess, sys

def ph_get(url, sid):
    try:
        r = subprocess.run(['curl', '-sf', '-H', f'X-FTL-SID: {sid}', url], capture_output=True, text=True, timeout=10)
        return json.loads(r.stdout) if r.returncode == 0 else {}
    except: return {}

sid1, sid2 = '$SID1', '$SID2'
ph1_url, ph2_url = '$PH1', '$PH2'

state = {'piholes': {}}
for name, url, sid in [('PH1', ph1_url, sid1), ('PH2', ph2_url, sid2)]:
    if not sid:
        state['piholes'][name] = {'error': 'auth_failed'}
        continue
    groups = ph_get(f'{url}/api/groups', sid)
    lists = ph_get(f'{url}/api/lists', sid)
    state['piholes'][name] = {
        'groups': groups.get('groups', []),
        'blocklists': [l for l in lists.get('lists', []) if l.get('type') == 'block'],
    }

print(json.dumps(state))
")

log "Collected Pi-hole state, pushing to sync endpoint..."

RESPONSE=$(curl -sf -w '\nHTTP:%{http_code}' -X POST "$SYNC_URL" \
  -H 'Content-Type: application/json' \
  -H "X-Internal-Key: $INTERNAL_KEY" \
  -d "$STATE" 2>&1) || true

HTTP_CODE=$(echo "$RESPONSE" | tail -1 | sed 's/HTTP://')
BODY=$(echo "$RESPONSE" | sed '$d')

log "Sync response: HTTP $HTTP_CODE"
if [ "$HTTP_CODE" = "200" ]; then
  SYNCED=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('synced',0))" 2>/dev/null || echo '?')
  log "✅ Sync complete: $SYNCED customers processed"
else
  log "⚠️  Sync returned HTTP $HTTP_CODE: $BODY"
fi
