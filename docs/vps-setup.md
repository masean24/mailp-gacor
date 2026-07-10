# VPS Setup Guide - Hubify Mail

Complete guide for deploying Hubify Mail on Ubuntu VPS.

## Prerequisites
- Ubuntu 22.04+ VPS with min 1GB RAM
- Domain: `hubify.store`
- Subdomain: `mail.hubify.store` (for web access)
- Root/sudo access

---

## Quick Install (Recommended)

For a fresh VPS, use the interactive installer:

```bash
sudo apt update
sudo apt install -y git
git clone https://github.com/masean24/mailp-gacor.git /var/www/hubify-mail
cd /var/www/hubify-mail
sudo bash scripts/setup-vps.sh
```

The installer asks for the web/mail host domain, email domains, database password, JWT secret, external API key, admin login, public protected-inbox limits, optional Telegram config, and optional HTTPS setup. It automatically generates the protected-inbox token secret and reservation IP salt, writes all required environment variables, and applies every database migration in order.

After install, point DNS to the VPS:

| Type | Name | Value | Priority | Proxy |
|------|------|-------|----------|-------|
| A | mail | YOUR_VPS_IP | - | OFF |
| MX | @ | mail.hubify.store | 10 | - |

If using Cloudflare, keep the mail host DNS record DNS-only / proxy OFF. SMTP on port 25 will not work through the orange-cloud proxy.

Manual setup is still documented below.

---

## Step 1: Update System
```bash
sudo apt update && sudo apt upgrade -y
```

## Step 2: Install Dependencies
```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Postfix
sudo apt install -y postfix
# Select "Internet Site" and enter your domain: hubify.store

# PM2
sudo npm install -g pm2

# Nginx & Certbot
sudo apt install -y nginx certbot python3-certbot-nginx
```

## Step 3: Setup PostgreSQL
```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE hubify_mail;
CREATE USER hubify WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE hubify_mail TO hubify;
ALTER DATABASE hubify_mail OWNER TO hubify;
\c hubify_mail
GRANT ALL ON SCHEMA public TO hubify;
\q
```

## Step 4: Clone & Setup Project
```bash
cd /var/www
sudo git clone https://github.com/masean24/mailp-gacor.git hubify-mail
sudo chown -R $USER:$USER hubify-mail
cd hubify-mail

# Setup database schema
psql -U hubify -d hubify_mail -f sql/schema.sql

# Fresh installs already include otp_code + indexes. If you are upgrading an
# EXISTING database, run the migration instead (safe, no data loss):
# psql -U hubify -d hubify_mail -f sql/migrations/001_high_concurrency.sql
# psql -U hubify -d hubify_mail -f sql/migrations/002_protected_inboxes_and_domain_verification.sql
# psql -U hubify -d hubify_mail -f sql/migrations/003_reservation_management.sql
# psql -U hubify -d hubify_mail -f sql/migrations/004_protected_inbox_lifetime.sql
```

## Step 5: Setup Backend
```bash
cd /var/www/hubify-mail/backend
npm install

# Create .env file
cat > .env << 'EOF'
DATABASE_URL=postgresql://hubify:your_secure_password@localhost:5432/hubify_mail
PORT=3000
NODE_ENV=production
JWT_SECRET=your_super_secret_jwt_key_change_this
INBOX_ACCESS_JWT_SECRET=another_long_random_secret_for_protected_inbox_tokens
PUBLIC_RESERVATION_MAX_PER_IP=5
PUBLIC_RESERVATION_TTL_DAYS=7
INBOX_RESERVATION_IP_SALT=replace_with_a_long_random_secret
CORS_ALLOWED_ORIGINS=https://mail.hubify.store
MAIL_SERVER_HOSTNAME=mail.hubify.store
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60
API_KEY=your_secret_api_key_here
API_RATE_LIMIT_MAX=5000
# High-concurrency tuning (see "High-Concurrency Settings" section below)
PG_POOL_MAX=20
PG_IDLE_TIMEOUT_MS=30000
PG_CONNECTION_TIMEOUT_MS=10000
MAX_EMAIL_BYTES=1048576
INBOX_LIST_LIMIT=20
PM2_INSTANCES=2
EOF

# Set permission for Postfix
sudo chown www-data:www-data .env
sudo chmod 644 .env
```

## Step 6: Create Admin User
```bash
cd /var/www/hubify-mail/backend
node scripts/create-admin.js your_username your_password
```

> ⚠️ **IMPORTANT**: Remember this password! Admin panel: `https://mail.hubify.store/admin.html`

## Step 7: Build Frontend
```bash
cd /var/www/hubify-mail/frontend
npm install
npm run build
```

## Step 8: Configure Postfix

### Edit main.cf
```bash
sudo nano /etc/postfix/main.cf
```

Add/modify these lines:
```ini
myhostname = mail.hubify.store
mydomain = hubify.store
myorigin = $mydomain
mydestination = localhost

# Virtual domains
virtual_mailbox_domains = hubify.store
virtual_transport = hubify

# Security
smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination
```

### Add pipe transport to master.cf
```bash
sudo nano /etc/postfix/master.cf
```

Add at the end:
```
hubify unix - n n - - pipe
  flags=F user=www-data argv=/usr/bin/node /var/www/hubify-mail/backend/src/handlers/email-handler.js
```

### Reload Postfix
```bash
sudo postfix reload
```

## Step 9: Configure Nginx
```bash
sudo nano /etc/nginx/sites-available/hubify
```

```nginx
server {
    listen 80;
    server_name mail.hubify.store;

    root /var/www/hubify-mail/frontend/dist;

    # Browser hardening for the static frontend.
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;

    # /admin (tanpa .html) → tampilkan halaman admin, bukan main page
    location = /admin {
        try_files /admin.html =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/hubify /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## Step 10: Setup SSL
```bash
sudo certbot --nginx -d mail.hubify.store
```

## Step 11: Start API with PM2
```bash
cd /var/www/hubify-mail/backend
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

> `ecosystem.config.cjs` menjalankan API dalam cluster mode. Atur jumlah worker via `PM2_INSTANCES` di `.env` (`max` untuk semua core, atau angka seperti `2`). Bot Telegram hanya jalan di worker instance 0 supaya tidak bentrok (error 409 getUpdates).
>
> Restart setelah update: `pm2 restart ecosystem.config.cjs --env production`

## Step 12: Configure Firewall
```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 25
sudo ufw enable
```

## Step 13: Setup DNS Records

Configure these records at your domain provider:

| Type | Name | Value | Priority | Proxy |
|------|------|-------|----------|-------|
| A | mail | YOUR_VPS_IP | - | OFF |
| MX | @ | mail.hubify.store | 10 | - |

> ⚠️ **IMPORTANT**: Delete other MX records from registrar (eforward*.registrar-servers.com)

---

## Testing

### Test Email Receiving
```bash
# Monitor logs
sudo tail -f /var/log/mail.log

# In another terminal
pm2 logs hubify-api
```

Send email to `test@hubify.store` and check if it appears in logs.

### Test Web
Open: `https://mail.hubify.store`

---

## Updating the Application

Use the update script on an existing installation. It preserves `backend/.env`,
creates an environment + PostgreSQL backup, pulls the tracked branch, applies
all migrations in filename order, rebuilds the frontend, reloads PM2 and
Nginx, then checks `/health`.

For the first update that adds this script, use one command:

```bash
cd /var/www/hubify-mail && git pull --ff-only && sudo bash scripts/update-vps.sh
```

After that, every update is:

```bash
cd /var/www/hubify-mail && sudo bash scripts/update-vps.sh
```

If the repository lives elsewhere, pass its absolute path:

```bash
sudo bash /path/to/hubify-mail/scripts/update-vps.sh /path/to/hubify-mail
```

Backups are stored under `/var/backups/hubify-mail/<UTC timestamp>/`. The
script refuses to update when tracked files contain uncommitted changes and
never rewrites API keys, JWT secrets, database credentials, Telegram settings,
emails, or reservations. Only one update process can run at a time.

---

## Domain Langsung Aktif dari Web (Postfix Sync)

Agar domain yang kamu tambah dari Admin Dashboard langsung terdeteksi Postfix (tanpa edit `main.cf` manual), lakukan sekali di VPS:

**1. Update kode dulu** dengan `scripts/update-vps.sh` di atas.

**2. Script executable:**
```bash
chmod +x /var/www/hubify-mail/backend/scripts/sync-postfix.sh
```

**3. Izinkan user API jalankan script dengan sudo:**
```bash
sudo visudo
```
Tambahkan satu baris (ganti `www-data` jika PM2/API pakai user lain):
```
www-data ALL=(ALL) NOPASSWD: /var/www/hubify-mail/backend/scripts/sync-postfix.sh
```
Simpan (Ctrl+O, Enter, Ctrl+X di nano).

**4. Aktifkan di `.env` backend:**
```bash
sudo nano /var/www/hubify-mail/backend/.env
```
Tambahkan:
```
POSTFIX_SYNC_ENABLED=true
```
Simpan.

**5. Restart API:**
```bash
pm2 restart hubify-api
```

Setelah itu, tambah/ubah/hapus domain dari web → Postfix otomatis di-update dan domain langsung aktif. Detail lengkap: [docs/domain-guide.md](domain-guide.md).

---

## Adding New Email Domains

See [docs/domain-guide.md](domain-guide.md) for complete guide.

---

## High-Concurrency Settings

Untuk workload bulk (ambil OTP dari ratusan akun paralel), tuning berikut bikin sistem tahan banting. Semua via `.env` backend.

| Env | Default | Fungsi |
|-----|---------|--------|
| `API_RATE_LIMIT_MAX` | `5000` | Limit req/menit per API key untuk `/api/ext/*`. 400 akun × poll 5 detik ≈ 4800 req/menit, jadi 5000 sudah cukup. Naikkan kalau lebih banyak. |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Limit req/menit per IP untuk route publik + admin. Tidak kena ke `/api/ext`. |
| `MAX_EMAIL_BYTES` | `1048576` (1MB) | Email lebih besar di-drop graceful (Postfix tidak retry selamanya). |
| `PG_POOL_MAX` | `20` | Koneksi pool PostgreSQL per worker. |
| `PM2_INSTANCES` | `2` | Jumlah worker cluster (`max` = semua core). |
| `INBOX_LIST_LIMIT` | `20` | Jumlah email default di response list/polling. |

**Penting — sizing koneksi database:**
Total koneksi = `PM2_INSTANCES × PG_POOL_MAX` (plus headroom untuk pipe handler Postfix & admin tools). Pastikan PostgreSQL `max_connections` cukup. Contoh: `PM2_INSTANCES=4` × `PG_POOL_MAX=20` = 80 koneksi → set `max_connections` minimal ~120.

```bash
# Cek & naikkan max_connections PostgreSQL bila perlu
sudo -u postgres psql -c "SHOW max_connections;"
sudo -u postgres psql -c "ALTER SYSTEM SET max_connections = 200;"
sudo systemctl restart postgresql
```

**Rekomendasi polling client:** poll endpoint ringan `GET /api/ext/inbox/{email}/otp/latest` tiap **5 detik**, timeout **max 60 detik** per akun, lalu `DELETE` inbox setelah OTP didapat. Detail di `docs/api-external.md`.

**Apply perubahan env:**
```bash
sudo nano /var/www/hubify-mail/backend/.env
pm2 restart ecosystem.config.cjs --env production
```

---

## Troubleshooting

### Email not received
```bash
# Check postfix config
sudo postconf virtual_mailbox_domains
sudo postconf virtual_transport

# Check logs
sudo tail -f /var/log/mail.log
```

### Database connection error
```bash
# Check .env file
cat /var/www/hubify-mail/backend/.env

# Test connection
psql -U hubify -d hubify_mail -c "SELECT 1;"
```

### API not responding
```bash
pm2 status
pm2 logs hubify-api
```
