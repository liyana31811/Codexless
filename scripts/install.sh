#!/bin/sh
set -eu

SOURCE_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
DEFAULT_INSTALL_DIR="$HOME/Library/Application Support/Codexless/app"
INSTALL_DIR=$DEFAULT_INSTALL_DIR
STATE_ROOT="$HOME/.config/codexless"
BOOTSTRAP_ROOT=${CODEXLESS_BOOTSTRAP_ROOT:-"$STATE_ROOT/bootstrap"}
REPAIR=0
JSON=0
RUNTIME_MODE_REQUESTED=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ "$#" -ge 2 ] || { echo "--install-dir requires a path" >&2; exit 2; }
      INSTALL_DIR=$2
      shift 2
      ;;
    --repair)
      REPAIR=1
      shift
      ;;
    --existing-only)
      [ -z "$RUNTIME_MODE_REQUESTED" ] || { echo "Choose at most one Advanced runtime mode: --existing-only or --recommended." >&2; exit 2; }
      RUNTIME_MODE_REQUESTED="existing"
      shift
      ;;
    --recommended)
      [ -z "$RUNTIME_MODE_REQUESTED" ] || { echo "Choose at most one Advanced runtime mode: --existing-only or --recommended." >&2; exit 2; }
      RUNTIME_MODE_REQUESTED="recommended"
      shift
      ;;
    --json)
      JSON=1
      shift
      ;;
    -h|--help)
      printf '%s\n' "Usage: sh scripts/install.sh [--install-dir <path>] [--repair] [--existing-only|--recommended] [--json]"
      exit 0
      ;;
    *)
      echo "Unknown installer argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
PARENT_DIR=$(dirname "$INSTALL_DIR")
CACHE_DIR="$HOME/Library/Caches/Codexless/npm"
PREVIOUS_BACKUP_DIR="$PARENT_DIR/.Codexless-previous"
PREVIOUS_BACKUP_STASH_DIR=""
STAGE_DIR=""
BACKUP_DIR=""
INSTALLED=0
HAD_EXISTING_INSTALL=0
ROLLBACK_PERFORMED=false
STATE_SCHEMA_COMPATIBLE=false
LIFECYCLE_MODE="install"
LIFECYCLE_ACTION="install-failed"
ERROR_STAGE="preflight"
ERROR_CODE="INSTALL_FAILED"
NODE=""
SUCCESS_RECEIPT=""
ACTIVATION_NONCE=""
BOOTSTRAP_BUILD_ID=""
BOOTSTRAP_REUSED=""
BOOTSTRAP_PENDING_DIR=""
MARKER_WRITTEN=0
PREVIOUS_MARKER_BUILD_ID=""
PREVIOUS_MARKER_VERSION=""
PREVIOUS_MARKER_CREATED_AT=""
PREVIOUS_MARKER_UPDATED_AT=""
TRANSACTION_COMMITTED=0
SKILL_TRANSACTION_ID=""
SKILL_FINALIZE_WARNING=""
RUNTIME_MODE_EFFECTIVE=""
RUNTIME_PREFERENCE_PREVIOUS_PERSISTED=false
RUNTIME_PREFERENCE_PREVIOUS_MODE=""
RUNTIME_PREFERENCE_CHANGED=0
MANAGED_PROVISIONING=""
MANAGED_ACTIVATION=""
MANAGED_READY=false
MANAGED_ONBOARDING_REQUIRED=false
MANAGED_ONBOARDING_COMMAND=""

if [ "$REPAIR" -eq 1 ]; then
  LIFECYCLE_MODE="repair"
  LIFECYCLE_ACTION="repair-failed"
fi

json_field() {
  field=$1
  node_bin=$2
  "$node_bin" -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(text)[process.argv[1]];
      if (value === undefined || value === null) process.exit(3);
      process.stdout.write(String(value));
    });
  ' "$field"
}

json_path() {
  field_path=$1
  node_bin=$2
  "$node_bin" -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      let value = JSON.parse(text);
      for (const part of process.argv[1].split(".")) {
        if (value === undefined || value === null || typeof value !== "object") process.exit(3);
        value = value[part];
      }
      if (value === undefined || value === null) process.exit(3);
      process.stdout.write(String(value));
    });
  ' "$field_path"
}

emit_failure() {
  message=$1
  if [ "$JSON" -eq 1 ] && [ -n "$NODE" ] && [ -f "$SOURCE_ROOT/scripts/lifecycle.mjs" ]; then
    if "$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" failure \
      --action "$LIFECYCLE_ACTION" \
      --install-dir "$INSTALL_DIR" \
      --error-stage "$ERROR_STAGE" \
      --error-code "$ERROR_CODE" \
      --error "$message" \
      --rollback-performed "$ROLLBACK_PERFORMED" \
      --state-schema-compatible "$STATE_SCHEMA_COMPATIBLE"; then
      return 0
    fi
  fi
  if [ "$JSON" -eq 1 ] && [ -n "$NODE" ]; then
    ACTION_ENV=$LIFECYCLE_ACTION INSTALL_DIR_ENV=$INSTALL_DIR ERROR_STAGE_ENV=$ERROR_STAGE ERROR_CODE_ENV=$ERROR_CODE MESSAGE_ENV=$message ROLLBACK_ENV=$ROLLBACK_PERFORMED SCHEMA_ENV=$STATE_SCHEMA_COMPATIBLE \
      "$NODE" -e '
        const e = process.env;
        process.stdout.write(JSON.stringify({
          ok:false,receiptVersion:1,action:e.ACTION_ENV,installDir:e.INSTALL_DIR_ENV,
          from:null,to:null,artifactBuildId:null,doctorStatus:null,
          state:{preserved:true,schemaCompatible:e.SCHEMA_ENV==="true",migrated:false},
          rollback:{performed:e.ROLLBACK_ENV==="true",backupRetained:false,backupPath:null},
          requiresRuntimeRestart:false,requiresHostRefresh:false,
          errorStage:e.ERROR_STAGE_ENV,errorCode:e.ERROR_CODE_ENV,error:e.MESSAGE_ENV
        }) + "\n");
      '
  else
    echo "Codexless install failed: $message" >&2
  fi
}

release_lock() {
  [ -n "$ACTIVATION_NONCE" ] || return 0
  nonce=$ACTIVATION_NONCE
  ACTIVATION_NONCE=""
  "$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" lock-release \
    --state-root "$STATE_ROOT" \
    --nonce "$nonce" \
    --owner-pid "$$" >/dev/null 2>&1
}

on_signal() {
  rollback || true
  release_lock || true
  trap - HUP INT TERM
  exit 1
}

restore_marker() {
  [ "$MARKER_WRITTEN" -eq 1 ] || return 0
  if [ -n "$PREVIOUS_MARKER_BUILD_ID" ] && [ -n "$PREVIOUS_MARKER_VERSION" ] && [ -n "$PREVIOUS_MARKER_CREATED_AT" ] && [ -n "$PREVIOUS_MARKER_UPDATED_AT" ]; then
    if ! MARKER_RESTORE=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" marker-restore \
      --state-root "$STATE_ROOT" \
      --install-dir "$INSTALL_DIR" \
      --build-id "$PREVIOUS_MARKER_BUILD_ID" \
      --version "$PREVIOUS_MARKER_VERSION" \
      --created-at "$PREVIOUS_MARKER_CREATED_AT" \
      --updated-at "$PREVIOUS_MARKER_UPDATED_AT"); then
      return 1
    fi
  else
    if ! MARKER_RESTORE=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" marker-delete \
      --state-root "$STATE_ROOT" \
      --install-dir "$INSTALL_DIR"); then
      return 1
    fi
  fi
  MARKER_OK=$(printf '%s' "$MARKER_RESTORE" | json_field ok "$NODE" 2>/dev/null || true)
  [ "$MARKER_OK" = "true" ] || return 1
  MARKER_WRITTEN=0
  return 0
}

restore_previous_backup_stash() {
  [ -n "$PREVIOUS_BACKUP_STASH_DIR" ] || return 0
  [ -e "$PREVIOUS_BACKUP_STASH_DIR" ] || return 1
  [ ! -e "$PREVIOUS_BACKUP_DIR" ] || return 1
  mv "$PREVIOUS_BACKUP_STASH_DIR" "$PREVIOUS_BACKUP_DIR" || return 1
  PREVIOUS_BACKUP_STASH_DIR=""
  return 0
}

discard_bootstrap() {
  [ -n "$BOOTSTRAP_BUILD_ID" ] || return 0
  if [ "$BOOTSTRAP_REUSED" = "true" ]; then
    if ! BOOTSTRAP_DISCARD=$("$NODE" "$SOURCE_ROOT/scripts/materialize-bootstrap.mjs" discard \
      --bootstrap-root "$BOOTSTRAP_ROOT" \
      --build-id "$BOOTSTRAP_BUILD_ID" \
      --reused true); then
      return 1
    fi
  else
    if ! BOOTSTRAP_DISCARD=$("$NODE" "$SOURCE_ROOT/scripts/materialize-bootstrap.mjs" discard \
      --bootstrap-root "$BOOTSTRAP_ROOT" \
      --build-id "$BOOTSTRAP_BUILD_ID" \
      --reused false \
      --pending-dir "$BOOTSTRAP_PENDING_DIR"); then
      return 1
    fi
  fi
  DISCARD_OK=$(printf '%s' "$BOOTSTRAP_DISCARD" | json_field ok "$NODE" 2>/dev/null || true)
  [ "$DISCARD_OK" = "true" ] || return 1
  BOOTSTRAP_BUILD_ID=""
  BOOTSTRAP_REUSED=""
  BOOTSTRAP_PENDING_DIR=""
  return 0
}

prepare_browser_repair_skill() {
  if ! SKILL_PREPARED=$("$NODE" "$SOURCE_ROOT/scripts/sync-codex-skills.mjs" prepare --target-lane existing --source-dir "$SOURCE_ROOT/skills/codexless-browser-repair"); then return 1; fi
  SKILL_OK=$(printf '%s' "$SKILL_PREPARED" | json_field ok "$NODE" 2>/dev/null || true)
  [ "$SKILL_OK" = "true" ] || return 1
  SKILL_TRANSACTION_ID=$(printf '%s' "$SKILL_PREPARED" | json_field transactionId "$NODE" 2>/dev/null || true)
  return 0
}

rollback_browser_repair_skill() {
  [ -n "$SKILL_TRANSACTION_ID" ] || return 0
  if ! SKILL_ROLLBACK=$("$NODE" "$SOURCE_ROOT/scripts/sync-codex-skills.mjs" rollback --target-lane existing --transaction-id "$SKILL_TRANSACTION_ID"); then return 1; fi
  SKILL_OK=$(printf '%s' "$SKILL_ROLLBACK" | json_field ok "$NODE" 2>/dev/null || true)
  [ "$SKILL_OK" = "true" ] || return 1
  SKILL_TRANSACTION_ID=""
  return 0
}

finalize_browser_repair_skill() {
  [ -n "$SKILL_TRANSACTION_ID" ] || return 0
  if ! SKILL_FINALIZED=$("$NODE" "$SOURCE_ROOT/scripts/sync-codex-skills.mjs" finalize --target-lane existing --transaction-id "$SKILL_TRANSACTION_ID"); then return 1; fi
  SKILL_OK=$(printf '%s' "$SKILL_FINALIZED" | json_field ok "$NODE" 2>/dev/null || true)
  [ "$SKILL_OK" = "true" ] || return 1
  SKILL_TRANSACTION_ID=""
  return 0
}

restore_runtime_preference() {
  [ "$RUNTIME_PREFERENCE_CHANGED" -eq 1 ] || return 0
  if [ "$RUNTIME_PREFERENCE_PREVIOUS_PERSISTED" = "true" ]; then
    if ! RUNTIME_RESTORE=$("$NODE" "$SOURCE_ROOT/scripts/runtime-install-state.mjs" set-mode --mode "$RUNTIME_PREFERENCE_PREVIOUS_MODE" --state-root "$STATE_ROOT"); then return 1; fi
  else
    if ! RUNTIME_RESTORE=$("$NODE" "$SOURCE_ROOT/scripts/runtime-install-state.mjs" clear-mode --state-root "$STATE_ROOT"); then return 1; fi
  fi
  RUNTIME_RESTORE_OK=$(printf '%s' "$RUNTIME_RESTORE" | json_field ok "$NODE" 2>/dev/null || true)
  [ "$RUNTIME_RESTORE_OK" = "true" ] || return 1
  RUNTIME_PREFERENCE_CHANGED=0
  return 0
}

rollback() {
  rollback_ok=1
  if [ "$TRANSACTION_COMMITTED" -eq 1 ]; then return 0; fi
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
    rm -rf "$STAGE_DIR"
  fi
  if [ "$INSTALLED" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    INSTALLED=0
  fi
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] && [ ! -e "$INSTALL_DIR" ]; then
    mv "$BACKUP_DIR" "$INSTALL_DIR"
    BACKUP_DIR=""
    ROLLBACK_PERFORMED=true
  fi
  if [ -n "$PREVIOUS_BACKUP_STASH_DIR" ]; then
    if ! restore_previous_backup_stash; then
      ERROR_STAGE="previous-restore"
      ERROR_CODE="PREVIOUS_STASH_RESTORE_FAILED"
      rollback_ok=0
    fi
  fi
  if [ "$MARKER_WRITTEN" -eq 1 ]; then
    if ! restore_marker; then
      if [ "$ERROR_CODE" != "PREVIOUS_STASH_RESTORE_FAILED" ]; then
        ERROR_STAGE="ownership-marker"
        ERROR_CODE="OWNERSHIP_MARKER_ROLLBACK_FAILED"
      fi
      rollback_ok=0
    fi
  fi
  if [ -n "$BOOTSTRAP_BUILD_ID" ]; then
    if ! discard_bootstrap; then
      if [ "$ERROR_CODE" != "PREVIOUS_STASH_RESTORE_FAILED" ]; then
        ERROR_STAGE="bootstrap-discard"
        ERROR_CODE="BOOTSTRAP_GENERATION_DISCARD_FAILED"
      fi
      rollback_ok=0
    fi
  fi
  if [ "$RUNTIME_PREFERENCE_CHANGED" -eq 1 ]; then
    if ! restore_runtime_preference; then
      ERROR_STAGE="runtime-mode-preference-rollback"
      ERROR_CODE="RUNTIME_MODE_PREFERENCE_ROLLBACK_FAILED"
      rollback_ok=0
    fi
  fi
  if [ -n "$SKILL_TRANSACTION_ID" ]; then
    if ! rollback_browser_repair_skill; then
      ERROR_STAGE="skill-rollback"
      ERROR_CODE="SKILL_SYNC_ROLLBACK_FAILED"
      rollback_ok=0
    fi
  fi
  [ "$rollback_ok" -eq 1 ]
}

fail() {
  message=$1
  if ! rollback; then
    message="Lifecycle rollback could not restore all external lifecycle state."
  fi
  emit_failure "$message"
  exit 1
}

ERROR_STAGE="prerequisite"
ERROR_CODE="PREREQUISITE_FAILED"
[ "$(uname -s)" = "Darwin" ] || fail "Mac Technical Preview installer requires macOS."
[ "$(uname -m)" = "arm64" ] || fail "Mac Technical Preview installer currently requires Apple Silicon arm64."

NODE=$(command -v node 2>/dev/null || true)
NPM=$(command -v npm 2>/dev/null || true)
[ -n "$NODE" ] || fail "Node.js was not found on PATH."
[ -n "$NPM" ] || fail "npm was not found on PATH."
NODE_VERSION=$($NODE -p 'process.versions.node' 2>/dev/null || true)
[ -n "$NODE_VERSION" ] || fail "Unable to read Node.js version."
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "Codexless requires Node.js 22+. Current: v$NODE_VERSION"

if [ "$REPAIR" -eq 1 ]; then
  LOCK_ACTION="repair"
elif [ -e "$INSTALL_DIR" ]; then
  LOCK_ACTION="update"
else
  LOCK_ACTION="install"
fi
ERROR_STAGE="activation-lock"
ERROR_CODE="INSTALLER_BUSY"
if ! ACTIVATION_LOCK=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" lock-acquire \
  --state-root "$STATE_ROOT" \
  --install-dir "$INSTALL_DIR" \
  --action "$LOCK_ACTION" \
  --owner-pid "$$"); then
  if [ "$JSON" -eq 1 ]; then printf '%s\n' "$ACTIVATION_LOCK"; else
    LOCK_ERROR=$(printf '%s' "$ACTIVATION_LOCK" | json_field error "$NODE" 2>/dev/null || printf '%s' "Another Codexless installer lifecycle is active.")
    echo "Codexless install failed: $LOCK_ERROR" >&2
  fi
  exit 1
fi
ACTIVATION_NONCE=$(printf '%s' "$ACTIVATION_LOCK" | json_field nonce "$NODE" 2>/dev/null || true)
[ -n "$ACTIVATION_NONCE" ] || fail "Installer activation lock did not return a nonce."
trap 'release_lock || true' EXIT
trap 'on_signal' HUP INT TERM

if [ -e "$INSTALL_DIR" ]; then HAD_EXISTING_INSTALL=1; fi
if [ "$REPAIR" -eq 0 ]; then
  if [ "$HAD_EXISTING_INSTALL" -eq 1 ]; then
    LIFECYCLE_MODE="update"
    LIFECYCLE_ACTION="update-failed"
  else
    LIFECYCLE_MODE="install"
    LIFECYCLE_ACTION="install-failed"
  fi
fi

if ! RUNTIME_STATUS=$("$NODE" "$SOURCE_ROOT/scripts/runtime-install-state.mjs" status --state-root "$STATE_ROOT"); then fail "Unable to read runtime install preference/state."; fi
RUNTIME_STATUS_OK=$(printf '%s' "$RUNTIME_STATUS" | json_field ok "$NODE" 2>/dev/null || true)
[ "$RUNTIME_STATUS_OK" = "true" ] || fail "Unable to read runtime install preference/state."
RUNTIME_PREFERENCE_PREVIOUS_PERSISTED=$(printf '%s' "$RUNTIME_STATUS" | json_path preference.persisted "$NODE" 2>/dev/null || printf '%s' false)
RUNTIME_PREFERENCE_PREVIOUS_MODE=$(printf '%s' "$RUNTIME_STATUS" | json_path preference.mode "$NODE" 2>/dev/null || true)
if [ -n "$RUNTIME_MODE_REQUESTED" ]; then RUNTIME_MODE_EFFECTIVE=$RUNTIME_MODE_REQUESTED
elif [ "$RUNTIME_PREFERENCE_PREVIOUS_PERSISTED" = "true" ]; then RUNTIME_MODE_EFFECTIVE=$RUNTIME_PREFERENCE_PREVIOUS_MODE
else RUNTIME_MODE_EFFECTIVE="recommended"
fi
if [ -n "$RUNTIME_MODE_REQUESTED" ]; then
  ERROR_STAGE="runtime-mode-preference"
  ERROR_CODE="RUNTIME_MODE_PREFERENCE_FAILED"
  if ! RUNTIME_PREF_RESULT=$("$NODE" "$SOURCE_ROOT/scripts/runtime-install-state.mjs" set-mode --mode "$RUNTIME_MODE_REQUESTED" --state-root "$STATE_ROOT"); then fail "Runtime mode preference update failed."; fi
  RUNTIME_PREF_OK=$(printf '%s' "$RUNTIME_PREF_RESULT" | json_field ok "$NODE" 2>/dev/null || true)
  [ "$RUNTIME_PREF_OK" = "true" ] || fail "Runtime mode preference update failed."
  RUNTIME_PREFERENCE_CHANGED=1
fi

ERROR_STAGE="prerequisite"
ERROR_CODE="PREREQUISITE_FAILED"
CODEX_JSON=$($NODE "$SOURCE_ROOT/scripts/resolve-codex.mjs" 2>/dev/null || true)
[ -n "$CODEX_JSON" ] || fail "Codex prerequisite check returned no result."
CODEX_OK=$(printf '%s' "$CODEX_JSON" | json_field ok "$NODE" 2>/dev/null || true)
if [ "$CODEX_OK" != "true" ]; then
  CODEX_ERROR=$(printf '%s' "$CODEX_JSON" | json_field error "$NODE" 2>/dev/null || true)
  fail "Codex prerequisite check failed: ${CODEX_ERROR:-unknown error}"
fi
CODEX_BIN_RESOLVED=$(printf '%s' "$CODEX_JSON" | json_field path "$NODE" 2>/dev/null || true)
[ -n "$CODEX_BIN_RESOLVED" ] || fail "Codex prerequisite check did not return an executable path."

ERROR_STAGE="staging"
ERROR_CODE="STAGING_FAILED"
mkdir -p "$PARENT_DIR" "$CACHE_DIR"
STAGE_DIR=$(mktemp -d "$PARENT_DIR/.Codexless-stage.XXXXXX") || fail "Unable to create staging directory beside install target."

for entry in src config scripts skills bin package.json README.md README.zh-CN.md README.linux.md SECURITY.md EXPORT_SYNC.md THIRD_PARTY_NOTICES.md LICENSE; do
  [ -e "$SOURCE_ROOT/$entry" ] || fail "Release source is missing required entry: $entry"
  cp -R "$SOURCE_ROOT/$entry" "$STAGE_DIR/$entry" || fail "Failed to stage release entry: $entry"
done
if [ -f "$SOURCE_ROOT/npm-shrinkwrap.json" ]; then
  cp "$SOURCE_ROOT/npm-shrinkwrap.json" "$STAGE_DIR/npm-shrinkwrap.json" || fail "Failed to stage npm-shrinkwrap.json."
elif [ -f "$SOURCE_ROOT/package-lock.json" ]; then
  cp "$SOURCE_ROOT/package-lock.json" "$STAGE_DIR/package-lock.json" || fail "Failed to stage package-lock.json."
else
  fail "Release source is missing a frozen npm lockfile: npm-shrinkwrap.json or package-lock.json"
fi
chmod +x \
  "$STAGE_DIR/scripts/install.sh" \
  "$STAGE_DIR/scripts/uninstall.sh" \
  "$STAGE_DIR/bin/codexless-install.sh" \
  "$STAGE_DIR/bin/codexless-doctor.sh" \
  "$STAGE_DIR/bin/codexless-http.sh" \
  "$STAGE_DIR/bin/codexless-stdio.sh" \
  "$STAGE_DIR/bin/codexless-uninstall.sh" \
  || fail "Failed to mark Mac lifecycle launchers executable in staging."

ERROR_STAGE="dependency-install"
ERROR_CODE="DEPENDENCY_INSTALL_FAILED"
if ! (cd "$STAGE_DIR" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$CACHE_DIR" 1>&2); then
  fail "npm production dependency install failed in staging."
fi
if [ "$RUNTIME_MODE_EFFECTIVE" = "recommended" ]; then
  ERROR_STAGE="managed-provision"
  ERROR_CODE="MANAGED_RUNTIME_PROVISION_FAILED"
  if ! MANAGED_PROVISIONING=$("$NODE" "$STAGE_DIR/scripts/runtime-install-state.mjs" verify-managed --state-root "$STATE_ROOT"); then
    MANAGED_ERROR=$(printf '%s' "$MANAGED_PROVISIONING" | json_field error "$NODE" 2>/dev/null || printf '%s' "Managed runtime provisioning failed.")
    fail "$MANAGED_ERROR"
  fi
  MANAGED_OK=$(printf '%s' "$MANAGED_PROVISIONING" | json_field ok "$NODE" 2>/dev/null || true)
  [ "$MANAGED_OK" = "true" ] || fail "Managed runtime provisioning failed."
  MANAGED_ACTIVATION=$(printf '%s' "$MANAGED_PROVISIONING" | json_field activation "$NODE" 2>/dev/null || true)
  MANAGED_READY=$(printf '%s' "$MANAGED_PROVISIONING" | json_field managedReady "$NODE" 2>/dev/null || printf '%s' false)
  [ "$MANAGED_READY" = true ] || MANAGED_ONBOARDING_REQUIRED=true
fi

ERROR_STAGE="staging-doctor"
ERROR_CODE="STAGING_DOCTOR_FAILED"
if ! STAGE_DOCTOR=$(cd "$STAGE_DIR" && CODEX_BIN="$CODEX_BIN_RESOLVED" "$NODE" scripts/doctor.mjs --json); then
  fail "Staging doctor failed."
fi
STAGE_STATUS=$(printf '%s' "$STAGE_DOCTOR" | json_field status "$NODE" 2>/dev/null || true)
[ "$STAGE_STATUS" != "error" ] || fail "Staging doctor returned error."

ERROR_STAGE="state-compatibility"
ERROR_CODE="STATE_INCOMPATIBLE"
if [ "$HAD_EXISTING_INSTALL" -eq 1 ]; then
  if ! LIFECYCLE_PREFLIGHT=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" preflight \
    --target-root "$STAGE_DIR" \
    --installed-root "$INSTALL_DIR" \
    --install-dir "$INSTALL_DIR" \
    --mode "$LIFECYCLE_MODE" \
    --state-root "$STATE_ROOT"); then
    ERROR_STAGE=$(printf '%s' "$LIFECYCLE_PREFLIGHT" | json_field errorStage "$NODE" 2>/dev/null || printf '%s' "state-compatibility")
    ERROR_CODE=$(printf '%s' "$LIFECYCLE_PREFLIGHT" | json_field errorCode "$NODE" 2>/dev/null || printf '%s' "STATE_INCOMPATIBLE")
    PREFLIGHT_ERROR=$(printf '%s' "$LIFECYCLE_PREFLIGHT" | json_field error "$NODE" 2>/dev/null || printf '%s' "Lifecycle preflight failed.")
    fail "$PREFLIGHT_ERROR"
  fi
else
  if ! LIFECYCLE_PREFLIGHT=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" preflight \
    --target-root "$STAGE_DIR" \
    --install-dir "$INSTALL_DIR" \
    --mode "$LIFECYCLE_MODE" \
    --state-root "$STATE_ROOT"); then
    ERROR_STAGE=$(printf '%s' "$LIFECYCLE_PREFLIGHT" | json_field errorStage "$NODE" 2>/dev/null || printf '%s' "state-compatibility")
    ERROR_CODE=$(printf '%s' "$LIFECYCLE_PREFLIGHT" | json_field errorCode "$NODE" 2>/dev/null || printf '%s' "STATE_INCOMPATIBLE")
    PREFLIGHT_ERROR=$(printf '%s' "$LIFECYCLE_PREFLIGHT" | json_field error "$NODE" 2>/dev/null || printf '%s' "Lifecycle preflight failed.")
    fail "$PREFLIGHT_ERROR"
  fi
fi
STATE_SCHEMA_COMPATIBLE=true
TARGET_BUILD_ID=$(printf '%s' "$LIFECYCLE_PREFLIGHT" | json_field artifactBuildId "$NODE" 2>/dev/null || true)
[ -n "$TARGET_BUILD_ID" ] || fail "Lifecycle preflight did not include a target buildId."

ERROR_STAGE="bootstrap-prepare"
ERROR_CODE="BOOTSTRAP_GENERATION_PREPARE_FAILED"
HANDOFF_BUILD=${CODEXLESS_BOOTSTRAP_PREPARED_BUILD_ID:-}
HANDOFF_REUSED=${CODEXLESS_BOOTSTRAP_PREPARED_REUSED:-}
HANDOFF_PENDING=${CODEXLESS_BOOTSTRAP_PREPARED_PENDING_DIR:-}
if [ -n "$HANDOFF_BUILD" ] || [ -n "$HANDOFF_REUSED" ] || [ -n "$HANDOFF_PENDING" ]; then
  [ -n "$HANDOFF_BUILD" ] || fail "External bootstrap handoff is incomplete."
  [ "$HANDOFF_REUSED" = "true" ] || [ "$HANDOFF_REUSED" = "false" ] || fail "External bootstrap handoff reused flag is invalid."
  [ "$HANDOFF_BUILD" = "$TARGET_BUILD_ID" ] || fail "External bootstrap handoff build does not match staged target build."
  if [ "$HANDOFF_REUSED" = "false" ]; then
    [ -n "$HANDOFF_PENDING" ] || fail "External bootstrap handoff is missing its pending generation."
    if ! BOOTSTRAP_RESULT=$("$NODE" "$SOURCE_ROOT/scripts/materialize-bootstrap.mjs" validate \
      --bootstrap-root "$BOOTSTRAP_ROOT" \
      --build-id "$HANDOFF_BUILD" \
      --reused false \
      --pending-dir "$HANDOFF_PENDING"); then
      BOOTSTRAP_ERROR=$(printf '%s' "$BOOTSTRAP_RESULT" | json_field error "$NODE" 2>/dev/null || printf '%s' "External bootstrap handoff validation failed.")
      fail "$BOOTSTRAP_ERROR"
    fi
  else
    [ -z "$HANDOFF_PENDING" ] || fail "External bootstrap reused handoff must not include a pending path."
    if ! BOOTSTRAP_RESULT=$("$NODE" "$SOURCE_ROOT/scripts/materialize-bootstrap.mjs" validate \
      --bootstrap-root "$BOOTSTRAP_ROOT" \
      --build-id "$HANDOFF_BUILD" \
      --reused true); then
      BOOTSTRAP_ERROR=$(printf '%s' "$BOOTSTRAP_RESULT" | json_field error "$NODE" 2>/dev/null || printf '%s' "External bootstrap handoff validation failed.")
      fail "$BOOTSTRAP_ERROR"
    fi
  fi
else
  if ! BOOTSTRAP_RESULT=$("$NODE" "$SOURCE_ROOT/scripts/materialize-bootstrap.mjs" prepare \
    --source-root "$STAGE_DIR" \
    --bootstrap-root "$BOOTSTRAP_ROOT" \
    --build-id "$TARGET_BUILD_ID"); then
    BOOTSTRAP_ERROR=$(printf '%s' "$BOOTSTRAP_RESULT" | json_field error "$NODE" 2>/dev/null || printf '%s' "Bootstrap generation prepare failed.")
    fail "$BOOTSTRAP_ERROR"
  fi
fi
BOOTSTRAP_OK=$(printf '%s' "$BOOTSTRAP_RESULT" | json_field ok "$NODE" 2>/dev/null || true)
[ "$BOOTSTRAP_OK" = "true" ] || fail "Bootstrap generation prepare/validation failed."
BOOTSTRAP_BUILD_ID=$(printf '%s' "$BOOTSTRAP_RESULT" | json_path prepared.buildId "$NODE" 2>/dev/null || true)
BOOTSTRAP_REUSED=$(printf '%s' "$BOOTSTRAP_RESULT" | json_path prepared.reused "$NODE" 2>/dev/null || true)
BOOTSTRAP_PENDING_DIR=$(printf '%s' "$BOOTSTRAP_RESULT" | json_path prepared.pendingDir "$NODE" 2>/dev/null || true)
[ "$BOOTSTRAP_BUILD_ID" = "$TARGET_BUILD_ID" ] || fail "Prepared bootstrap build does not match lifecycle target."
[ "$BOOTSTRAP_REUSED" = "true" ] || [ "$BOOTSTRAP_REUSED" = "false" ] || fail "Prepared bootstrap reused flag is invalid."
if [ "$BOOTSTRAP_REUSED" = "false" ]; then [ -n "$BOOTSTRAP_PENDING_DIR" ] || fail "Prepared bootstrap pending path is missing."; fi

ERROR_STAGE="ownership-marker-snapshot"
ERROR_CODE="OWNERSHIP_MARKER_SNAPSHOT_FAILED"
if ! MARKER_SNAPSHOT=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" marker-read-optional \
  --state-root "$STATE_ROOT" \
  --install-dir "$INSTALL_DIR"); then
  fail "Ownership marker transaction snapshot failed."
fi
MARKER_SNAPSHOT_OK=$(printf '%s' "$MARKER_SNAPSHOT" | json_field ok "$NODE" 2>/dev/null || true)
[ "$MARKER_SNAPSHOT_OK" = "true" ] || fail "Ownership marker transaction snapshot failed."
PREVIOUS_MARKER_BUILD_ID=$(printf '%s' "$MARKER_SNAPSHOT" | json_path marker.lastKnownBuildId "$NODE" 2>/dev/null || true)
PREVIOUS_MARKER_VERSION=$(printf '%s' "$MARKER_SNAPSHOT" | json_path marker.lastKnownVersion "$NODE" 2>/dev/null || true)
PREVIOUS_MARKER_CREATED_AT=$(printf '%s' "$MARKER_SNAPSHOT" | json_path marker.createdAt "$NODE" 2>/dev/null || true)
PREVIOUS_MARKER_UPDATED_AT=$(printf '%s' "$MARKER_SNAPSHOT" | json_path marker.updatedAt "$NODE" 2>/dev/null || true)

ERROR_STAGE="skill-prepare"
ERROR_CODE="SKILL_SYNC_PREPARE_FAILED"
prepare_browser_repair_skill || fail "Browser Repair Skill prepare failed."

if [ "$HAD_EXISTING_INSTALL" -eq 1 ]; then
  ERROR_STAGE="backup"
  ERROR_CODE="BACKUP_FAILED"
  BACKUP_DIR="$PARENT_DIR/.Codexless-backup.$$.${NODE_MAJOR}"
  [ ! -e "$BACKUP_DIR" ] || fail "Backup path already exists."
  mv "$INSTALL_DIR" "$BACKUP_DIR" || fail "Unable to move current install to backup."
fi

ERROR_STAGE="activate"
ERROR_CODE="ACTIVATE_FAILED"
if ! mv "$STAGE_DIR" "$INSTALL_DIR"; then
  fail "Unable to activate staged install."
fi
STAGE_DIR=""
INSTALLED=1

ERROR_STAGE="installed-doctor"
ERROR_CODE="INSTALLED_DOCTOR_FAILED"
if ! INSTALLED_DOCTOR=$(cd "$INSTALL_DIR" && CODEX_BIN="$CODEX_BIN_RESOLVED" "$NODE" scripts/doctor.mjs --json); then
  fail "Installed doctor failed; previous install was restored when available."
fi
INSTALLED_STATUS=$(printf '%s' "$INSTALLED_DOCTOR" | json_field status "$NODE" 2>/dev/null || true)
[ "$INSTALLED_STATUS" != "error" ] || fail "Installed doctor returned error; previous install was restored when available."

ERROR_STAGE="receipt"
ERROR_CODE="RECEIPT_FAILED"
if [ "$HAD_EXISTING_INSTALL" -eq 1 ]; then
  if ! SUCCESS_RECEIPT=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" receipt \
    --target-root "$INSTALL_DIR" \
    --previous-root "$BACKUP_DIR" \
    --install-dir "$INSTALL_DIR" \
    --doctor-status "$INSTALLED_STATUS" \
    --mode "$LIFECYCLE_MODE" \
    --state-root "$STATE_ROOT" \
    --backup-retained true \
    --backup-path "$PREVIOUS_BACKUP_DIR"); then
    fail "Lifecycle success receipt generation failed."
  fi
else
  if ! SUCCESS_RECEIPT=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" receipt \
    --target-root "$INSTALL_DIR" \
    --install-dir "$INSTALL_DIR" \
    --doctor-status "$INSTALLED_STATUS" \
    --mode "$LIFECYCLE_MODE" \
    --state-root "$STATE_ROOT"); then
    fail "Lifecycle success receipt generation failed."
  fi
fi

if [ "$HAD_EXISTING_INSTALL" -eq 1 ]; then
  if [ -e "$PREVIOUS_BACKUP_DIR" ]; then
    ERROR_STAGE="previous-stash"
    ERROR_CODE="PREVIOUS_STASH_FAILED"
    STASH_CANDIDATE="$PARENT_DIR/.Codexless-previous.rollback-$ACTIVATION_NONCE"
    [ ! -e "$STASH_CANDIDATE" ] || fail "Previous backup rollback stash already exists."
    mv "$PREVIOUS_BACKUP_DIR" "$STASH_CANDIDATE" || fail "Unable to stash the retained previous install for rollback."
    PREVIOUS_BACKUP_STASH_DIR="$STASH_CANDIDATE"
  fi
  ERROR_STAGE="backup-retention"
  ERROR_CODE="BACKUP_RETENTION_FAILED"
  mv "$BACKUP_DIR" "$PREVIOUS_BACKUP_DIR" || fail "Unable to retain the previous install."
  BACKUP_DIR="$PREVIOUS_BACKUP_DIR"
fi

ERROR_STAGE="ownership-marker"
ERROR_CODE="OWNERSHIP_MARKER_WRITE_FAILED"
BUILD_ID=$(printf '%s' "$SUCCESS_RECEIPT" | json_field artifactBuildId "$NODE" 2>/dev/null || true)
TARGET_VERSION=$(printf '%s' "$SUCCESS_RECEIPT" | json_path to.version "$NODE" 2>/dev/null || true)
[ -n "$BUILD_ID" ] || fail "Lifecycle success receipt did not include a target buildId."
[ -n "$TARGET_VERSION" ] || fail "Lifecycle success receipt did not include a target version."
if ! MARKER_RESULT=$("$NODE" "$SOURCE_ROOT/scripts/lifecycle.mjs" marker-write \
  --state-root "$STATE_ROOT" \
  --install-dir "$INSTALL_DIR" \
  --build-id "$BUILD_ID" \
  --version "$TARGET_VERSION"); then
  MARKER_ERROR=$(printf '%s' "$MARKER_RESULT" | json_field error "$NODE" 2>/dev/null || printf '%s' "Ownership marker write failed.")
  ERROR_STAGE=$(printf '%s' "$MARKER_RESULT" | json_field errorStage "$NODE" 2>/dev/null || printf '%s' "ownership-marker")
  ERROR_CODE=$(printf '%s' "$MARKER_RESULT" | json_field errorCode "$NODE" 2>/dev/null || printf '%s' "OWNERSHIP_MARKER_WRITE_FAILED")
  fail "$MARKER_ERROR"
fi
MARKER_WRITTEN=1

ERROR_STAGE="bootstrap-commit"
ERROR_CODE="BOOTSTRAP_GENERATION_COMMIT_FAILED"
if [ "$BOOTSTRAP_REUSED" = "true" ]; then
  if ! BOOTSTRAP_COMMIT=$("$NODE" "$SOURCE_ROOT/scripts/materialize-bootstrap.mjs" commit \
    --bootstrap-root "$BOOTSTRAP_ROOT" \
    --build-id "$BOOTSTRAP_BUILD_ID" \
    --reused true); then
    COMMIT_ERROR=$(printf '%s' "$BOOTSTRAP_COMMIT" | json_field error "$NODE" 2>/dev/null || printf '%s' "Bootstrap generation commit failed.")
    ERROR_CODE=$(printf '%s' "$BOOTSTRAP_COMMIT" | json_field errorCode "$NODE" 2>/dev/null || printf '%s' "BOOTSTRAP_GENERATION_COMMIT_FAILED")
    fail "$COMMIT_ERROR"
  fi
else
  if ! BOOTSTRAP_COMMIT=$("$NODE" "$SOURCE_ROOT/scripts/materialize-bootstrap.mjs" commit \
    --bootstrap-root "$BOOTSTRAP_ROOT" \
    --build-id "$BOOTSTRAP_BUILD_ID" \
    --reused false \
    --pending-dir "$BOOTSTRAP_PENDING_DIR"); then
    COMMIT_ERROR=$(printf '%s' "$BOOTSTRAP_COMMIT" | json_field error "$NODE" 2>/dev/null || printf '%s' "Bootstrap generation commit failed.")
    ERROR_CODE=$(printf '%s' "$BOOTSTRAP_COMMIT" | json_field errorCode "$NODE" 2>/dev/null || printf '%s' "BOOTSTRAP_GENERATION_COMMIT_FAILED")
    fail "$COMMIT_ERROR"
  fi
fi
COMMITTED_BUILD=$(printf '%s' "$BOOTSTRAP_COMMIT" | json_field buildId "$NODE" 2>/dev/null || true)
[ "$COMMITTED_BUILD" = "$BUILD_ID" ] || fail "Bootstrap commit did not activate the installed build."

BOOTSTRAP_BUILD_ID=""
BOOTSTRAP_REUSED=""
BOOTSTRAP_PENDING_DIR=""
MARKER_WRITTEN=0
PREVIOUS_MARKER_BUILD_ID=""
PREVIOUS_MARKER_VERSION=""
PREVIOUS_MARKER_CREATED_AT=""
PREVIOUS_MARKER_UPDATED_AT=""
BACKUP_DIR=""
INSTALLED=0
TRANSACTION_COMMITTED=1
RUNTIME_PREFERENCE_CHANGED=0

if [ -n "$SKILL_TRANSACTION_ID" ]; then
  ERROR_STAGE="skill-finalize"
  ERROR_CODE="SKILL_SYNC_FINALIZE_FAILED"
  if ! finalize_browser_repair_skill; then
    SKILL_FINALIZE_WARNING="Browser Repair Skill transaction cleanup remains pending. The installed Skill is active; rerun repair or skills sync to clean the transaction."
  fi
fi

if [ -n "$PREVIOUS_BACKUP_STASH_DIR" ]; then
  ERROR_STAGE="previous-stash-cleanup"
  ERROR_CODE="PREVIOUS_STASH_CLEANUP_FAILED"
  rm -rf "$PREVIOUS_BACKUP_STASH_DIR" || fail "Committed lifecycle could not remove the retired previous backup stash."
  PREVIOUS_BACKUP_STASH_DIR=""
fi

ERROR_STAGE="activation-lock-release"
ERROR_CODE="INSTALLER_LOCK_RELEASE_FAILED"
if ! release_lock; then
  emit_failure "Installer activation lock release failed."
  exit 1
fi
trap - EXIT HUP INT TERM

MANAGED_PROVISIONED=false
[ -n "$MANAGED_PROVISIONING" ] && MANAGED_PROVISIONED=true
if [ "$MANAGED_ONBOARDING_REQUIRED" = true ]; then MANAGED_ONBOARDING_COMMAND="node \"$INSTALL_DIR/scripts/managed-codex-login.mjs\""; fi
if ! SUCCESS_RECEIPT=$(printf '%s' "$SUCCESS_RECEIPT" | RUNTIME_MODE_ENV="$RUNTIME_MODE_EFFECTIVE" RUNTIME_REQUEST_ENV="$RUNTIME_MODE_REQUESTED" MANAGED_PROVISIONED_ENV="$MANAGED_PROVISIONED" MANAGED_ACTIVATION_ENV="$MANAGED_ACTIVATION" MANAGED_ONBOARDING_REQUIRED_ENV="$MANAGED_ONBOARDING_REQUIRED" MANAGED_ONBOARDING_COMMAND_ENV="$MANAGED_ONBOARDING_COMMAND" SKILL_WARNING_ENV="$SKILL_FINALIZE_WARNING" "$NODE" -e '
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(text);
    value.runtimeInstall = {
      mode: process.env.RUNTIME_MODE_ENV,
      requestedMode: process.env.RUNTIME_REQUEST_ENV || null,
      recommendedDualInsurance: process.env.RUNTIME_MODE_ENV === "recommended",
      managedProvisioned: process.env.MANAGED_PROVISIONED_ENV === "true",
      managedActivation: process.env.MANAGED_ACTIVATION_ENV || null,
      managedOnboardingRequired: process.env.MANAGED_ONBOARDING_REQUIRED_ENV === "true",
      managedOnboardingCommand: process.env.MANAGED_ONBOARDING_COMMAND_ENV || null,
      noSilentFallback: true
    };
    if (process.env.SKILL_WARNING_ENV) value.skillFinalizeWarning = process.env.SKILL_WARNING_ENV;
    process.stdout.write(JSON.stringify(value));
  });
'); then fail "Unable to augment lifecycle receipt with runtime installer state."; fi

PACKAGE_VERSION=$($NODE -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version || ""));' "$INSTALL_DIR/package.json")
DOCTOR_CMD="$INSTALL_DIR/bin/codexless-doctor.sh"
HTTP_CMD="$INSTALL_DIR/bin/codexless-http.sh"

if [ "$JSON" -eq 1 ]; then
  printf '%s\n' "$SUCCESS_RECEIPT"
else
  printf 'Codexless %s: %s\n' $(printf '%s' "$SUCCESS_RECEIPT" | json_field action "$NODE") "$PACKAGE_VERSION"
  printf 'Location: %s\n' "$INSTALL_DIR"
  printf 'Doctor: %s\n' "$DOCTOR_CMD"
  printf 'HTTP:   %s\n' "$HTTP_CMD"
  if [ "$HAD_EXISTING_INSTALL" -eq 1 ]; then printf 'Previous build retained: %s\n' "$PREVIOUS_BACKUP_DIR"; fi
  printf 'Runtime mode: %s\n' "$RUNTIME_MODE_EFFECTIVE"
  if [ "$MANAGED_PROVISIONED" = true ]; then
    MANAGED_PACKAGE=$(printf '%s' "$MANAGED_PROVISIONING" | json_path managed.packageName "$NODE" 2>/dev/null || true)
    MANAGED_VERSION=$(printf '%s' "$MANAGED_PROVISIONING" | json_path managed.packageVersion "$NODE" 2>/dev/null || true)
    NATIVE_PACKAGE=$(printf '%s' "$MANAGED_PROVISIONING" | json_path managed.platformPackageName "$NODE" 2>/dev/null || true)
    NATIVE_VERSION=$(printf '%s' "$MANAGED_PROVISIONING" | json_path managed.platformPackageVersion "$NODE" 2>/dev/null || true)
    printf 'Managed runtime: provisioned %s@%s + %s@%s; activation=%s\n' "$MANAGED_PACKAGE" "$MANAGED_VERSION" "$NATIVE_PACKAGE" "$NATIVE_VERSION" "$MANAGED_ACTIVATION"
  else
    printf '%s\n' "Managed runtime: skipped by Advanced Existing-only mode."
  fi
  if [ "$MANAGED_ONBOARDING_REQUIRED" = true ]; then
    printf '\n%s\n' "NEXT ACTION: Managed ChatGPT login is required before dual activation."
    printf 'Run: %s\n' "$MANAGED_ONBOARDING_COMMAND"
  fi
  if [ -n "$SKILL_FINALIZE_WARNING" ]; then printf 'Warning: %s\n' "$SKILL_FINALIZE_WARNING" >&2; fi
  printf '%s\n' "No PATH, LaunchAgent, Browser, Tunnel, or Codex trust settings were changed."
fi
