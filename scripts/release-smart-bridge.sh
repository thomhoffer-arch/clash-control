#!/usr/bin/env bash
# ── Release Smart Bridge ─────────────────────────────────────────
# Builds standalone binaries and publishes a GitHub release.
#
# Usage:
#   ./scripts/release-smart-bridge.sh           # uses version from mcp-server/package.json
#   ./scripts/release-smart-bridge.sh 0.2.0     # override version
#
# Prerequisites:
#   - Node.js + npm installed
#   - gh CLI installed and authenticated (brew install gh / winget install GitHub.cli)

set -euo pipefail

REPO="clashcontrol-io/ClashControlSmartBridge"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MCP_DIR="$PROJECT_DIR/mcp-server"
DIST_DIR="$MCP_DIR/dist"

# ── Version ──────────────────────────────────────────────────────

if [ -n "${1:-}" ]; then
  VERSION="$1"
else
  VERSION=$(node -p "require('$MCP_DIR/package.json').version")
fi
TAG="v$VERSION"

echo "══════════════════════════════════════════════════"
echo "  Smart Bridge Release — $TAG"
echo "══════════════════════════════════════════════════"
echo ""

# ── Check prerequisites ─────────────────────────────────────────

if ! command -v gh &>/dev/null; then
  echo "✗ gh CLI not found. Install: brew install gh / winget install GitHub.cli"
  exit 1
fi

if ! gh auth status &>/dev/null 2>&1; then
  echo "✗ gh CLI not authenticated. Run: gh auth login"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "✗ Node.js not found."
  exit 1
fi

echo "✓ Prerequisites OK"
echo ""

# ── Install dependencies ─────────────────────────────────────────

echo "→ Installing dependencies..."
cd "$MCP_DIR"
npm install --silent

# ── Build binaries ───────────────────────────────────────────────

echo "→ Building standalone binaries with pkg..."
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

npx --yes pkg smart-bridge.js \
  --targets node18-win-x64,node18-macos-x64,node18-linux-x64 \
  --output "$DIST_DIR/clashcontrol-smart-bridge" \
  --compress GZip

# pkg appends platform suffixes: -win.exe, -macos, -linux
echo ""

# ── Package tar.gz for macOS/Linux ───────────────────────────────

echo "→ Packaging archives..."
cd "$DIST_DIR"

# macOS
if [ -f "clashcontrol-smart-bridge-macos" ]; then
  chmod +x clashcontrol-smart-bridge-macos
  tar -czf clashcontrol-smart-bridge-mac.tar.gz clashcontrol-smart-bridge-macos
  echo "  ✓ clashcontrol-smart-bridge-mac.tar.gz"
fi

# Linux
if [ -f "clashcontrol-smart-bridge-linux" ]; then
  chmod +x clashcontrol-smart-bridge-linux
  tar -czf clashcontrol-smart-bridge-linux.tar.gz clashcontrol-smart-bridge-linux
  echo "  ✓ clashcontrol-smart-bridge-linux.tar.gz"
fi

# Windows (keep .exe as-is)
if [ -f "clashcontrol-smart-bridge-win.exe" ]; then
  echo "  ✓ clashcontrol-smart-bridge-win.exe"
fi

echo ""

# ── Update version in addon + package.json ───────────────────────

echo "→ Updating version to $VERSION..."
cd "$MCP_DIR"

# Update package.json version
node -e "
  var fs = require('fs');
  var pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Update release tag in smart-bridge addon
ADDON="$PROJECT_DIR/addons/smart-bridge.js"
if [ -f "$ADDON" ]; then
  sed -i.bak "s|var _releaseTag = '[^']*'|var _releaseTag = '$TAG'|" "$ADDON"
  rm -f "$ADDON.bak"
  echo "  ✓ addon _releaseTag → $TAG"
fi

echo ""

# ── List release files ───────────────────────────────────────────

echo "→ Release files:"
ls -lh "$DIST_DIR"/*.exe "$DIST_DIR"/*.tar.gz 2>/dev/null || true
echo ""

# ── Confirm ──────────────────────────────────────────────────────

read -p "Publish $TAG to $REPO? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted. Files are in $DIST_DIR"
  exit 0
fi

# ── Create GitHub release ────────────────────────────────────────

echo "→ Creating GitHub release $TAG..."

RELEASE_FILES=()
[ -f "$DIST_DIR/clashcontrol-smart-bridge-win.exe" ] && RELEASE_FILES+=("$DIST_DIR/clashcontrol-smart-bridge-win.exe")
[ -f "$DIST_DIR/clashcontrol-smart-bridge-mac.tar.gz" ] && RELEASE_FILES+=("$DIST_DIR/clashcontrol-smart-bridge-mac.tar.gz")
[ -f "$DIST_DIR/clashcontrol-smart-bridge-linux.tar.gz" ] && RELEASE_FILES+=("$DIST_DIR/clashcontrol-smart-bridge-linux.tar.gz")

gh release create "$TAG" \
  --repo "$REPO" \
  --title "Smart Bridge $TAG" \
  --notes "$(cat <<NOTES
## ClashControl Smart Bridge $TAG

LLM bridge — connect Claude, ChatGPT, or any AI assistant to control ClashControl with natural language.

### One-click setup
1. Open ClashControl → Navigator → Addons → **Enable Smart Bridge**
2. The binary downloads and connects automatically
3. Green dot = ready

### Connect your AI
- **Claude Desktop:** Click *Copy Claude Config* in the addon panel, paste into your config file, restart Claude
- **ChatGPT:** Create a custom GPT → Actions → Import URL → \`http://localhost:19803/openapi.json\`
- **Any LLM:** \`POST http://localhost:19803/call/{tool}\` — [view tools](http://localhost:19803/tools)

### Manual download
Run the binary for your platform. It starts a local bridge server (ports 19802 + 19803).
NOTES
)" \
  "${RELEASE_FILES[@]}"

echo ""
echo "══════════════════════════════════════════════════"
echo "  ✓ Published: https://github.com/$REPO/releases/tag/$TAG"
echo "══════════════════════════════════════════════════"

# ── Commit version bump ──────────────────────────────────────────

echo ""
echo "→ Don't forget to commit the version bump:"
echo "  git add mcp-server/package.json addons/smart-bridge.js"
echo "  git commit -m 'Bump Smart Bridge to $TAG'"
