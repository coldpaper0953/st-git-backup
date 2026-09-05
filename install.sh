#!/usr/bin/env sh
# ============================================================
#  ST Git Backup - one-click server plugin installer (Linux/macOS)
#  Run from the installed extension folder. Finds the SillyTavern
#  root by walking up to config.yaml — works for extensions under
#  public/scripts/extensions/third-party/ or data/<user>/extensions/.
# ============================================================
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
DIR="$SRC"
ST_ROOT=""
i=0
while [ $i -lt 10 ]; do
    if [ -f "$DIR/config.yaml" ]; then
        ST_ROOT="$DIR"
        break
    fi
    DIR="$(cd "$DIR/.." && pwd)"
    i=$((i + 1))
done

if [ -z "$ST_ROOT" ]; then
    echo "[X] Could not find config.yaml walking up from: $SRC"
    echo "    Manual steps: copy this folder to SillyTavern/plugins/st-git-backup/"
    echo "    then set enableServerPlugins: true in config.yaml."
    exit 1
fi

echo "SillyTavern root: $ST_ROOT"
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
echo "   2. Open the Extensions panel, find '云端备份与恢复'"
echo "   3. Paste your GitHub/Gitee token and click '开始使用'"
echo "=============================================="
