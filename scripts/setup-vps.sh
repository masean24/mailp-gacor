#!/usr/bin/env bash

set -Eeuo pipefail

APP_NAME="hubify-mail"
DEFAULT_REPO_URL="https://github.com/masean24/hubify-mail.git"
DEFAULT_APP_DIR="/var/www/hubify-mail"
DEFAULT_WEB_DOMAIN="mail.hubify.store"
DEFAULT_MAIL_DOMAINS="hubify.store"
DEFAULT_DB_NAME="hubify_mail"
DEFAULT_DB_USER="hubify"
DEFAULT_API_PORT="3000"

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

need_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    die "Run this script as root: sudo bash scripts/setup-vps.sh"
  fi
}

prompt() {
  local label="$1"
  local default="${2:-}"
  local value

  if [ -n "$default" ]; then
    read -r -p "$label [$default]: " value
    printf '%s' "${value:-$default}"
  else
    read -r -p "$label: " value
    printf '%s' "$value"
  fi
}

prompt_secret() {
  local label="$1"
  local default="${2:-}"
  local value

  if [ -n "$default" ]; then
    read -r -s -p "$label [auto-generated, press Enter to use]: " value
    printf '\n' >&2
    printf '%s' "${value:-$default}"
  else
    read -r -s -p "$label: " value
    printf '\n' >&2
    printf '%s' "$value"
  fi
}

prompt_yes_no() {
  local label="$1"
  local default="${2:-Y}"
  local value

  read -r -p "$label [$default]: " value
  value="${value:-$default}"
  case "$value" in
    y|Y|yes|YES) return 0 ;;
    n|N|no|NO) return 1 ;;
    *) warn "Please answer yes or no."; prompt_yes_no "$label" "$default" ;;
  esac
}

random_secret() {
  openssl rand -hex 32
}

validate_identifier() {
  local label="$1"
  local value="$2"

  if ! printf "%s" "$value" | grep -Eq '^[a-zA-Z_][a-zA-Z0-9_]*$'; then
    die "$label must contain only letters, numbers, and underscores, and must not start with a number."
  fi
}

sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

csv_to_postfix_domains() {
  printf "%s" "$1" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' | paste -sd ',' - | sed 's/,/, /g'
}

csv_to_sql_values() {
  printf "%s" "$1" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | grep -E '^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' \
    | awk '{ gsub(/\047/, "\047\047"); printf "%s(\047%s\047)", sep, $0; sep=", " }'
}

install_packages() {
  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive

  apt-get update
  apt-get install -y ca-certificates curl gnupg git nginx certbot python3-certbot-nginx postgresql postgresql-contrib ufw openssl

  if ! command -v node >/dev/null 2>&1 || ! node -v | grep -Eq '^v20\.'; then
    log "Installing Node.js 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi

  debconf-set-selections <<< "postfix postfix/mailname string ${WEB_DOMAIN}"
  debconf-set-selections <<< "postfix postfix/main_mailer_type string Internet Site"
  apt-get install -y postfix

  if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2
  fi
}

checkout_repo() {
  log "Preparing app directory: ${APP_DIR}"
  mkdir -p "$(dirname "$APP_DIR")"

  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
  elif [ -e "$APP_DIR" ] && [ "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 | wc -l)" -gt 0 ]; then
    die "$APP_DIR exists and is not an empty git checkout. Move it first or choose a different APP_DIR."
  else
    git clone "$REPO_URL" "$APP_DIR"
  fi

  chown -R "${SUDO_USER:-$USER}:${SUDO_USER:-$USER}" "$APP_DIR"
}

setup_database() {
  log "Setting up PostgreSQL database"
  local db_pass_sql
  db_pass_sql="$(sql_quote "$DB_PASS")"

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
    sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${db_pass_sql}';"
  else
    sudo -u postgres psql -c "ALTER USER ${DB_USER} WITH PASSWORD '${db_pass_sql}';"
  fi

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  fi

  sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"

  if ! PGPASSWORD="$DB_PASS" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT to_regclass('public.domains')" | grep -q domains; then
    PGPASSWORD="$DB_PASS" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -f "$APP_DIR/sql/schema.sql"
  else
    warn "Database schema already exists; skipping sql/schema.sql to avoid overwriting data."
  fi

  local domain_values
  domain_values="$(csv_to_sql_values "$MAIL_DOMAINS")"
  if [ -n "$domain_values" ]; then
    PGPASSWORD="$DB_PASS" psql -h localhost -U "$DB_USER" -d "$DB_NAME" \
      -c "INSERT INTO domains (domain) VALUES ${domain_values} ON CONFLICT (domain) DO UPDATE SET is_active = true;"
  fi
}

write_env() {
  log "Writing backend .env"
  cat > "$APP_DIR/backend/.env" <<EOF
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
PORT=${API_PORT}
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60
POSTFIX_SYNC_ENABLED=${POSTFIX_SYNC_ENABLED}
API_KEY=${API_KEY}
API_RATE_LIMIT_MAX=120
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_OWNER_ID=${TELEGRAM_OWNER_ID}
TELEGRAM_CHANNEL_ID=${TELEGRAM_CHANNEL_ID}
EOF

  chown www-data:www-data "$APP_DIR/backend/.env"
  chmod 640 "$APP_DIR/backend/.env"
}

install_node_deps() {
  log "Installing backend dependencies"
  (cd "$APP_DIR/backend" && npm ci --omit=dev)

  log "Building frontend"
  (cd "$APP_DIR/frontend" && npm ci && npm run build)
}

configure_postfix() {
  log "Configuring Postfix"
  local domains_list
  domains_list="$(csv_to_postfix_domains "$MAIL_DOMAINS")"

  postconf -e "myhostname = ${WEB_DOMAIN}"
  postconf -e "mydomain = ${PRIMARY_MAIL_DOMAIN}"
  postconf -e 'myorigin = $mydomain'
  postconf -e "mydestination = localhost"
  postconf -e "virtual_mailbox_domains = ${domains_list}"
  postconf -e "virtual_transport = hubify"
  postconf -e "smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination"

  if ! grep -qE '^hubify[[:space:]]+unix' /etc/postfix/master.cf; then
    cat >> /etc/postfix/master.cf <<EOF

hubify unix - n n - - pipe
  flags=F user=www-data argv=/usr/bin/node ${APP_DIR}/backend/src/handlers/email-handler.js
EOF
  fi

  chmod +x "$APP_DIR/backend/scripts/sync-postfix.sh"

  if [ "$POSTFIX_SYNC_ENABLED" = "true" ]; then
    local sudoers_file="/etc/sudoers.d/hubify-postfix-sync"
    cat > "$sudoers_file" <<EOF
www-data ALL=(ALL) NOPASSWD: ${APP_DIR}/backend/scripts/sync-postfix.sh
EOF
    chmod 440 "$sudoers_file"
  fi

  systemctl enable postfix
  systemctl restart postfix
}

configure_nginx() {
  log "Configuring Nginx"
  cat > /etc/nginx/sites-available/hubify <<EOF
server {
    listen 80;
    server_name ${WEB_DOMAIN};

    root ${APP_DIR}/frontend/dist;
    index index.html;

    location = /admin {
        try_files /admin.html =404;
    }

    location /api {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

  ln -sf /etc/nginx/sites-available/hubify /etc/nginx/sites-enabled/hubify
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable nginx
  systemctl reload nginx
}

create_admin() {
  if [ -z "$ADMIN_USER" ] || [ -z "$ADMIN_PASS" ]; then
    warn "Skipping admin creation because username/password was empty."
    return
  fi

  log "Creating admin user"
  (cd "$APP_DIR/backend" && node scripts/create-admin.js "$ADMIN_USER" "$ADMIN_PASS") || warn "Admin user may already exist; continuing."
}

start_pm2() {
  log "Starting backend with PM2"
  local run_user="${SUDO_USER:-root}"

  if sudo -u "$run_user" pm2 describe hubify-api >/dev/null 2>&1; then
    sudo -u "$run_user" pm2 restart hubify-api --update-env
  else
    sudo -u "$run_user" bash -lc "cd '$APP_DIR/backend' && pm2 start src/index.js --name hubify-api"
  fi

  sudo -u "$run_user" pm2 save
  env PATH="$PATH" pm2 startup systemd -u "$run_user" --hp "$(eval echo "~$run_user")" >/tmp/hubify-pm2-startup.log || true
}

configure_firewall() {
  if ! prompt_yes_no "Enable/update UFW firewall rules for SSH, HTTP, HTTPS, SMTP?" "Y"; then
    return
  fi

  log "Configuring firewall"
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 25/tcp
  ufw --force enable
}

setup_ssl() {
  if ! prompt_yes_no "Install HTTPS certificate with Certbot now? DNS A record must already point to this VPS" "Y"; then
    return
  fi

  log "Requesting Let's Encrypt certificate"
  if [ -n "$LETSENCRYPT_EMAIL" ]; then
    certbot --nginx -d "$WEB_DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect
  else
    certbot --nginx -d "$WEB_DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
  fi
}

print_summary() {
  cat <<EOF

Done.

Web:       https://${WEB_DOMAIN}
Admin:     https://${WEB_DOMAIN}/admin
API:       https://${WEB_DOMAIN}/api/ext
API key:   ${API_KEY}
Mail MX:   point each mail domain to ${WEB_DOMAIN} with priority 10

Useful checks:
  pm2 status
  pm2 logs hubify-api
  sudo tail -f /var/log/mail.log
  sudo postconf virtual_mailbox_domains

If email does not arrive, make sure:
  - A record: ${WEB_DOMAIN} -> this VPS public IP
  - MX record: each mail domain -> ${WEB_DOMAIN}
  - Cloudflare proxy is OFF for ${WEB_DOMAIN}
  - Port 25 is open by VPS provider
EOF
}

main() {
  need_root

  log "Hubify Mail VPS setup"
  REPO_URL="$(prompt "Git repo URL" "$DEFAULT_REPO_URL")"
  APP_DIR="$(prompt "Install directory" "$DEFAULT_APP_DIR")"
  WEB_DOMAIN="$(prompt "Web/mail host domain" "$DEFAULT_WEB_DOMAIN")"
  MAIL_DOMAINS="$(prompt "Email domains, comma-separated" "$DEFAULT_MAIL_DOMAINS")"
  PRIMARY_MAIL_DOMAIN="$(printf "%s" "$MAIL_DOMAINS" | cut -d ',' -f 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  DB_NAME="$(prompt "PostgreSQL database name" "$DEFAULT_DB_NAME")"
  DB_USER="$(prompt "PostgreSQL user" "$DEFAULT_DB_USER")"
  validate_identifier "PostgreSQL database name" "$DB_NAME"
  validate_identifier "PostgreSQL user" "$DB_USER"
  DB_PASS="$(prompt_secret "PostgreSQL password" "$(random_secret)")"
  JWT_SECRET="$(prompt_secret "JWT secret" "$(random_secret)")"
  API_KEY="$(prompt_secret "External API key" "$(random_secret)")"
  API_PORT="$(prompt "Backend port" "$DEFAULT_API_PORT")"
  ADMIN_USER="$(prompt "Admin username, empty to skip" "admin")"
  ADMIN_PASS="$(prompt_secret "Admin password, empty to skip" "$(random_secret)")"
  LETSENCRYPT_EMAIL="$(prompt "Let's Encrypt email, empty allowed" "")"

  if prompt_yes_no "Enable automatic Postfix domain sync from admin/API?" "Y"; then
    POSTFIX_SYNC_ENABLED="true"
  else
    POSTFIX_SYNC_ENABLED="false"
  fi

  TELEGRAM_BOT_TOKEN=""
  TELEGRAM_OWNER_ID=""
  TELEGRAM_CHANNEL_ID=""
  if prompt_yes_no "Configure Telegram bot now?" "N"; then
    TELEGRAM_BOT_TOKEN="$(prompt_secret "Telegram bot token" "")"
    TELEGRAM_OWNER_ID="$(prompt "Telegram owner ID" "")"
    TELEGRAM_CHANNEL_ID="$(prompt "Telegram channel ID, empty allowed" "")"
  fi

  install_packages
  checkout_repo
  setup_database
  write_env
  install_node_deps
  configure_postfix
  configure_nginx
  create_admin
  start_pm2
  configure_firewall
  setup_ssl
  print_summary
}

main "$@"
