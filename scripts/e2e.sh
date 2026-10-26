#!/usr/bin/env bash
# End-to-end check with two isolated OpenCode servers and a temporary Git remote.
#
# Requires: bun, git, jq, opencode.
# Usage: bash scripts/e2e.sh
# Set KEEP_E2E=1 to keep the temporary directory for inspection.

set -euo pipefail
unset OPENCODE_PASSWORD || true
export PATH="$HOME/.bun/bin:$PATH"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

command -v bun >/dev/null || { echo "bun is required"; exit 1; }
command -v git >/dev/null || { echo "git is required"; exit 1; }
command -v jq >/dev/null || { echo "jq is required"; exit 1; }
command -v opencode >/dev/null || { echo "opencode is required"; exit 1; }

ROOT="$(mktemp -d /tmp/opencode/ocsync-e2e-XXXXXX)"
A="$ROOT/project-a"
B="$ROOT/project-b"
DATA="$ROOT/data.git"
PORT_A=$((4700 + ($$ % 100)))
PORT_B=$((PORT_A + 1))
PID_A=""
PID_B=""

cleanup() {
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null || true
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null || true
  if [ "${KEEP_E2E:-0}" = "1" ]; then
    echo "kept $ROOT"
  else
    rm -rf "$ROOT"
  fi
}
trap cleanup EXIT

mkdir -p "$A" "$B" "$ROOT/config-a" "$ROOT/config-b" "$ROOT/data-a" "$ROOT/data-b" "$ROOT/state-a" "$ROOT/state-b"
git init -q --bare "$DATA"
for dir in "$A" "$B"; do
  git init -q -b main "$dir"
  git -C "$dir" remote add origin "https://github.com/alv67/ocsync-e2e.git"
done

cat > "$ROOT/config-a.jsonc" <<EOF
{
  "remote": "$DATA",
  "branch": "main",
  "device": "dev_e2e_a",
  "keyFile": "$ROOT/key",
  "pullIntervalSec": 0,
  "pushDebounceSec": 0,
  "maxSessionBytes": 10000000
}
EOF
cat > "$ROOT/config-b.jsonc" <<EOF
{
  "remote": "$DATA",
  "branch": "main",
  "device": "dev_e2e_b",
  "keyFile": "$ROOT/key",
  "pullIntervalSec": 0,
  "pushDebounceSec": 0,
  "maxSessionBytes": 10000000
}
EOF
bun src/cli.ts key init --config "$ROOT/config-a.jsonc" >/dev/null

OPENCODE_DB="$ROOT/opencode-a.db" XDG_CONFIG_HOME="$ROOT/config-a" \
  opencode serve --hostname 127.0.0.1 --port "$PORT_A" > "$ROOT/server-a.log" 2>&1 &
PID_A=$!
for _ in $(seq 1 50); do grep -q 'server password' "$ROOT/server-a.log" && break; sleep 0.2; done
PW_A=$(awk '/server password/{print $3}' "$ROOT/server-a.log")
[ -n "$PW_A" ] || { echo "server A did not start"; exit 1; }

export OPENCODE_PASSWORD="$PW_A"
SESSION=$(opencode api post /api/session --server "http://127.0.0.1:$PORT_A" \
  -d "{\"title\":\"E2E session\",\"location\":{\"directory\":\"$A\"}}" | jq -r '.data.id')

XDG_CONFIG_HOME="$ROOT/config-a" XDG_DATA_HOME="$ROOT/data-a" XDG_STATE_HOME="$ROOT/state-a" \
  bun src/cli.ts push --config "$ROOT/config-a.jsonc" --project "$A" --server "http://127.0.0.1:$PORT_A" --json > "$ROOT/push.json"
[ "$(jq -r '.pushed | length' "$ROOT/push.json")" = "1" ] || { cat "$ROOT/push.json"; exit 1; }

unset OPENCODE_PASSWORD
OPENCODE_DB="$ROOT/opencode-b.db" XDG_CONFIG_HOME="$ROOT/config-b" \
  opencode serve --hostname 127.0.0.1 --port "$PORT_B" > "$ROOT/server-b.log" 2>&1 &
PID_B=$!
for _ in $(seq 1 50); do grep -q 'server password' "$ROOT/server-b.log" && break; sleep 0.2; done
PW_B=$(awk '/server password/{print $3}' "$ROOT/server-b.log")
[ -n "$PW_B" ] || { echo "server B did not start"; exit 1; }

export OPENCODE_PASSWORD="$PW_B"
XDG_CONFIG_HOME="$ROOT/config-b" XDG_DATA_HOME="$ROOT/data-b" XDG_STATE_HOME="$ROOT/state-b" \
  bun src/cli.ts pull --config "$ROOT/config-b.jsonc" --project "$B" --server "http://127.0.0.1:$PORT_B" --json > "$ROOT/pull.json"
[ "$(jq -r '.pulled | length' "$ROOT/pull.json")" = "1" ] || { cat "$ROOT/pull.json"; exit 1; }

opencode session export "$SESSION" --server "http://127.0.0.1:$PORT_B" > "$ROOT/export-b.json"
[ "$(jq -r '.info.id' "$ROOT/export-b.json")" = "$SESSION" ] || { echo "session was not imported"; exit 1; }

echo "E2E OK"
echo "session=$SESSION"
jq -c '{push:.pushed}' "$ROOT/push.json"
jq -c '{pull:.pulled}' "$ROOT/pull.json"
