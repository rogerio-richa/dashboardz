#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VENV_DIR="$ROOT_DIR/.venv"

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
case "$node_major" in
  ''|*[!0-9]*)
    echo "Unable to determine the Node.js version. Install Node.js 22 or newer and try again." >&2
    exit 1
    ;;
esac
if [ "$node_major" -lt 22 ]; then
  echo "Dashboardz requires Node.js 22 or newer (found Node.js $node_major). Install Node.js 22 and try again." >&2
  exit 1
fi

for package_dir in \
  "$ROOT_DIR/hub" \
  "$ROOT_DIR/hub/admin" \
  "$ROOT_DIR/relay" \
  "$ROOT_DIR/clients/sender" \
  "$ROOT_DIR/clients/mcp" \
  "$ROOT_DIR/integrations/claude/assistant"
do
  npm --prefix "$package_dir" ci
done

if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/python" -m pip install -r "$ROOT_DIR/integrations/meshtastic/requirements.txt"
"$VENV_DIR/bin/python" -m pip install -r "$ROOT_DIR/docs/requirements.txt"

# Hub tests serve the ignored admin bundle, so always create it on a clean checkout.
npm --prefix "$ROOT_DIR/hub/admin" run build
# The repo-local MCP configuration starts this ignored compiled entrypoint.
npm --prefix "$ROOT_DIR/clients/mcp" run build

echo "Development environment ready. Run ./scripts/check-all.sh to verify it."
