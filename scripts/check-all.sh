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

sh "$ROOT_DIR/scripts/test-setup-dev.sh"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "Missing $VENV_DIR. Run ./scripts/setup-dev.sh first." >&2
  exit 1
fi

# The hub server test serves this ignored output, which is absent in a fresh clone.
npm --prefix "$ROOT_DIR/hub/admin" run build
npm --prefix "$ROOT_DIR/hub" test
npm --prefix "$ROOT_DIR/hub" run typecheck
npm --prefix "$ROOT_DIR/hub" run build

npm --prefix "$ROOT_DIR/hub/admin" test
npm --prefix "$ROOT_DIR/hub/admin" run typecheck
npm --prefix "$ROOT_DIR/hub/admin" run lint
npm --prefix "$ROOT_DIR/hub/admin" run build

npm --prefix "$ROOT_DIR/relay" test
npm --prefix "$ROOT_DIR/relay" run typecheck
npm --prefix "$ROOT_DIR/relay" run build

npm --prefix "$ROOT_DIR/clients/sender" test
npm --prefix "$ROOT_DIR/clients/sender" run typecheck
npm --prefix "$ROOT_DIR/clients/sender" run build

npm --prefix "$ROOT_DIR/clients/mcp" test
npm --prefix "$ROOT_DIR/clients/mcp" run typecheck
npm --prefix "$ROOT_DIR/clients/mcp" run build

npm --prefix "$ROOT_DIR/integrations/claude/assistant" test
npm --prefix "$ROOT_DIR/integrations/claude/assistant" run typecheck
npm --prefix "$ROOT_DIR/integrations/claude/assistant" run build
sh "$ROOT_DIR/integrations/claude/hooks/test_hooks.sh"

"$VENV_DIR/bin/python" -m unittest discover -s "$ROOT_DIR/integrations/meshtastic" -p 'test_*.py'
"$VENV_DIR/bin/python" -m mkdocs build --strict --config-file "$ROOT_DIR/mkdocs.yml"

if (
  unset ADMIN_PASSWORD PUBLIC_URL
  docker compose --env-file /dev/null -f "$ROOT_DIR/docker-compose.example.yml" config >/dev/null 2>&1
); then
  echo "Compose validation unexpectedly accepted missing ADMIN_PASSWORD and PUBLIC_URL." >&2
  exit 1
fi
ADMIN_PASSWORD=check-only-password PUBLIC_URL=http://192.0.2.10:8484 \
  docker compose --env-file /dev/null -f "$ROOT_DIR/docker-compose.example.yml" config >/dev/null

"$ROOT_DIR/apps/android/gradlew" -p "$ROOT_DIR/apps/android" test

echo "All contributor checks passed."
