#!/bin/bash
# One command to finish moving QuickBooks to Vercel. Run on your Mac:
#
#   bash quickbooks/setup-cloud.sh
#
# It walks you through everything, one step at a time:
#   1. asks for the two Upstash values (hidden typing, saved in your Keychain)
#   2. copies your current QuickBooks login into the shared store
#   3. puts each Vercel value on your clipboard, one by one, so you just paste it
#      into Vercel → ye-automation → Settings → Environment Variables
#   4. tests the connection
#
# Nothing secret is printed on screen or written to the repo.

set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE="youthandearth-quickbooks"
kc_get() { security find-generic-password -s "$SERVICE" -a "$1" -w 2>/dev/null || true; }
kc_set() { security add-generic-password -U -s "$SERVICE" -a "$1" -w "$2"; }
pause() { read -r -p "   Press Enter when done… " _; echo; }

echo
echo "QuickBooks → Vercel setup"
echo "========================="

for k in QB_CLIENT_ID QB_CLIENT_SECRET QB_REALM_ID QB_REFRESH_TOKEN; do
  [ -n "$(kc_get $k)" ] || { echo "✖ $k is not in the Keychain – run 'node quickbooks/qb.js test' first."; exit 1; }
done

# ---- Step 1: Upstash values ----
if [ -z "$(kc_get KV_REST_API_URL)" ] || [ -z "$(kc_get KV_REST_API_TOKEN)" ]; then
  echo
  echo "STEP 1 of 3 – Shared token store"
  echo "   In Vercel open: Storage → upstash-kv-almond-magnet → '.env.local' tab → Show secret."
  echo "   Copy each value (the part after the = sign, without quotes) and paste it here."
  echo "   (Nothing will appear as you paste – that's normal.)"
  echo
  read -r -s -p "   Paste KV_REST_API_URL and press Enter: " v; echo; v="${v//\"/}"; kc_set KV_REST_API_URL "$v"
  read -r -s -p "   Paste KV_REST_API_TOKEN and press Enter: " v; echo; v="${v//\"/}"; kc_set KV_REST_API_TOKEN "$v"
fi

node -e '
  process.env.QB_TOKEN_STORE = "upstash";
  const { keychainGet, loadConfig } = require("./quickbooks/lib/credentials");
  const cfg = loadConfig();
  cfg.store.set({ refreshToken: keychainGet("QB_REFRESH_TOKEN"), accessToken: null, accessExpiresAt: null })
    .then(() => console.log("   ✔ QuickBooks login copied to the shared store"))
    .catch(e => { console.error("   ✖ " + e.message + "\n   Check the two Upstash values and run this again."); process.exit(1); });
'
kc_set QB_TOKEN_STORE upstash
echo "   ✔ This Mac now uses the shared store"

# ---- Step 2: Vercel keys via clipboard ----
[ -n "$(kc_get QB_API_KEY)" ] || kc_set QB_API_KEY "$(openssl rand -hex 24)"

echo
echo "STEP 2 of 3 – Add 4 keys in Vercel"
echo "   Open: Vercel → ye-automation → Settings → Environment Variables."
echo "   For each one below: click 'Add Environment Variable', type the NAME shown,"
echo "   click in the Value box and press Cmd+V, then Save."
for k in QB_CLIENT_ID QB_CLIENT_SECRET QB_REALM_ID QB_API_KEY; do
  echo
  kc_get "$k" | tr -d '\n' | pbcopy
  echo "   ▶ NAME:  $k     (value is now on your clipboard)"
  pause
done
printf '' | pbcopy
echo "   ✔ Clipboard cleared"

# ---- Step 3: redeploy + test ----
echo
echo "STEP 3 of 3 – Redeploy"
echo "   In Vercel: Deployments → latest deployment → ⋯ menu → Redeploy."
pause

node quickbooks/qb.js test
echo "All done. Tell Claude it's redeployed and it will check the Vercel side."
echo
