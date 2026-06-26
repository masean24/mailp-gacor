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
git clone https://github.com/masean24/hubify-mail.git /var/www/hubify-mail
cd /var/www/hubify-mail
sudo bash scripts/setup-vps.sh
```

The installer asks for the web/mail host domain, email domains, database password, JWT secret, external API key, admin login, optional Telegram config, and optional HTTPS setup.

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
sudo git clone https://github.com/masean24/hubify-mail.git
sudo chown -R $USER:$USER hubify-mail
cd hubify-mail

# Setup database schema
psql -U hubify -d hubify_mail -f sql/schema.sql
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
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=60
API_KEY=your_secret_api_key_here
API_RATE_LIMIT_MAX=120
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
pm2 start src/index.js --name hubify-api
pm2 save
pm2 startup
```

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

```bash
cd /var/www/hubify-mail
git pull

# If schema changed (biasanya tidak perlu)
# psql -U hubify -d hubify_mail -f sql/add-names-table.sql

# Rebuild frontend
cd frontend
npm install
npm run build

# Restart API
cd /var/www/hubify-mail/backend
pm2 restart hubify-api
```

---

## Domain Langsung Aktif dari Web (Postfix Sync)

Agar domain yang kamu tambah dari Admin Dashboard langsung terdeteksi Postfix (tanpa edit `main.cf` manual), lakukan sekali di VPS:

**1. Update kode dulu** (lihat "Updating the Application" di atas).

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
