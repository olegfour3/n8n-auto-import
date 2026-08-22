#!/bin/sh
# n8n entrypoint wrapper: auto-import workflows from N8N_WORKFLOWS_IMPORT_DIR on every start.
# Errors are logged; n8n still starts (prod must not die on a bad JSON).
set -eu

AUTO_IMPORT="${N8N_AUTO_IMPORT_WORKFLOWS:-true}"
FORCE_IMPORT="${N8N_AUTO_IMPORT_FORCE:-false}"
ALWAYS_PUBLISH="${N8N_ALWAYS_PUBLISH_ON_START:-true}"
FORCE_PUBLISH="${N8N_FORCE_PUBLISH_ON_START:-false}"
WORKFLOWS_DIR="${N8N_WORKFLOWS_IMPORT_DIR:-/workflows}"
SCRIPTS_DIR="${N8N_IMPORT_SCRIPTS_DIR:-/n8n-import-scripts}"
FINGERPRINT_FILE="${N8N_IMPORT_FINGERPRINT:-/home/node/.n8n/.n8n-auto-import-workflows-fingerprint}"
PUBLISH_FP_FILE="${N8N_PUBLISH_FINGERPRINT_FILE:-/home/node/.n8n/.n8n-auto-import-publish-fingerprint}"
PUBLISH_PARALLEL="${N8N_PUBLISH_PARALLEL:-4}"
PUBLISH_USE_BATCH="${N8N_PUBLISH_USE_BATCH:-true}"
PUBLISH_USE_CLI_FALLBACK="${N8N_PUBLISH_USE_CLI_FALLBACK:-true}"
PUBLISH_ORDER_FILE="${N8N_PUBLISH_ORDER_FILE:-/tmp/n8n-publish-order.txt}"
NODE_BIN="${NODE_BIN:-node}"
export NODE_PATH="${NODE_PATH:-/usr/local/lib/node_modules/n8n/node_modules}"

log() { printf '[n8n-auto-import] %s\n' "$*"; }
warn() { printf '[n8n-auto-import] WARN: %s\n' "$*" >&2; }

now_sec() { date +%s 2>/dev/null || echo 0; }

log_phase() {
  phase="$1"
  start="$2"
  end="$(now_sec)"
  log "phase ${phase} took $((end - start))s"
}

run_node() {
  "$NODE_BIN" "$@"
}

workflows_fingerprint() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const path = require("path");
    const dir = process.argv[1];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    const h = crypto.createHash("sha256");
    for (const f of files) {
      h.update(f);
      h.update("\0");
      h.update(fs.readFileSync(path.join(dir, f)));
      h.update("\0");
    }
    process.stdout.write(h.digest("hex"));
  ' "$WORKFLOWS_DIR"
}

save_publish_fingerprint() {
  fp="$(workflows_fingerprint)"
  if printf '%s' "$fp" >"$PUBLISH_FP_FILE" 2>/dev/null; then
    log "publish fingerprint saved"
  else
    warn "could not write publish fingerprint to $PUBLISH_FP_FILE"
  fi
}

write_publish_order_file() {
  if [ -f "$SCRIPTS_DIR/n8n_publish_order.js" ]; then
    run_node "$SCRIPTS_DIR/n8n_publish_order.js" >"$PUBLISH_ORDER_FILE" 2>/dev/null || return 1
    return 0
  fi
  "$NODE_BIN" -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.argv[1];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (d && d.id && d.active === true) process.stdout.write(d.id + "\n");
      } catch {
        /* ignore bad json */
      }
    }
  ' "$WORKFLOWS_DIR" >"$PUBLISH_ORDER_FILE" 2>/dev/null || return 1
}

publish_one() {
  id="$1"
  out="/tmp/n8n-publish-${id}.out"
  err="/tmp/n8n-publish-${id}.err"
  if n8n publish:workflow --id="$id" >"$out" 2>"$err"; then
    log "published $id"
  elif n8n update:workflow --id="$id" --active=true >"$out" 2>"$err"; then
    log "activated (update:workflow) $id"
  else
    warn "activate failed for $id: $(tr '\n' ' ' <"$err" | head -c 200)"
    n8n update:workflow --id="$id" --active=false >"$out" 2>"$err" \
      || warn "could not deactivate failed workflow $id"
  fi
}

activate_active_workflows_cli() {
  if ! write_publish_order_file; then
    log "no active:true workflows to publish"
    return 0
  fi
  if [ ! -s "$PUBLISH_ORDER_FILE" ]; then
    log "no active:true workflows to publish"
    return 0
  fi

  max="$PUBLISH_PARALLEL"
  case "$max" in
    ''|*[!0-9]*) max=4 ;;
  esac
  if [ "$max" -lt 1 ]; then
    max=1
  fi

  batch=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -z "$line" ]; then
      wait || true
      batch=0
      continue
    fi
    publish_one "$line" &
    batch=$((batch + 1))
    if [ "$batch" -ge "$max" ]; then
      wait || true
      batch=0
    fi
  done <"$PUBLISH_ORDER_FILE"
  wait || true
}

activate_active_workflows_batch() {
  if ! write_publish_order_file; then
    log "no active:true workflows to publish"
    return 0
  fi
  if [ ! -s "$PUBLISH_ORDER_FILE" ]; then
    log "no active:true workflows to publish"
    return 0
  fi
  if [ ! -f "$SCRIPTS_DIR/n8n_publish_batch.js" ]; then
    return 1
  fi
  export N8N_PUBLISH_ORDER_FILE="$PUBLISH_ORDER_FILE"
  run_node "$SCRIPTS_DIR/n8n_publish_batch.js"
}

run_publish_workflows() {
  if [ "$PUBLISH_USE_BATCH" = "true" ] || [ "$PUBLISH_USE_BATCH" = "1" ]; then
    if activate_active_workflows_batch; then
      return 0
    fi
    if [ "$PUBLISH_USE_CLI_FALLBACK" = "true" ] || [ "$PUBLISH_USE_CLI_FALLBACK" = "1" ]; then
      warn "batch publish failed, falling back to CLI publish:workflow"
      activate_active_workflows_cli || return 1
      return 0
    fi
    return 1
  fi
  activate_active_workflows_cli || return 1
}

deactivate_orphan_workflows() {
  if [ -f "$SCRIPTS_DIR/n8n_deactivate_orphans.js" ]; then
    log "deactivate orphan workflows (not in export)"
    run_node "$SCRIPTS_DIR/n8n_deactivate_orphans.js" || warn "orphan deactivation failed"
  else
    warn "missing $SCRIPTS_DIR/n8n_deactivate_orphans.js"
  fi
}

run_publish_pass() {
  import_ran="${1:-false}"

  if [ "$ALWAYS_PUBLISH" = "false" ] || [ "$ALWAYS_PUBLISH" = "0" ]; then
    log "publish pass skipped (N8N_ALWAYS_PUBLISH_ON_START=$ALWAYS_PUBLISH)"
    return 0
  fi

  deactivate_orphan_workflows

  if [ "$import_ran" != "true" ] && [ "$FORCE_PUBLISH" != "true" ] && [ "$FORCE_PUBLISH" != "1" ]; then
    if [ -f "$SCRIPTS_DIR/n8n_publish_needed.js" ] && run_node "$SCRIPTS_DIR/n8n_publish_needed.js"; then
      log "skip publish (export unchanged and DB already published)"
      return 0
    fi
  fi

  if [ "$FORCE_PUBLISH" = "true" ] || [ "$FORCE_PUBLISH" = "1" ]; then
    log "force publish (N8N_FORCE_PUBLISH_ON_START=true)"
  fi

  log "publish active workflows (batch=$PUBLISH_USE_BATCH, parallel=$PUBLISH_PARALLEL, ordered)"
  if run_publish_workflows; then
    save_publish_fingerprint
  else
    warn "activation pass failed"
    return 1
  fi
}

do_import() {
  if [ "$AUTO_IMPORT" = "false" ] || [ "$AUTO_IMPORT" = "0" ]; then
    log "disabled (N8N_AUTO_IMPORT_WORKFLOWS=$AUTO_IMPORT)"
    return 0
  fi

  if [ ! -d "$WORKFLOWS_DIR" ]; then
    log "no workflows dir: $WORKFLOWS_DIR"
    return 0
  fi

  set -- "$WORKFLOWS_DIR"/*.json
  if [ ! -e "$1" ]; then
    log "no *.json in $WORKFLOWS_DIR"
    return 0
  fi

  fp="$(workflows_fingerprint)"
  import_needed=true
  if [ "$FORCE_IMPORT" != "true" ] && [ "$FORCE_IMPORT" != "1" ] \
    && [ -f "$FINGERPRINT_FILE" ] && [ "$(cat "$FINGERPRINT_FILE" 2>/dev/null || true)" = "$fp" ]; then
    log "skip import (workflows unchanged, fingerprint=${fp})"
    import_needed=false
  fi

  import_start="$(now_sec)"
  if [ "$import_needed" = "true" ]; then
    if [ "$FORCE_IMPORT" = "true" ] || [ "$FORCE_IMPORT" = "1" ]; then
      log "force import (N8N_AUTO_IMPORT_FORCE=$FORCE_IMPORT)"
    fi

    log "start import from $WORKFLOWS_DIR"

    if [ -f "$SCRIPTS_DIR/n8n_ensure_credential_stubs.js" ]; then
      log "ensure credential stubs"
      run_node "$SCRIPTS_DIR/n8n_ensure_credential_stubs.js" || warn "credential stubs step failed"
    else
      warn "missing $SCRIPTS_DIR/n8n_ensure_credential_stubs.js"
    fi

    if [ -f "$SCRIPTS_DIR/n8n_preserve_folders.js" ]; then
      log "snapshot UI folders"
      run_node "$SCRIPTS_DIR/n8n_preserve_folders.js" snapshot || warn "folder snapshot failed"
    fi

    log "import:workflow"
    if n8n import:workflow --separate --input="$WORKFLOWS_DIR"; then
      log "import:workflow ok"
    else
      warn "import:workflow failed"
    fi

    if [ -f "$SCRIPTS_DIR/n8n_preserve_folders.js" ]; then
      log "restore UI folders"
      run_node "$SCRIPTS_DIR/n8n_preserve_folders.js" restore || warn "folder restore failed"
    fi

    if [ -f "$SCRIPTS_DIR/n8n_sanitize_timestamps.js" ]; then
      log "sanitize timestamps"
      run_node "$SCRIPTS_DIR/n8n_sanitize_timestamps.js" || warn "timestamp sanitize failed"
    fi

    if printf '%s' "$fp" >"$FINGERPRINT_FILE" 2>/dev/null; then
      log "fingerprint saved"
    else
      warn "could not write fingerprint to $FINGERPRINT_FILE"
    fi
  fi
  log_phase import "$import_start"

  publish_start="$(now_sec)"
  if [ "$import_needed" = "true" ]; then
    run_publish_pass true
  else
    run_publish_pass false
  fi
  log_phase publish "$publish_start"

  log "done"
}

pre_start="$(now_sec)"
do_import || warn "auto-import aborted with error"

tg_start="$(now_sec)"
if [ -f "$SCRIPTS_DIR/n8n_clear_telegram_webhooks.js" ]; then
  log "clear Telegram webhooks before start"
  run_node "$SCRIPTS_DIR/n8n_clear_telegram_webhooks.js" || warn "telegram webhook clear failed"
fi
log_phase telegram_clear "$tg_start"
log_phase pre_start "$pre_start"

ORIGINAL_ENTRYPOINT="${N8N_ORIGINAL_ENTRYPOINT:-/docker-entrypoint.sh}"

start_n8n() {
  if [ -x "$ORIGINAL_ENTRYPOINT" ]; then
    "$ORIGINAL_ENTRYPOINT" "$@"
  elif [ "$#" -eq 0 ]; then
    n8n
  else
    "$@"
  fi
}

start_n8n "$@" &
n8n_pid=$!

if [ -f "$SCRIPTS_DIR/n8n_reregister_telegram.js" ]; then
  (
    run_node "$SCRIPTS_DIR/n8n_reregister_telegram.js" || warn "telegram live re-register failed"
  ) &
fi

wait "$n8n_pid"
exit $?
