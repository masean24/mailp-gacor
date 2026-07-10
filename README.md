# Hubify Store - Temporary Email System

📧 Self-hosted temporary email service with Neo-brutalism UI.

**Web Access**: `https://mail.hubify.store`  
**Email Domain**: `@hubify.store`

## Features

- ✅ Infinite disposable email addresses
- ✅ Multiple domain support
- ✅ 24-hour email TTL with auto-cleanup
- ✅ Real-time inbox polling
- ✅ Admin dashboard with statistics
- ✅ Neo-brutalism design with vector icons
- ✅ Mobile responsive

## Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL
- **Frontend**: Vanilla HTML/CSS/JS + Vite
- **Mail Server**: Postfix (inbound only)

## Project Structure

```
hubify-mail/
├── backend/           # Node.js API server
│   ├── src/
│   │   ├── config/    # Database config
│   │   ├── handlers/  # Postfix pipe handler
│   │   ├── middleware/# Auth & rate limiting
│   │   ├── routes/    # API routes
│   │   ├── services/  # Business logic
│   │   └── index.js   # Entry point
│   └── scripts/       # CLI utilities
├── frontend/          # Vite frontend
│   ├── css/           # Neo-brutalism styles
│   ├── js/            # Frontend logic
│   ├── index.html     # Main page
│   └── admin.html     # Admin dashboard
├── sql/               # Database schema
└── docs/              # Documentation
    ├── vps-setup.md   # VPS deployment guide
    └── domain-guide.md # Domain management
```

## Quick Start (Development)

### 1. Setup Database

```bash
# Create PostgreSQL database
psql -U postgres
CREATE DATABASE hubify_mail;
CREATE USER hubify WITH PASSWORD 'yourpassword';
GRANT ALL ON DATABASE hubify_mail TO hubify;
\q

# Run schema
psql -U hubify -d hubify_mail -f sql/schema.sql
```

### 2. Start Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your database credentials
npm install
npm run dev
```

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

### 4. Create Admin User

```bash
cd backend
node scripts/create-admin.js admin yourpassword
```

### 5. Open Browser

- Main: http://localhost:5173
- Admin: http://localhost:5173/admin.html

## API Endpoints

### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/domains | List active domains |
| POST | /api/inbox/generate | Generate random email |
| POST | /api/inbox/custom | Create custom email |
| POST | /api/inbox/reserve | Create password-protected email (public quota applies) |
| POST | /api/inbox/:address/unlock | Unlock a protected inbox |
| GET | /api/inbox/:address | Get inbox emails |
| GET | /api/email/:id | Get email detail |
| DELETE | /api/inbox/:address | Delete inbox |

### Admin (Protected)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/admin/login | Admin login |
| GET | /api/admin/stats | Dashboard stats |
| GET/POST | /api/admin/domains | Manage domains |
| PATCH/DELETE | /api/admin/domains/:id | Update/delete domain |
| GET | /api/admin/emails/recent | Recent emails |
| POST | /api/admin/cleanup | Trigger cleanup |
| GET/POST | /api/admin/inbox-reservations | List/create protected inboxes; admin dapat melindungi inbox lama dengan `protectExistingInbox: true` |
| PATCH | /api/admin/inbox-reservations/:id | Reset password or enable/disable |
| DELETE | /api/admin/inbox-reservations/:id/inbox | Clear protected inbox contents |
| DELETE | /api/admin/inbox-reservations/:id | Release reservation safely |

## Production Deployment

See [VPS Setup Guide](docs/vps-setup.md) for full deployment instructions.

Fresh VPS:

```bash
sudo bash scripts/setup-vps.sh
```

Existing VPS (preserves `.env`, database, API keys, and secrets):

```bash
sudo bash scripts/update-vps.sh
```

## Adding New Domains

See [Domain Guide](docs/domain-guide.md) for adding new email domains.

## License

MIT
