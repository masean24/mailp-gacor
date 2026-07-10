#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="$APP_DIR/backend/.env"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/backups/hubify-mail/$TIMESTAMP"

log() {
  printf '\n\033[1;32m==>\033[0m %s\n' "$*"
}

warn() {
  printf '\n\033[1;33mWARN:\033[0m %s\n' "$*" >&2
}

die() {
  printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

on_error() {
  local line="$1"
  warn "Update stopped at line ${line}. The previous PM2 process was left running when possible."
  if [ -d "$BACKUP_DIR" ]; then
    warn "Recovery files: $BACKUP_DIR"
  fi
}

trap 'on_error "$LINENO"' ERR

need_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    die "Run as root: sudo bash scripts/update-vps.sh"
  fi
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

read_env_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
    }
    END {
      sub(/\r$/, "", value)
      print value
    }
  ' "$ENV_FILE"
}

run_as_app() {
  if [ "$RUN_USER" = "root" ]; then
    "$@"
  else
    sudo -H -u "$RUN_USER" "$@"
  fi
}

check_prerequisites() {
  need_root

  [ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found; use scripts/setup-vps.sh for a fresh install"

  need_command git
  need_command node
  need_command npm
  need_command psql
  need_command pg_dump
  need_command pm2
  need_command curl
  need_command flock
  need_command nginx
  need_command openssl
  need_command systemctl

  RUN_USER="$(stat -c '%U' "$APP_DIR")"
  id "$RUN_USER" >/dev/null 2>&1 || die "App user not found: $RUN_USER"
  if [ "$RUN_USER" != "root" ]; then
    need_command sudo
  fi

  exec 9>/var/lock/hubify-mail-update.lock
  flock -n 9 || die "Another Hubify update is already running"

  DATABASE_URL="$(read_env_value DATABASE_URL)"
  [ -n "$DATABASE_URL" ] || die "DATABASE_URL is missing from $ENV_FILE"
  API_PORT="$(read_env_value PORT)"
  API_PORT="${API_PORT:-3000}"

  # setup-vps.sh intentionally makes the Postfix sync helper executable.
  # Ignore permission-bit-only differences, but still stop for staged or
  # unstaged content changes so an update never overwrites user edits.
  if ! run_as_app git -c core.fileMode=false -C "$APP_DIR" diff --quiet \
    || ! run_as_app git -c core.fileMode=false -C "$APP_DIR" diff --cached --quiet; then
    die "Tracked file contents have local changes. Commit or stash them before updating."
  fi
}

append_env_if_missing() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    return 0
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  ADDED_ENV_KEYS+=("$key")
}

detect_mail_host() {
  local mail_host
  mail_host="$(read_env_value MAIL_SERVER_HOSTNAME)"

  if [ -z "$mail_host" ] && [ -r /etc/nginx/sites-enabled/hubify ]; then
    mail_host="$(awk '$1 == "server_name" { gsub(/;/, "", $2); print $2; exit }' /etc/nginx/sites-enabled/hubify)"
  fi
  if [ -z "$mail_host" ] && command -v postconf >/dev/null 2>&1; then
    mail_host="$(postconf -h myhostname 2>/dev/null || true)"
  fi

  if ! printf '%s' "$mail_host" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'; then
    die "Could not detect the public mail hostname. Add MAIL_SERVER_HOSTNAME and CORS_ALLOWED_ORIGINS to $ENV_FILE, then retry."
  fi
  printf '%s' "$mail_host"
}

ensure_env_defaults() {
  log "Adding missing environment keys without changing existing values"
  local mail_host
  mail_host="$(detect_mail_host)"
  ADDED_ENV_KEYS=()

  append_env_if_missing INBOX_ACCESS_JWT_SECRET "$(openssl rand -hex 32)"
  append_env_if_missing INBOX_ACCESS_TOKEN_TTL "15m"
  append_env_if_missing INBOX_UNLOCK_MAX_ATTEMPTS "5"
  append_env_if_missing INBOX_UNLOCK_WINDOW_MS "900000"
  append_env_if_missing PUBLIC_RESERVATION_MAX_PER_IP "5"
  append_env_if_missing PUBLIC_RESERVATION_TTL_DAYS "7"
  append_env_if_missing INBOX_RESERVATION_IP_SALT "$(openssl rand -hex 32)"
  append_env_if_missing MAIL_SERVER_HOSTNAME "$mail_host"
  append_env_if_missing CORS_ALLOWED_ORIGINS "https://${mail_host},http://${mail_host}"

  if [ "${#ADDED_ENV_KEYS[@]}" -gt 0 ]; then
    log "Added environment keys: ${ADDED_ENV_KEYS[*]}"
  else
    log "Environment already contains all required keys"
  fi
}

backup_current_install() {
  log "Backing up environment and PostgreSQL database"
  install -d -m 700 "$BACKUP_DIR"
  install -m 600 "$ENV_FILE" "$BACKUP_DIR/backend.env"
  pg_dump --format=custom --file="$BACKUP_DIR/database.dump" "$DATABASE_URL"
  chmod 600 "$BACKUP_DIR/database.dump"
}

pull_code() {
  log "Pulling the latest code"
  run_as_app git -c core.fileMode=false -C "$APP_DIR" pull --ff-only
}

apply_migrations() {
  log "Applying idempotent database migrations"
  local migration_path
  for migration_path in "$APP_DIR"/sql/migrations/*.sql; do
    [ -f "$migration_path" ] || continue
    log "Migration: $(basename "${migration_path%.sql}")"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration_path"
  done
}

install_and_build() {
  log "Installing production backend dependencies"
  run_as_app npm --prefix "$APP_DIR/backend" ci --omit=dev

  log "Installing and building frontend"
  run_as_app npm --prefix "$APP_DIR/frontend" ci
  local build_dir="dist-update-$TIMESTAMP"
  run_as_app npm --prefix "$APP_DIR/frontend" run build -- --outDir "$build_dir"

  [ -d "$APP_DIR/frontend/$build_dir" ] || die "Frontend build output was not created"
  if [ -d "$APP_DIR/frontend/dist" ]; then
    mv "$APP_DIR/frontend/dist" "$BACKUP_DIR/frontend-dist-before-swap"
  fi
  mv "$APP_DIR/frontend/$build_dir" "$APP_DIR/frontend/dist"
}

restart_services() {
  log "Reloading Hubify API with PM2"
  if run_as_app pm2 describe hubify-api >/dev/null 2>&1; then
    run_as_app pm2 reload "$APP_DIR/backend/ecosystem.config.cjs" --env production --update-env
  else
    run_as_app pm2 start "$APP_DIR/backend/ecosystem.config.cjs" --env production
  fi
  run_as_app pm2 save

  log "Checking and reloading Nginx"
  nginx -t
  systemctl reload nginx
}

verify_health() {
  log "Waiting for API health check"
  local attempt
  for attempt in $(seq 1 15); do
    if curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  die "API health check failed on port ${API_PORT}. Run: sudo -u ${RUN_USER} pm2 logs hubify-api"
}

print_summary() {
  local commit
  commit="$(run_as_app git -C "$APP_DIR" rev-parse --short HEAD)"
  cat <<EOF

Update complete.

Commit:  ${commit}
Backup:  ${BACKUP_DIR}
Health:  http://127.0.0.1:${API_PORT}/health

The existing .env, API keys, JWT secrets, database password, Telegram config,
emails, and reservations were preserved. Missing feature keys were added safely.
EOF
}

main() {
  check_prerequisites
  backup_current_install
  ensure_env_defaults
  pull_code
  apply_migrations
  install_and_build
  restart_services
  verify_health
  print_summary
}

main "$@"
