#!/bin/bash
# ---------------------------------------------------------------------------
#  Install Craft Apps  —  Youth & Earth / Thanet Labs
#
#  Double-click in Finder. It will:
#    1. Install ArtCraft Launcher + all 13 Craft apps into /Applications
#       (official signed + notarized DMGs from github.com/storytold, each
#       checked against the release's SHA-256 before installing)
#    2. Make sure each app's command-line tool (which contains its MCP
#       server) is in ~/mcp-servers/craft
#    3. Register the 13 MCP servers in the Claude desktop app
#       (backs up claude_desktop_config.json first)
#    4. Test that every MCP server starts and lists its tools
#
#  Safe to run again: it updates to the newest release and skips apps
#  that are currently open. Log: ~/mcp-servers/craft/install.log
# ---------------------------------------------------------------------------
set -u
CRAFT_DIR="$HOME/mcp-servers/craft"   # CLIs/MCP servers live here wherever this script is run from
WORKSPACE="$CRAFT_DIR/workspace"
CACHE="$HOME/Downloads/ArtCraft"
LOG="$CRAFT_DIR/install.log"
CFG_DIR="$HOME/Library/Application Support/Claude"
CFG="$CFG_DIR/claude_desktop_config.json"
APPS="photocraft vectorcraft filmcraft lightcraft pdfcraft effectcraft designcraft figcraft wordcraft soundcraft deckcraft cadcraft gridcraft"
# Apps whose MCP server supports scoped file access (only the workspace folder)
ROOTED="photocraft vectorcraft pdfcraft effectcraft designcraft figcraft wordcraft soundcraft deckcraft"
LAUNCHER_VER="0.3.2"
LAUNCHER_SHA="7c3325209c6dfa062a8467d0f65dafcb0e6a493c2198545490c47b743be09158"

mkdir -p "$CACHE" "$WORKSPACE" "$CRAFT_DIR/bin"
cd "$CRAFT_DIR" || exit 1
exec > >(tee -a "$LOG") 2>&1
echo; echo "=== Craft apps setup  $(date) ==="
FAILS=0

latest_tag() {
  curl -fsSL "https://api.github.com/repos/storytold/$1/releases?per_page=1" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/'
}

# download URL to CACHE (if not already there) and verify against SHA256SUMS
fetch_verified() {  # $1 repo  $2 tag  $3 filename
  local base="https://github.com/storytold/$1/releases/download/$2"
  local sums; sums=$(curl -fsSL "$base/SHA256SUMS.txt") || { echo "  ! could not get checksums for $1"; return 1; }
  local line; line=$(printf '%s\n' "$sums" | grep " $3\$")
  [ -z "$line" ] && { echo "  ! $3 not listed in checksums"; return 1; }
  if [ -f "$CACHE/$3" ] && (cd "$CACHE" && printf '%s\n' "$line" | shasum -a 256 -c - >/dev/null 2>&1); then return 0; fi
  echo "  downloading $3 ..."
  curl -fL --progress-bar -o "$CACHE/$3.part" "$base/$3" && mv "$CACHE/$3.part" "$CACHE/$3" || { echo "  ! download failed: $3"; return 1; }
  (cd "$CACHE" && printf '%s\n' "$line" | shasum -a 256 -c - >/dev/null 2>&1) || { echo "  ! CHECKSUM MISMATCH: $3 (not installed)"; rm -f "$CACHE/$3"; return 1; }
}

install_dmg() {  # $1 path to dmg
  local mnt; mnt=$(mktemp -d /tmp/craftmnt.XXXXXX)
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$1" >/dev/null 2>&1 || { echo "  ! could not open $(basename "$1")"; rmdir "$mnt"; return 1; }
  local app; app=$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)
  local rc=0
  if [ -z "$app" ]; then echo "  ! no app inside $(basename "$1")"; rc=1
  else
    local name; name=$(basename "$app")
    if pgrep -f "/Applications/$name/" >/dev/null 2>&1; then
      echo "  - $name is open, skipped (quit it and run this again to update)"
    else
      rm -rf "/Applications/$name.new"
      if ditto "$app" "/Applications/$name.new" && rm -rf "/Applications/$name" && mv "/Applications/$name.new" "/Applications/$name"; then
        echo "  ✓ /Applications/$name  ($(defaults read "/Applications/$name/Contents/Info" CFBundleShortVersionString 2>/dev/null))"
      else echo "  ! could not write to /Applications/$name"; rc=1; fi
    fi
  fi
  hdiutil detach "$mnt" -quiet 2>/dev/null || hdiutil detach "$mnt" -force -quiet 2>/dev/null
  rmdir "$mnt" 2>/dev/null
  return $rc
}

echo; echo "[1/4] ArtCraft Launcher $LAUNCHER_VER"
L="artcraft-launcher-$LAUNCHER_VER-macos-universal.dmg"
if [ ! -f "$CACHE/$L" ] || [ "$(shasum -a 256 "$CACHE/$L" | cut -d' ' -f1)" != "$LAUNCHER_SHA" ]; then
  curl -fL --progress-bar -o "$CACHE/$L" "https://github.com/storytold/craft-launcher/releases/download/v$LAUNCHER_VER/$L"
fi
if [ "$(shasum -a 256 "$CACHE/$L" | cut -d' ' -f1)" = "$LAUNCHER_SHA" ]; then install_dmg "$CACHE/$L" || FAILS=$((FAILS+1))
else echo "  ! launcher checksum mismatch, not installed"; FAILS=$((FAILS+1)); fi

echo; echo "[2/4] Craft apps + their command-line/MCP tools"
for a in $APPS; do
  tag=$(latest_tag "$a"); ver=${tag#v}
  [ -z "$tag" ] && { echo "$a: ! could not reach GitHub"; FAILS=$((FAILS+1)); continue; }
  echo "$a $ver"
  dmg="$a-$ver-macos-universal.dmg"
  { fetch_verified "$a" "$tag" "$dmg" && install_dmg "$CACHE/$dmg"; } || FAILS=$((FAILS+1))
  # CLI (MCP server)
  if [ "$(cat "$CRAFT_DIR/$a/.version" 2>/dev/null)" != "$ver" ]; then
    zip="$a-cli-$ver-macos-universal.zip"
    if fetch_verified "$a" "$tag" "$zip"; then
      rm -rf "$CRAFT_DIR/$a"; mkdir -p "$CRAFT_DIR/$a"
      ditto -x -k "$CACHE/$zip" "$CRAFT_DIR/$a" && echo "$ver" > "$CRAFT_DIR/$a/.version" && echo "  ✓ $a-cli $ver"
    else FAILS=$((FAILS+1)); fi
  else echo "  ✓ $a-cli $ver (already in place)"; fi
  cli=$(ls "$CRAFT_DIR/$a"/*/"$a-cli" 2>/dev/null | head -1)
  if [ -n "$cli" ]; then
    chmod +x "$cli"; xattr -dr com.apple.quarantine "$CRAFT_DIR/$a" 2>/dev/null
    ln -sfn "$cli" "$CRAFT_DIR/bin/$a-cli"
  fi
done

echo; echo "[3/4] Registering MCP servers with Claude"
J="$CRAFT_DIR/mcp-servers.json"
{
  echo '{ "mcpServers": {'
  first=1
  for a in $APPS; do
    [ -x "$CRAFT_DIR/bin/$a-cli" ] || continue
    [ $first -eq 1 ] || echo ','; first=0
    args='"mcp"'
    case " $ROOTED " in *" $a "*) args="\"mcp\", \"--automation-read-root\", \"$WORKSPACE\", \"--automation-write-root\", \"$WORKSPACE\"";; esac
    printf '  "%s": { "command": "%s", "args": [%s] }' "$a" "$CRAFT_DIR/bin/$a-cli" "$args"
  done
  echo; echo '} }'
} > "$J"
mkdir -p "$CFG_DIR"
[ -f "$CFG" ] && cp "$CFG" "$CFG.backup-$(date +%Y%m%d-%H%M%S)" && echo "  backed up existing Claude config"
/usr/bin/osascript -l JavaScript - "$CFG" "$J" <<'JXA'
function run(argv) {
  ObjC.import('Foundation');
  var fm = $.NSFileManager.defaultManager;
  function rd(p) { return $.NSString.stringWithContentsOfFileEncodingError($(p), $.NSUTF8StringEncoding, null).js; }
  var cfg = {};
  if (fm.fileExistsAtPath($(argv[0]))) { var t = rd(argv[0]); if (t && t.trim()) cfg = JSON.parse(t); }
  cfg.mcpServers = cfg.mcpServers || {};
  var add = JSON.parse(rd(argv[1])).mcpServers, n = 0;
  for (var k in add) { cfg.mcpServers[k] = add[k]; n++; }
  $(JSON.stringify(cfg, null, 2)).writeToFileAtomicallyEncodingError($(argv[0]), true, $.NSUTF8StringEncoding, null);
  return '  ✓ registered ' + n + ' Craft MCP servers (other servers left untouched)';
}
JXA

echo; echo "[4/4] Testing each MCP server"
for a in $APPS; do
  bin="$CRAFT_DIR/bin/$a-cli"; [ -x "$bin" ] || { echo "  ! $a: no CLI"; FAILS=$((FAILS+1)); continue; }
  extra=""; case " $ROOTED " in *" $a "*) extra="--automation-read-root $WORKSPACE --automation-write-root $WORKSPACE";; esac
  out=$(printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"craft-setup","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    | perl -e 'alarm 30; exec @ARGV' "$bin" mcp $extra 2>/dev/null)
  n=$(printf '%s' "$out" | grep -o '"inputSchema"' | wc -l | tr -d ' ')
  if [ "${n:-0}" -gt 0 ]; then echo "  ✓ $a: MCP OK, $n tools"; else echo "  ! $a: MCP did not answer"; FAILS=$((FAILS+1)); fi
done

echo
if [ $FAILS -eq 0 ]; then echo "ALL DONE ✓  Quit and reopen the Claude app to load the Craft tools."
else echo "Finished with $FAILS problem(s) — see messages above / $LOG"; fi
echo "Files for the apps to read/write via Claude go in: $WORKSPACE"
echo "=== end $(date) ==="
