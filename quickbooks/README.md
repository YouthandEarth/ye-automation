# QuickBooks Online (UK) – API tools

Intuit's QuickBooks connector for Claude only works with US accounts, so this talks
to the standard **QuickBooks Online Accounting API** directly through our own private
Intuit developer app (production keys). It works fine for UK companies.

Two ways to run the same code:

| Where | How it gets the keys | What it can do |
|---|---|---|
| **Your Mac** (Terminal / Claude Code) | macOS Keychain, service `youthandearth-quickbooks` | Everything below, including emailing an invoice (asks you to type `YES`) |
| **Vercel** (`/api/quickbooks`) | Vercel environment variables + shared token store | Read-only reports, protected by `QB_API_KEY` |

**Secrets never go in this repo.** Keys live in the Keychain or in Vercel. Outputs
(error logs, CSVs, PDFs, `payables.json`) are git-ignored because they hold financial data.

## On your Mac

```bash
cd ~/"Youth & Earth"/ye-automation      # wherever you cloned the repo
node quickbooks/qb.js test              # ✔ Connected to QuickBooks: Youth & Earth … – token store: keychain
node quickbooks/qb.js unpaid            # unpaid supplier bills
node quickbooks/qb.js overdue           # overdue customer invoices
node quickbooks/qb.js paid 60           # supplier payments, last 60 days
node quickbooks/qb.js vendor "Dext"     # one supplier's bills
node quickbooks/qb.js query "SELECT * FROM Customer MAXRESULTS 5"
node quickbooks/spend.js 6              # spend by supplier, last 6 months → CSV
```

Full command list: top of `qb.js`. Requires Node.js 18+, no packages to install.

### If it says "QuickBooks needs reconnecting"

The refresh token expired or was revoked. Get a new one in the
[Intuit OAuth Playground](https://developer.intuit.com/app/developer/playground)
(select the app → Accounting scope → *Get authorization code* → *Get tokens*), then:

```bash
node quickbooks/qb.js set-token     # paste it (hidden); saved to whichever store is in use
```

## Running it in the cloud (Vercel)

Intuit **rotates the refresh token** about once a day. If the Mac and Vercel each kept
their own copy, whichever refreshed second would be locked out. So before turning on
the cloud copy, both are moved to one shared token store (Upstash Redis, free tier):

1. Vercel → **ye-automation** project → **Storage** → add **Upstash for Redis**.
   This creates `KV_REST_API_URL` and `KV_REST_API_TOKEN` on the project.
2. On your Mac, from the repo folder: `bash quickbooks/setup-cloud.sh`
   - asks for the two Upstash values (hidden input, stored in your Keychain)
   - copies the current refresh token into the shared store
   - switches your Mac to use it (`QB_TOKEN_STORE=upstash` in the Keychain)
   - if the Vercel CLI is installed and linked (`vercel link`), adds `QB_CLIENT_ID`,
     `QB_CLIENT_SECRET`, `QB_REALM_ID` and a new random `QB_API_KEY` to Vercel for you
3. Redeploy, then check it:

```bash
curl -H "Authorization: Bearer $(security find-generic-password -s youthandearth-quickbooks -a QB_API_KEY -w)" \
  "https://<your-deployment>.vercel.app/api/quickbooks?report=health"
```

### Endpoints (all read-only)

`/api/quickbooks?report=` `health` · `payables` · `invoices` · `overdue` ·
`paid&days=30` · `pnl&start=2026-04-01&end=2026-09-30` · `balance-sheet&date=2026-09-30` ·
`query&q=SELECT …`

## Files

```
quickbooks/
  lib/credentials.js   where settings/tokens are read and saved (Keychain, env, Upstash)
  lib/qbo.js           QuickBooks API client + shared report helpers
  qb.js                Terminal tool
  spend.js             spend-by-supplier CSV export
  setup-cloud.sh       one-off switch to the shared token store / Vercel
api/quickbooks.js      Vercel endpoint (read-only)
```
