#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$ENV_FILE"
}

port="$(read_env_value PHANTOM_PORT)"
port="${port:-3100}"
if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  printf 'Invalid PHANTOM_PORT in %s\n' "$ENV_FILE" >&2
  exit 2
fi
command -v curl >/dev/null || { printf 'curl is required for backups\n' >&2; exit 2; }
command -v python3 >/dev/null || { printf 'python3 is required to validate backups\n' >&2; exit 2; }

umask 077
backup_dir="$SCRIPT_DIR/backups"
mkdir -p -- "$backup_dir"
chmod 700 "$backup_dir"
temporary="$(mktemp "$backup_dir/.backup.XXXXXX")"
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT

if ! curl --connect-timeout 5 --max-time 60 --fail --silent --show-error --output "$temporary" "http://127.0.0.1:${port}/api/backup"; then
  printf 'Could not retrieve application backup; no backup was saved\n' >&2
  exit 1
fi
if ! python3 - "$temporary" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as backup_file:
        backup = json.load(backup_file)
    valid = (
        isinstance(backup, dict)
        and backup.get("version") == 1
        and all(isinstance(backup.get(key), list) for key in ("stats", "habits", "entries"))
    )
except (OSError, json.JSONDecodeError):
    valid = False

if not valid:
    print("Application returned an invalid backup document", file=sys.stderr)
    sys.exit(1)
PY
then
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$backup_dir/phantom-${timestamp}.json"
if [[ -e "$destination" ]]; then
  destination="$backup_dir/phantom-${timestamp}-$(date -u +%N).json"
fi
chmod 600 "$temporary"
mv -- "$temporary" "$destination"
printf 'Backup saved: %s\n' "$destination"
