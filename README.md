# ye-automation

Youth & Earth automation scripts.

| Folder | What it does |
|---|---|
| [`quickbooks/`](quickbooks/README.md) | QuickBooks Online (UK) via the Intuit API: unpaid bills, overdue invoices, supplier spend, invoice emailing; plus a read-only Vercel endpoint (`api/quickbooks.js`) |
| [`craft-apps/`](craft-apps/README.md) | The 13 open-source Craft apps (PhotoCraft, VectorCraft, PdfCraft, DeckCraft…): one-click Mac install and MCP servers so Claude can drive them |

Secrets never live in this repo. They're kept in the macOS Keychain or in Vercel environment variables.
