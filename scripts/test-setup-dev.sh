#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_SETUP=${DASHBOARDZ_SETUP_TEST_SETUP:-$SCRIPT_DIR/setup-dev.sh}
REAL_NODE=$(command -v node)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/dashboardz-setup-smoke.XXXXXX")
FAKE_ROOT="$TEST_ROOT/checkout"
BIN_DIR="$TEST_ROOT/bin"
NPM_LOG="$TEST_ROOT/npm.log"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup 0 1 2 3 15

write_executable() {
  target=$1
  shift
  printf '%s\n' "$@" > "$target"
  chmod +x "$target"
}

mkdir -p "$FAKE_ROOT/scripts" "$BIN_DIR"
FAKE_ROOT=$(CDPATH= cd -- "$FAKE_ROOT" && pwd)
for package_dir in \
  hub \
  hub/admin \
  relay \
  clients/sender \
  clients/mcp \
  integrations/claude/assistant
do
  mkdir -p "$FAKE_ROOT/$package_dir"
done
mkdir -p "$FAKE_ROOT/integrations/meshtastic" "$FAKE_ROOT/docs"
: > "$FAKE_ROOT/integrations/meshtastic/requirements.txt"
: > "$FAKE_ROOT/docs/requirements.txt"
cp "$SOURCE_SETUP" "$FAKE_ROOT/scripts/setup-dev.sh"
chmod +x "$FAKE_ROOT/scripts/setup-dev.sh"

write_executable "$BIN_DIR/node" \
  '#!/bin/sh' \
  'set -eu' \
  'if [ "${1-}" = "-p" ]; then printf "22\\n"; else exec "$DASHBOARDZ_TEST_REAL_NODE" "$@"; fi'

write_executable "$BIN_DIR/venv-python" \
  '#!/bin/sh' \
  'set -eu' \
  'if [ "${1-}" = "-m" ] && [ "${2-}" = "pip" ]; then exit 0; fi' \
  'echo "unexpected venv python invocation: $*" >&2' \
  'exit 1'

write_executable "$BIN_DIR/python3" \
  '#!/bin/sh' \
  'set -eu' \
  'if [ "${1-}" = "-m" ] && [ "${2-}" = "venv" ] && [ -n "${3-}" ]; then' \
  '  mkdir -p "$3/bin"' \
  '  cp "$DASHBOARDZ_TEST_VENV_PYTHON" "$3/bin/python"' \
  '  exit 0' \
  'fi' \
  'echo "unexpected python3 invocation: $*" >&2' \
  'exit 1'

write_executable "$BIN_DIR/npm" \
  '#!/bin/sh' \
  'set -eu' \
  'prefix=' \
  'while [ "$#" -gt 0 ]; do' \
  '  case "$1" in' \
  '    --prefix) prefix=$2; shift 2 ;;' \
  '    *) break ;;' \
  '  esac' \
  'done' \
  'printf "%s\\n" "$prefix $*" >> "$DASHBOARDZ_SETUP_TEST_NPM_LOG"' \
  'if [ "${1-}" = "ci" ]; then exit 0; fi' \
  'if [ "${1-}" = "run" ] && [ "${2-}" = "build" ] && [ "$prefix" = "$DASHBOARDZ_SETUP_TEST_ROOT/hub/admin" ]; then' \
  '  : > "$prefix/.admin-build-marker"' \
  '  exit 0' \
  'fi' \
  'if [ "${1-}" = "run" ] && [ "${2-}" = "build" ] && [ "$prefix" = "$DASHBOARDZ_SETUP_TEST_ROOT/clients/mcp" ]; then' \
  '  mkdir -p "$prefix/dist"' \
  '  printf "%s\\n" "process.stdout.write(\"\")" > "$prefix/dist/cli.js"' \
  '  : > "$prefix/.mcp-build-marker"' \
  '  exit 0' \
  'fi' \
  'echo "unexpected npm invocation: $*" >&2' \
  'exit 1'

export DASHBOARDZ_SETUP_TEST_ROOT="$FAKE_ROOT"
export DASHBOARDZ_SETUP_TEST_NPM_LOG="$NPM_LOG"
export DASHBOARDZ_TEST_REAL_NODE="$REAL_NODE"
export DASHBOARDZ_TEST_VENV_PYTHON="$BIN_DIR/venv-python"
export PATH="$BIN_DIR:$PATH"

outside_dir=/private/tmp
[ -d "$outside_dir" ] || outside_dir=/tmp
(
  cd "$outside_dir"
  "$FAKE_ROOT/scripts/setup-dev.sh"
)

mcp_cli="$FAKE_ROOT/clients/mcp/dist/cli.js"
if [ ! -f "$mcp_cli" ]; then
  echo "MCP setup regression failed: setup did not create clients/mcp/dist/cli.js." >&2
  exit 1
fi
"$REAL_NODE" --check "$mcp_cli"
test -f "$FAKE_ROOT/hub/admin/.admin-build-marker"
grep -F "$FAKE_ROOT/clients/mcp run build" "$NPM_LOG" >/dev/null
grep -F "$FAKE_ROOT/hub/admin run build" "$NPM_LOG" >/dev/null

echo "setup-dev MCP regression passed (outside CWD, admin and MCP builds recorded)."
