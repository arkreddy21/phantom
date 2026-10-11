#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SUFFIX="${USER:-user}-$$"
SUFFIX="${SUFFIX//[^a-zA-Z0-9_-]/-}"
PORT="${PHANTOM_SMOKE_PORT:-39167}"
ORIGIN='https://phantom.example.com'
TEMP_DIR="$(mktemp -d)"
CONTAINER=''
VOLUME=''
CREATED_CONTAINER=0
CREATED_VOLUME=0

cleanup() {
  if (( CREATED_CONTAINER )); then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  if (( CREATED_VOLUME )); then docker volume rm "$VOLUME" >/dev/null 2>&1 || true; fi
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() { [[ "$1" == "$2" ]] || fail "$3 (expected '$2', got '$1')"; }

for arch in amd64 arm64; do
  image="phantom:verified-${arch}"
  case "$arch" in amd64) docker_arch=amd64 ;; arm64) docker_arch=arm64 ;; esac
  # Always build from the current source tree, never silently test an old local tag.
  docker buildx build --platform "linux/${docker_arch}" --load -t "$image" "$ROOT"
  actual_arch="$(docker image inspect "$image" --format '{{.Architecture}}')"
  expect "$actual_arch" "$docker_arch" "$arch image architecture"

  CONTAINER="phantom-smoke-${SUFFIX}-${arch}"
  VOLUME="phantom-smoke-${SUFFIX}-${arch}-data"
  docker volume inspect "$VOLUME" >/dev/null 2>&1 && fail "refusing to reuse existing volume $VOLUME"
  docker container inspect "$CONTAINER" >/dev/null 2>&1 && fail "refusing to reuse existing container $CONTAINER"
  docker volume create "$VOLUME" >/dev/null
  CREATED_VOLUME=1

  start_container() {
    docker run --platform "linux/${docker_arch}" -d --name "$CONTAINER" \
      --publish "127.0.0.1:${PORT}:3001" \
      --mount "type=volume,src=${VOLUME},dst=/app/data" \
      --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
      --cap-drop ALL --security-opt no-new-privileges --init --memory 512m --cpus 1 \
      --env "PUBLIC_ORIGIN=${ORIGIN}" "$image" >/dev/null
    CREATED_CONTAINER=1
  }

  wait_healthy() {
    local count=0 health
    while (( count < 40 )); do
      health="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)"
      [[ "$health" == healthy ]] && return 0
      [[ "$health" == unhealthy ]] && docker logs "$CONTAINER" >&2 && fail "$arch container became unhealthy"
      sleep 1
      count=$((count + 1))
    done
    docker logs "$CONTAINER" >&2 || true
    fail "$arch container did not become healthy within 40 seconds"
  }

  api() { curl --fail --silent --show-error "$@"; }

  start_container
  wait_healthy
  expect "$(docker inspect --format '{{.Config.User}}' "$CONTAINER")" node "$arch container must run as nonroot node user"
  expect "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$CONTAINER")" true "$arch read-only root filesystem"
  expect "$(docker inspect --format '{{.HostConfig.Init}}' "$CONTAINER")" true "$arch init process"
  expect "$(docker inspect --format '{{.HostConfig.Memory}}' "$CONTAINER")" 536870912 "$arch memory limit"
  expect "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$CONTAINER")" 1000000000 "$arch CPU limit"
  [[ "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$CONTAINER")" == *ALL* ]] || fail "$arch: all Linux capabilities must be dropped"
  [[ "$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$CONTAINER")" == *'"/tmp"'* ]] || fail "$arch: /tmp must be a tmpfs"
  docker exec "$CONTAINER" node -e 'require("node:fs").writeFileSync("/tmp/smoke", "ok")'
  if docker exec "$CONTAINER" node -e 'require("node:fs").writeFileSync("/app/read-only-smoke", "bad")' >/dev/null 2>&1; then
    fail "$arch: application root filesystem unexpectedly writable"
  fi

  base="http://127.0.0.1:${PORT}"
  health="$(api "$base/api/health")"
  [[ "$health" == *'"status":"ok"'* ]] || fail "$arch: unexpected health response: $health"
  html="$(api "$base/")"
  [[ "$html" == *'<html'* && "$html" == *'/assets/'* ]] || fail "$arch: production HTML or built asset reference missing"
  asset="$(printf '%s' "$html" | grep -oE '/assets/[^" ]+\.(js|css)' | head -n 1)"
  [[ -n "$asset" ]] || fail "$arch: could not find production JS/CSS asset URL"
  asset_response="$(api "$base$asset")"
  [[ -n "$asset_response" ]] || fail "$arch: built production asset was empty"

  habit_payload='{"name":"Container persistence check","kind":"check","statId":"knowledge","points":13}'
  journal_payload='{"name":"Container journal check","kind":"journal","statId":"kindness","points":7,"prompt":"Journal entry"}'
  api -X POST -H 'content-type: application/json' -H "Origin: ${ORIGIN}" --data "$habit_payload" "$base/api/habits" > "$TEMP_DIR/habit.json"
  api -X POST -H 'content-type: application/json' -H "Origin: ${ORIGIN}" --data "$journal_payload" "$base/api/habits" > "$TEMP_DIR/journal.json"
  habit_id="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).id)' "$TEMP_DIR/habit.json")"
  journal_id="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).id)' "$TEMP_DIR/journal.json")"
  entry_date="$(date -u +%F)"
  entry_payload='{"completed":true,"content":"Persistent journal text for the container smoke test"}'
  api -X PUT -H 'content-type: application/json' -H "Origin: ${ORIGIN}" --data "$entry_payload" \
    "$base/api/entries/${journal_id}/${entry_date}" > "$TEMP_DIR/entry.json"
  denied="$(curl --silent --output /dev/null --write-out '%{http_code}' -X POST \
    -H 'content-type: application/json' -H 'Origin: https://wrong.example.com' \
    --data "$habit_payload" "$base/api/habits")"
  expect "$denied" 403 "$arch wrong origin must be rejected"

  backup="$(api "$base/api/backup")"
  [[ "$backup" == *"$habit_id"* && "$backup" == *"$journal_id"* && "$backup" == *'Persistent journal text for the container smoke test'* ]] || fail "$arch: backup export omitted test records or journal content"
  restored="$(api -X POST -H 'content-type: application/json' -H "Origin: ${ORIGIN}" --data "$backup" "$base/api/backup")"
  [[ "$restored" == *"$habit_id"* && "$restored" == *"$journal_id"* && "$restored" == *'Persistent journal text for the container smoke test'* ]] || fail "$arch: backup import response omitted test records"

  docker rm -f "$CONTAINER" >/dev/null
  CREATED_CONTAINER=0
  start_container
  wait_healthy
  state="$(api "$base/api/state")"
  [[ "$state" == *"$habit_id"* && "$state" == *"$journal_id"* && "$state" == *'Persistent journal text for the container smoke test'* ]] || fail "$arch: habit or dated journal entry did not persist after container recreation"
  printf 'PASS: %s API, HTML/assets, PUBLIC_ORIGIN, backup import/export, hardening, dated journal persistence (image %s)\n' "$arch" "$(docker image inspect "$image" --format '{{.Id}}')"

  docker rm -f "$CONTAINER" >/dev/null
  CREATED_CONTAINER=0
  docker volume rm "$VOLUME" >/dev/null
  CREATED_VOLUME=0
done
