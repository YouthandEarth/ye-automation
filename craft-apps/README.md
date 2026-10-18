# Craft apps

The 13 open-source [Craft apps](https://getartcraft.com/apps) from ArtCraft (github.com/storytold), installed on the Mac and wired into Claude over MCP so an agent can drive them.

| App | Does | MCP file access |
|---|---|---|
| PhotoCraft | Image editing | workspace folder only |
| VectorCraft | Vector illustration | workspace folder only |
| FilmCraft | Video editing | ⚠ any file you can open |
| LightCraft | Photo library / raw | ⚠ any file you can open |
| PdfCraft | PDFs: combine, split, secure | workspace folder only |
| EffectCraft | Motion graphics | workspace folder only |
| DesignCraft | Page layout | workspace folder only |
| FigCraft | UI design | workspace folder only |
| WordCraft | Word processing | workspace folder only |
| SoundCraft | Audio | workspace folder only |
| DeckCraft | Presentations | workspace folder only |
| CADCraft | CAD / drafting | ⚠ any file you can open |
| GridCraft | Spreadsheets | ⚠ any file you can open |

All are **early alpha / in development**. Fine for marketing and creative work; **not for GMP-controlled records at Thanet Labs** (batch records, SOPs, controlled documents) until they mature and can be validated.

## Install / update

Double-click **`Install Craft Apps.command`** (a copy also sits in `~/mcp-servers/craft/`). It:

1. Installs ArtCraft Launcher and all 13 apps into `/Applications` from the official signed, notarized DMGs, each checked against the release's `SHA256SUMS.txt`.
2. Puts each app's command-line tool (which contains its MCP server) in `~/mcp-servers/craft/<app>/`, with stable links in `~/mcp-servers/craft/bin/`.
3. Adds 13 entries to the Claude desktop app's `claude_desktop_config.json` (backs it up first; other MCP servers are left alone).
4. Starts each MCP server and checks it lists its tools.

Run it again any time to update. Apps that are open are skipped. Log: `~/mcp-servers/craft/install.log`. Restart the Claude app afterwards.

ArtCraft Launcher (menu bar) also keeps the apps themselves up to date.

## Using them from Claude

Put files for Claude to work on in **`~/mcp-servers/craft/workspace/`**. The nine "workspace only" apps cannot read or write anywhere else. To widen that, change the `--automation-read-root` / `--automation-write-root` paths in the script and re-run.

The MCP servers run **headless** (no window). To have Claude drive an open app window instead, start the app with its control flag and use the bridge mode, e.g. `photocraft --control 7878` + `photocraft-cli mcp --bridge 127.0.0.1:7878 --control-token-file …` (see each app's `docs/mcp.md`).

Claude Code: `claude mcp add photocraft -- ~/mcp-servers/craft/bin/photocraft-cli mcp --automation-read-root ~/mcp-servers/craft/workspace --automation-write-root ~/mcp-servers/craft/workspace`

## Security notes

- Stdio MCP: no network listener is opened.
- The four ⚠ apps' MCP servers have no file scoping: tools such as `open`/`save` can reach anything your user account can. Keep Claude's per-tool approval on for them.
- The upstream projects describe their own MCP permission model as partial (filesystem scoping only, no per-tool scopes). Don't expose these servers to remote/untrusted agents.
