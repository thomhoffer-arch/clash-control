#!/usr/bin/env bash
# Auto-increment patch version and inject into index.html, README, CHANGELOG
# Called by pre-commit hook — pure bash, no Python dependency

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION_FILE="$REPO_ROOT/version.json"
INDEX_FILE="$REPO_ROOT/index.html"
README_FILE="$REPO_ROOT/README.md"
CHANGELOG_FILE="$REPO_ROOT/CHANGELOG.md"

if [ ! -f "$VERSION_FILE" ]; then
  echo "version.json not found, skipping version bump"
  exit 0
fi

# Check if index.html is being committed
if ! git diff --cached --name-only | grep -q "index.html"; then
  exit 0
fi

# Read current version from version.json (pure bash, no python)
MAJOR=$(grep -o '"major"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
MINOR=$(grep -o '"minor"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
PATCH=$(grep -o '"patch"[[:space:]]*:[[:space:]]*[0-9]*' "$VERSION_FILE" | grep -o '[0-9]*$')
LABEL=$(grep -o '"label"[[:space:]]*:[[:space:]]*"[^"]*"' "$VERSION_FILE" | sed 's/.*: *"//;s/"$//')

# Increment patch
PATCH=$((PATCH + 1))

# Get git short hash and date
GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HUMAN_DATE=$(date -u +"%Y-%m-%d")

# Build version string
VERSION="${MAJOR}.${MINOR}.${PATCH}"
if [ -n "$LABEL" ]; then
  VERSION="${VERSION}-${LABEL}"
fi

# Update version.json (pure bash)
cat > "$VERSION_FILE" << VJSON
{
  "major": ${MAJOR},
  "minor": ${MINOR},
  "patch": ${PATCH},
  "label": "${LABEL}"
}
VJSON
echo "  Version bumped to $VERSION"

# Inject version into index.html
sed -i "s|var CC_VERSION = .*|var CC_VERSION = {v:'${VERSION}',hash:'${GIT_HASH}',date:'${BUILD_DATE}'};|" "$INDEX_FILE"

# Update README version badge
if [ -f "$README_FILE" ]; then
  if grep -q "^> Version:" "$README_FILE"; then
    sed -i "s|^> Version:.*|> Version: **v${VERSION}** (${HUMAN_DATE})|" "$README_FILE"
  else
    sed -i "1 a\\> Version: **v${VERSION}** (${HUMAN_DATE})" "$README_FILE"
  fi
fi

# Auto-append to CHANGELOG: get the commit message being committed
COMMIT_MSG_FILE="$REPO_ROOT/.git/COMMIT_EDITMSG"
if [ -f "$CHANGELOG_FILE" ] && [ -f "$COMMIT_MSG_FILE" ]; then
  COMMIT_SUBJECT=$(head -1 "$COMMIT_MSG_FILE" | sed 's/^ *//')
  if [ -n "$COMMIT_SUBJECT" ] && ! echo "$COMMIT_SUBJECT" | grep -qi "^merge"; then
    if ! grep -q "^## v${VERSION}" "$CHANGELOG_FILE"; then
      sed -i "/^# Changelog/a\\\\n## v${VERSION} (${HUMAN_DATE})\\n- ${COMMIT_SUBJECT}" "$CHANGELOG_FILE"
    fi
  fi
fi

# Re-stage the modified files
git add "$VERSION_FILE" "$INDEX_FILE"
[ -f "$README_FILE" ] && git add "$README_FILE"
[ -f "$CHANGELOG_FILE" ] && git add "$CHANGELOG_FILE"

echo "  Version: $VERSION (${GIT_HASH}, ${BUILD_DATE})"
