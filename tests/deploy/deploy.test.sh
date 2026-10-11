#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_A='ghcr.io/example-owner/phantom:sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
IMAGE_B='ghcr.io/example-owner/phantom@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_ROOT"' EXIT
pass_count=0

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "$3 (expected '$2', got '$1')"; }

setup() {
  local name="$1"
  TEST_DIR="$TEMP_ROOT/$name"
  mkdir -p "$TEST_DIR/bin"
  cp "$ROOT/deploy/deploy.sh" "$ROOT/deploy/backup.sh" "$ROOT/deploy/compose.yaml" "$TEST_DIR/"
  cp "$ROOT/deploy/compose.yaml" "$TEST_DIR/compose.next.yaml"
  printf '\nmarker: current\n' >> "$TEST_DIR/compose.yaml"
  printf '\nmarker: candidate\n' >> "$TEST_DIR/compose.next.yaml"
  chmod +x "$TEST_DIR/deploy.sh" "$TEST_DIR/backup.sh"
  printf 'PHANTOM_IMAGE=%s\nPHANTOM_PORT=3100\nPUBLIC_ORIGIN=https://phantom.example.com\n' "$IMAGE_A" > "$TEST_DIR/.env"
  : > "$TEST_DIR/docker.log"
  cat > "$TEST_DIR/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -e
printf 'docker %s PHANTOM_IMAGE=%s\n' "$*" "${PHANTOM_IMAGE:-}" >> "$TEST_DIR/docker.log"
if [[ "$1" == pull ]]; then
  [[ "${PULL_FAIL:-0}" != 1 ]]
  exit
fi
if [[ "$1" == inspect ]]; then
  printf '%s|%s|%s\n' "${CURRENT_STATUS:-running}" "${CURRENT_HEALTH:-healthy}" "${CURRENT_IMAGE:-$IMAGE_A}"
  exit
fi
if [[ "$1" == compose ]]; then
  case " $* " in
    *' ps '*)
      if [[ " $* " == *' --all '* ]]; then
        [[ "${EXISTING_CONTAINER:-1}" == 1 ]] && printf 'phantom-container\n'
      else
        [[ "${RUNNING:-1}" == 1 ]] && printf 'phantom-container\n'
      fi
      ;;
    *' up '* )
      compose_file=''
      previous=''
      for arg in "$@"; do
        if [[ "$previous" == -f ]]; then compose_file="$arg"; fi
        previous="$arg"
      done
      printf 'up file=%s image=%s\n' "$compose_file" "${PHANTOM_IMAGE:-}" >> "$TEST_DIR/up.log"
      if [[ -n "$compose_file" && -f "$compose_file" ]]; then
        printf 'content=%s\n' "$(grep '^marker:' "$compose_file" || true)" >> "$TEST_DIR/up.log"
      fi
      [[ "${COMPOSE_UP_FAIL_IMAGE:-}" != "${PHANTOM_IMAGE:-}" ]]
      ;;
    *) exit 3 ;;
  esac
  exit
fi
exit 3
MOCK
  cat > "$TEST_DIR/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -e
if [[ "${BACKUP_FAIL:-0}" == 1 ]]; then exit 22; fi
output=''
last=''
while (( $# )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) last="$1"; shift ;;
  esac
done
if [[ "$last" == */api/backup ]]; then
  printf '{"version":1,"stats":[],"habits":[],"entries":[]}\n' > "$output"
elif [[ "$last" == */api/health && "${HEALTH_FAIL:-0}" == 1 ]]; then
  exit 22
fi
MOCK
  cat > "$TEST_DIR/bin/mv" <<'MOCK'
#!/usr/bin/env bash
set -e
destination="${!#}"
if [[ "${MV_FAIL_DEST:-}" == "$destination" ]]; then
  marker="$TEST_DIR/.mv-failed-once"
  if [[ ! -e "$marker" ]]; then
    : > "$marker"
    printf 'mock mv failure to %s\n' "$destination" >&2
    exit 1
  fi
fi
exec /bin/mv "$@"
MOCK
  cat > "$TEST_DIR/bin/chmod" <<'MOCK'
#!/usr/bin/env bash
set -e
if [[ "${CHMOD_FAIL:-0}" == 1 && "${!#}" == *.env.next.* ]]; then exit 1; fi
exec /bin/chmod "$@"
MOCK
  chmod +x "$TEST_DIR/bin/docker" "$TEST_DIR/bin/curl" "$TEST_DIR/bin/mv" "$TEST_DIR/bin/chmod"
export TEST_DIR
export IMAGE_A
export PATH="$TEST_DIR/bin:$PATH"
 unset RUNNING EXISTING_CONTAINER PULL_FAIL COMPOSE_UP_FAIL_IMAGE BACKUP_FAIL HEALTH_FAIL CURRENT_HEALTH CURRENT_STATUS CURRENT_IMAGE MV_FAIL_DEST CHMOD_FAIL || true
}

run_deploy() {
  (cd "$TEST_DIR" && ./deploy.sh "$@")
}

setup invalid
if run_deploy 'ghcr.io/example-owner/phantom:latest' >/dev/null 2>&1; then fail 'mutable tag should be rejected'; fi
assert_eq "$(wc -l < "$TEST_DIR/docker.log" | tr -d ' ')" 0 'invalid image must be rejected before Docker'
pass_count=$((pass_count + 1))

setup prior_unhealthy
if CURRENT_HEALTH=starting run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'unhealthy prior service should block deployment'; fi
if grep -F 'docker pull' "$TEST_DIR/docker.log" >/dev/null; then fail 'unhealthy prior service must abort before pull'; fi
assert_eq "$(grep '^PHANTOM_IMAGE=' "$TEST_DIR/.env" | cut -d= -f2-)" "$IMAGE_A" 'unhealthy prior service preserves image state'
pass_count=$((pass_count + 1))

setup prior_stopped
if RUNNING=0 run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'stopped prior service should block deployment'; fi
if grep -F 'docker pull' "$TEST_DIR/docker.log" >/dev/null; then fail 'stopped prior service must abort before pull'; fi
pass_count=$((pass_count + 1))

setup prior_image_mismatch
if CURRENT_IMAGE="$IMAGE_B" run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'recorded/running image mismatch should block deployment'; fi
if grep -F 'docker pull' "$TEST_DIR/docker.log" >/dev/null; then fail 'image mismatch must abort before pull'; fi
pass_count=$((pass_count + 1))

setup success
run_deploy "$IMAGE_B" >/dev/null
assert_eq "$(grep '^PHANTOM_IMAGE=' "$TEST_DIR/.env" | cut -d= -f2-)" "$IMAGE_B" 'healthy deploy records image'
grep -F "up file=$TEST_DIR/.compose.next." "$TEST_DIR/up.log" >/dev/null || fail 'candidate startup should use staged candidate compose'
grep -F 'content=marker: candidate' "$TEST_DIR/up.log" >/dev/null || fail 'candidate startup should use candidate config contents'
grep -F 'marker: candidate' "$TEST_DIR/compose.yaml" >/dev/null || fail 'successful deployment should promote candidate Compose config'
backup_files=("$TEST_DIR"/backups/phantom-*.json)
(( ${#backup_files[@]} == 1 )) && [[ -s "${backup_files[0]}" ]] || fail 'deploy should retain a JSON backup'
pass_count=$((pass_count + 1))

setup pull_failure
if PULL_FAIL=1 run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'pull failure should fail deployment'; fi
assert_eq "$(grep '^PHANTOM_IMAGE=' "$TEST_DIR/.env" | cut -d= -f2-)" "$IMAGE_A" 'pull failure preserves prior image'
pass_count=$((pass_count + 1))

setup unhealthy
if HEALTH_FAIL=1 run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'health failure should fail deployment'; fi
assert_eq "$(grep '^PHANTOM_IMAGE=' "$TEST_DIR/.env" | cut -d= -f2-)" "$IMAGE_A" 'health failure preserves prior image state'
grep -F "PHANTOM_IMAGE=$IMAGE_A" "$TEST_DIR/docker.log" >/dev/null || fail 'failed health check should attempt prior image rollback'
grep -F "up file=$TEST_DIR/compose.yaml image=$IMAGE_A" "$TEST_DIR/up.log" >/dev/null || fail 'health failure rollback should use old active Compose config'
grep -F 'content=marker: current' "$TEST_DIR/up.log" >/dev/null || fail 'rollback should use prior Compose config contents'
grep -F 'marker: current' "$TEST_DIR/compose.yaml" >/dev/null || fail 'failed deployment should preserve prior Compose config'
pass_count=$((pass_count + 1))

setup duplicate_env
printf 'PHANTOM_IMAGE=%s\n' "$IMAGE_B" >> "$TEST_DIR/.env"
if run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'duplicate image assignments should be rejected'; fi
assert_eq "$(grep -c '^PHANTOM_IMAGE=' "$TEST_DIR/.env")" 2 'duplicate config remains untouched'
pass_count=$((pass_count + 1))

setup backup_failure
if BACKUP_FAIL=1 run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'backup failure should abort deployment'; fi
grep -F "docker pull $IMAGE_B" "$TEST_DIR/docker.log" >/dev/null || fail 'candidate should be pulled before backup'
if grep -F ' up ' "$TEST_DIR/docker.log" >/dev/null; then fail 'backup failure must abort before service replacement'; fi
assert_eq "$(grep '^PHANTOM_IMAGE=' "$TEST_DIR/.env" | cut -d= -f2-)" "$IMAGE_A" 'backup failure preserves prior image'
pass_count=$((pass_count + 1))

setup staging_failure
if CHMOD_FAIL=1 run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'staging permission failure should abort deployment'; fi
if grep -F ' up ' "$TEST_DIR/docker.log" >/dev/null; then fail 'staging error must abort before service replacement'; fi
grep -F 'marker: current' "$TEST_DIR/compose.yaml" >/dev/null || fail 'staging failure preserves active config'
assert_eq "$(grep '^PHANTOM_IMAGE=' "$TEST_DIR/.env" | cut -d= -f2-)" "$IMAGE_A" 'staging failure preserves active environment'
pass_count=$((pass_count + 1))

setup compose_promotion_failure
if MV_FAIL_DEST="$TEST_DIR/compose.yaml" run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'Compose promotion failure should fail deployment'; fi
grep -F 'marker: current' "$TEST_DIR/compose.yaml" >/dev/null || fail 'Compose promotion failure restores active config'
assert_eq "$(grep '^PHANTOM_IMAGE=' "$TEST_DIR/.env" | cut -d= -f2-)" "$IMAGE_A" 'Compose promotion failure restores active environment'
grep -F "up file=$TEST_DIR/compose.yaml image=$IMAGE_A" "$TEST_DIR/up.log" >/dev/null || fail 'Compose promotion failure rollback uses old config'
pass_count=$((pass_count + 1))

setup env_promotion_failure
if MV_FAIL_DEST="$TEST_DIR/.env" run_deploy "$IMAGE_B" >/dev/null 2>&1; then fail 'environment promotion failure should fail deployment'; fi
grep -F 'marker: current' "$TEST_DIR/compose.yaml" >/dev/null || fail 'environment promotion failure restores active config'
assert_eq "$(grep '^PHANTOM_IMAGE=' "$TEST_DIR/.env" | cut -d= -f2-)" "$IMAGE_A" 'environment promotion failure restores active environment'
grep -F "up file=$TEST_DIR/compose.yaml image=$IMAGE_A" "$TEST_DIR/up.log" >/dev/null || fail 'environment promotion failure rollback uses old config'
pass_count=$((pass_count + 1))

printf 'Passed %d mocked deployment tests\n' "$pass_count"
