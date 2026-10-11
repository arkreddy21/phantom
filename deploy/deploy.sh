#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
LOCK_FILE="$SCRIPT_DIR/.deploy.lock"
CURRENT_COMPOSE="$SCRIPT_DIR/compose.yaml"
CANDIDATE_COMPOSE="$SCRIPT_DIR/compose.next.yaml"

usage() {
  printf 'Usage: %s ghcr.io/<owner>/<image>:(sha-<40 hex>|@sha256:<64 hex>)\n' "$0" >&2
}

image_pattern='^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*'
if (( $# != 1 )) || [[ ! "$1" =~ ${image_pattern}:(sha-[0-9a-fA-F]{40})$ && ! "$1" =~ ${image_pattern}@sha256:[0-9a-fA-F]{64}$ ]]; then
  usage
  exit 2
fi
candidate="$1"

command -v docker >/dev/null || { printf 'docker is required for deployment\n' >&2; exit 2; }
command -v flock >/dev/null || { printf 'flock is required to serialize deployments\n' >&2; exit 2; }
[[ -f "$CURRENT_COMPOSE" ]] || { printf 'Missing current %s\n' "$CURRENT_COMPOSE" >&2; exit 2; }
[[ -f "$CANDIDATE_COMPOSE" ]] || { printf 'Missing uploaded candidate %s\n' "$CANDIDATE_COMPOSE" >&2; exit 2; }
[[ -f "$ENV_FILE" ]] || { printf 'Create %s from .env.example before deploying\n' "$ENV_FILE" >&2; exit 2; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  printf 'Another deployment is already running\n' >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$ENV_FILE"
}

port="$(read_env_value PHANTOM_PORT)"
port="${port:-3100}"
if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  printf 'Invalid PHANTOM_PORT in environment file\n' >&2
  exit 2
fi

image_assignments="$(grep -c '^PHANTOM_IMAGE=' "$ENV_FILE" || true)"
if [[ "$image_assignments" != 1 ]]; then
  printf 'Expected exactly one PHANTOM_IMAGE assignment in %s\n' "$ENV_FILE" >&2
  exit 2
fi
previous="$(read_env_value PHANTOM_IMAGE)"
if [[ ! "$previous" =~ ${image_pattern}:(sha-[0-9a-fA-F]{40})$ && ! "$previous" =~ ${image_pattern}@sha256:[0-9a-fA-F]{64}$ ]]; then
  printf 'PHANTOM_IMAGE must contain a valid immutable rollback image\n' >&2
  exit 2
fi

compose=(docker compose --project-directory "$SCRIPT_DIR" --env-file "$ENV_FILE" -f "$CURRENT_COMPOSE")
if ! "${compose[@]}" ps --all --quiet phantom >/dev/null 2>&1; then
  printf 'Could not inspect the current Compose service\n' >&2
  exit 1
fi
all_ids="$("${compose[@]}" ps --all --quiet phantom)"
if [[ -n "$all_ids" ]]; then
  if ! running_id="$("${compose[@]}" ps --status running --quiet phantom)" || [[ -z "$running_id" ]]; then
    printf 'Refusing deployment: an existing Phantom container is stopped; inspect/recover it before deploying\n' >&2
    exit 1
  fi
  if [[ "$all_ids" != "$running_id" ]]; then
    printf 'Refusing deployment: stopped or extra Phantom containers exist; inspect/recover them before deploying\n' >&2
    exit 1
  fi
  if ! inspection="$(docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}|{{.Config.Image}}' "$running_id" 2>/dev/null)"; then
    printf 'Could not inspect the current Phantom container\n' >&2
    exit 1
  fi
  IFS='|' read -r current_status current_health current_image <<< "$inspection"
  if [[ "$current_status" != running || "$current_health" != healthy ]]; then
    printf 'Refusing deployment: current service is not running and healthy (status=%s health=%s); inspect/recover it before deploying\n' "${current_status:-unknown}" "${current_health:-unknown}" >&2
    exit 1
  fi
  if [[ "$current_image" != "$previous" ]]; then
    printf 'Refusing deployment: running container image %s differs from recorded rollback image %s\n' "${current_image:-unknown}" "$previous" >&2
    exit 1
  fi
  running_id="$running_id"
else
  running_id=""
fi

# Prepare all state files before replacing the running service. Candidate Compose
# stays separate from the active config until the candidate has passed healthchecks.
temporary_env=""
temporary_compose=""
rollback_env=""
rollback_compose=""
cleanup_staged_files() {
  [[ -z "$temporary_env" ]] || rm -f -- "$temporary_env"
  [[ -z "$temporary_compose" ]] || rm -f -- "$temporary_compose"
  [[ -z "$rollback_env" ]] || rm -f -- "$rollback_env"
  [[ -z "$rollback_compose" ]] || rm -f -- "$rollback_compose"
}
trap cleanup_staged_files EXIT

temporary_env="$(mktemp "$SCRIPT_DIR/.env.next.XXXXXX")"
temporary_compose="$(mktemp "$SCRIPT_DIR/.compose.next.XXXXXX")"
rollback_env="$(mktemp "$SCRIPT_DIR/.env.rollback.XXXXXX")"
rollback_compose="$(mktemp "$SCRIPT_DIR/.compose.rollback.XXXXXX")"
awk -v image="$candidate" '/^PHANTOM_IMAGE=/ { print "PHANTOM_IMAGE=" image; next } { print }' "$ENV_FILE" > "$temporary_env"
chmod --reference="$ENV_FILE" "$temporary_env"
cp -- "$CANDIDATE_COMPOSE" "$temporary_compose"
chmod --reference="$CURRENT_COMPOSE" "$temporary_compose"
cp -- "$ENV_FILE" "$rollback_env"
chmod --reference="$ENV_FILE" "$rollback_env"
cp -- "$CURRENT_COMPOSE" "$rollback_compose"
chmod --reference="$CURRENT_COMPOSE" "$rollback_compose"

# Pull first to shorten the window between taking a consistent data backup and
# stopping the existing application.
if ! docker pull "$candidate"; then
  printf 'Failed to pull candidate %s; current image state was not changed\n' "$candidate" >&2
  exit 1
fi

# JSON backup is taken while the current service is still available. Schema/data
# migrations may not be reversible by image rollback; backups are retained outside
# the named volume so operators can restore application data explicitly if needed.
if [[ -n "$running_id" ]]; then
  if ! "$SCRIPT_DIR/backup.sh"; then
    printf 'Backup failed; deployment aborted without stopping the current service\n' >&2
    exit 1
  fi
fi

rollback() {
  local reason="$1"
  printf '%s; attempting rollback\n' "$reason" >&2
  if [[ -z "$previous" ]]; then
    printf 'No previous image is recorded; no rollback was possible\n' >&2
    return 1
  fi
  if PHANTOM_IMAGE="$previous" "${compose[@]}" up -d --wait --wait-timeout 120 phantom; then
    printf 'Rolled back to %s\n' "$previous" >&2
  else
    printf 'Rollback to %s failed; inspect the service and retained backup\n' "$previous" >&2
  fi
  return 1
}

candidate_compose=(docker compose --project-directory "$SCRIPT_DIR" --env-file "$temporary_env" -f "$temporary_compose")
if ! PHANTOM_IMAGE="$candidate" "${candidate_compose[@]}" up -d --wait --wait-timeout 120 phantom; then
  rollback 'Candidate did not become healthy'
  exit 1
fi

if ! curl --connect-timeout 5 --max-time 30 --fail --silent --show-error "http://127.0.0.1:${port}/api/health" >/dev/null; then
  rollback 'Application health endpoint failed after startup'
  exit 1
fi

restore_prior_state() {
  local failed=0
  if ! cp -- "$rollback_compose" "$CURRENT_COMPOSE.restore" || ! mv -f -- "$CURRENT_COMPOSE.restore" "$CURRENT_COMPOSE"; then
    printf 'Could not restore previous Compose config at %s\n' "$CURRENT_COMPOSE" >&2
    failed=1
  fi
  if ! cp -- "$rollback_env" "$ENV_FILE.restore" || ! mv -f -- "$ENV_FILE.restore" "$ENV_FILE"; then
    printf 'Could not restore previous environment at %s\n' "$ENV_FILE" >&2
    failed=1
  fi
  return "$failed"
}

promotion_failed() {
  local reason="$1"
  printf '%s; restoring prior config and attempting rollback\n' "$reason" >&2
  if ! restore_prior_state; then
    printf 'Prior deployment files could not be fully restored; manual recovery is required\n' >&2
  fi
  rollback "$reason"
}

# Promote the new Compose file first, then its matching image state. Any failed
# promotion restores both prior files before rollback runs against old Compose.
if ! mv -f -- "$temporary_compose" "$CURRENT_COMPOSE"; then
  promotion_failed 'Could not promote candidate Compose config'
  exit 1
fi
temporary_compose=""
if ! mv -f -- "$temporary_env" "$ENV_FILE"; then
  promotion_failed 'Could not promote candidate environment'
  exit 1
fi
temporary_env=""
cleanup_staged_files
trap - EXIT
printf 'Deployment healthy: %s\n' "$candidate"
