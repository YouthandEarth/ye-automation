#!/bin/bash
# One-off: switch QuickBooks from "Mac Keychain only" to the shared cloud token
# store, so your Mac and Vercel always use the same (latest) refresh token.
#
# Run on your Mac, from the repo folder:   bash quickbooks/setup-cloud.sh
#
# Before running:
#   1. In Vercel, open the ye-automation project → Storage → add "Upstash for Redis"
#      (free tier is fine). This adds KV_REST_API_URL and KV_REST_API_TOKEN to the project.
#   2. Copy those two values from the Upstash/Vercel page – this script asks for them
#      (input is hidden) and keeps them in your Keychain, never in a file.
#   3. Optional: install the Vercel CLI (npm i -g vercel) and run `vercel link` in this
#      folder, and the script will add the QuickBooks variables to Vercel for you.
#
# Nothing is printed to the screen or written to the repo.

set -euo pipefail
SERVICE="youthandearth-quickbooks"
kc_get() { security find-generic-password -s "$SERVICE" -a "$1" -w 2>/dev/null || true; }
kc_set() { security add-generic-password -U -s "$SERVICE" -a "$1" -w "$2"; }

for k in QB_CLIENT_ID QB_CLIENT_SECRET QB_REALM_ID QB_REFRESH_TOKEN; do
  [ -n "$(kc_get $k)" ] || { echo "✖ $k is not in the Keychain – run 'node quickbooks/qb.js test' first."; exit 1; }
done

if [ -z "$(kc_get KV_REST_API_URL)" ]; then
  read -r -s -p "Paste KV_REST_API_URL: " v; echo; kc_set KV_REST_API_URL "$v"
fi
if [ -z "$(kc_get KV_REST_API_TOKEN)" ]; then
  read -r -s -p "Paste KV_REST_API_TOKEN: " v; echo; kc_set KV_REST_API_TOKEN "$v"
fi

# Copy the current refresh token into the shared store, then point this Mac at it.
node -e '
  process.env.QB_TOKEN_STORE = "upstash";
  const { keychainGet, loadConfig } = require("./quickbooks/lib/credentials");
  const cfg = loadConfig();
  cfg.store.set({ refreshToken: keychainGet("QB_REFRESH_TOKEN"), accessToken: null, accessExpiresAt: null })
    .then(() => console.log("✔ Refresh token copied to the shared store"))
    .catch(e => { console.error("✖ " + e.message); process.exit(1); });
'
kc_set QB_TOKEN_STORE upstash
echo "✔ This Mac now uses the shared token store"

if command -v vercel >/dev/null 2>&1 && [ -f .vercel/project.json ]; then
  for k in QB_CLIENT_ID QB_CLIENT_SECRET QB_REALM_ID; do
    for env in production preview; do
      vercel env rm "$k" "$env" -y >/dev/null 2>&1 || true
      kc_get "$k" | vercel env add "$k" "$env" >/dev/null
    done
  done
  if ! vercel env ls production 2>/dev/null | grep -q QB_API_KEY; then
    key=$(openssl rand -hex 24)
    kc_set QB_API_KEY "$key"
    for env in production preview; do printf '%s' "$key" | vercel env add QB_API_KEY "$env" >/dev/null; done
    echo "✔ Created QB_API_KEY (saved in your Keychain as QB_API_KEY)"
  fi
  echo "✔ QuickBooks settings added to Vercel – redeploy for them to take effect: vercel --prod"
else
  echo
  echo "Next: add QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REALM_ID and QB_API_KEY in"
  echo "Vercel → ye-automation → Settings → Environment Variables (or install the Vercel CLI,"
  echo "run 'vercel link', and run this script again to do it automatically)."
fi

node quickbooks/qb.js test
