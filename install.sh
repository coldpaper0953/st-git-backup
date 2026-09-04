#!/usr/bin/env sh
# ============================================================
#  ST Git Backup - one-click server plugin installer (Linux/macOS)
#  Run from the installed UI extension folder:
#  SillyTavern/public/scripts/extensions/third-party/st-git-backup/
# ============================================================
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
ST_ROOT="$(cd "$SRC/../../../../.." && pwd)"

if [ ! -f "$ST_ROOT/config.yaml" ]; then
    echo "[X] config.yaml not found under: $ST_ROOT"
    echo "    Run this script from the installed extension folder."
    exit 1
fi

DEST="$ST_ROOT/plugins/st-git-backup"
echo "Copying server plugin to: $DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
rm -rf "$DEST/.git"

echo "Enabling server plugins in config.yaml..."
sed -i.bak 's/^enableServerPlugins:[[:space:]]*false[[:space:]]*$/enableServerPlugins: true/' "$ST_ROOT/config.yaml" && rm -f "$ST_ROOT/config.yaml.bak"

if grep -q '^enableServerPlugins: true' "$ST_ROOT/config.yaml"; then
    echo "[OK] enableServerPlugins is enabled."
else
    echo "[!] Please open config.yaml and set:  enableServerPlugins: true"
fi

echo ""
echo "=============================================="
echo " Done! Now:"
echo "   1. Restart SillyTavern"
echo "   2. Open the Extensions panel, find 'Git Backup & Restore'"
echo "   3. Fill in your repository URL and click Save / Backup"
echo "=============================================="
