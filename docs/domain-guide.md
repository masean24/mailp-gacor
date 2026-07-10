# Domain Management Guide

> **Update keamanan:** domain baru sekarang dibuat dalam status `pending_verification`.
> Tambahkan TXT `hubify-mail-verification=<token-yang-ditampilkan-panel>` dan
> MX ke `mail.hubify.store`, lalu klik **Verify** di Admin Dashboard. Domain
> hanya muncul di dropdown dan diterima Postfix setelah TXT valid dan sync
> Postfix berhasil. Domain lama yang sudah ada tetap aktif setelah menjalankan
> migrasi `002_protected_inboxes_and_domain_verification.sql`.

Panduan lengkap untuk menambah dan mengelola domain di Hubify Mail.

## Cara Menambah Domain Baru

### 1. Tambahkan domain di Admin Dashboard
1. Login ke `https://mail.hubify.store/admin.html`
2. Klik tombol **+ Add Domain**
3. Masukkan nama domain baru (contoh: `temp.hubify.store`)
4. Klik **Add Domain**

> 💡 **Alternatif via Telegram Bot:** kamu juga bisa kelola domain langsung dari bot tanpa buka panel.
> - `/adddomain temp.hubify.store` — tambah domain baru
> - `/alldomains` — lihat semua domain + ID + status
> - `/toggledomain <id>` — aktif/nonaktifkan
> - `/deldomain <id>` — hapus
>
> Sama seperti panel, bot juga otomatis sync Postfix kalau `POSTFIX_SYNC_ENABLED=true`.

### 2. Postfix: Langsung Aktif (pilih salah satu)

#### Opsi A: Otomatis dari Web (disarankan)
Agar domain langsung aktif tanpa edit config di VPS, aktifkan Postfix sync sekali saja:

1. **Buat script executable** (di VPS):
```bash
chmod +x /var/www/hubify-mail/backend/scripts/sync-postfix.sh
```

2. **Izinkan user proses API jalankan script dengan sudo** (ganti path jika beda):
```bash
sudo visudo
```
Tambahkan baris (ganti `www-data` jika proses API pakai user lain):
```
www-data ALL=(ALL) NOPASSWD: /var/www/hubify-mail/backend/scripts/sync-postfix.sh
```

3. **Aktifkan di `.env` backend**:
```
POSTFIX_SYNC_ENABLED=true
```
Lalu restart API: `pm2 restart hubify-api`

Setelah itu, setiap kali kamu tambah/ubah/hapus domain dari Admin Dashboard, Postfix akan otomatis di-update dan reload. Jika sync gagal (misal sudo belum di-set), response API tetap sukses dan akan ada `postfixSyncWarning`; domain di database sudah tersimpan, tinggal update `virtual_mailbox_domains` manual sekali.

#### Opsi B: Manual (edit config di VPS)
```bash
sudo nano /etc/postfix/main.cf
```

Cari baris `virtual_mailbox_domains` dan tambahkan domain baru:
```
virtual_mailbox_domains = hubify.store, newdomain.com, anotherdomain.com
```

Lalu:
```bash
sudo postfix reload
```

### 3. Setup DNS untuk Domain Baru
Tambahkan DNS record di domain provider:

| Type | Name | Value | Priority |
|------|------|-------|----------|
| MX | @ | mail.hubify.store | 10 |

> **Note**: Semua domain email akan diarahkan ke mail server yang sama (`mail.hubify.store`).

---

## Arsitektur Domain

```
┌─────────────────────────────────────────────────────┐
│                   HUBIFY.STORE                       │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Web Interface: mail.hubify.store (HTTPS)           │
│                                                      │
│  Email Domains (MX → mail.hubify.store):            │
│    - hubify.store        → test@hubify.store        │
│    - temp.hubify.store   → random@temp.hubify.store │
│    - newdomain.com       → user@newdomain.com       │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### Email tidak masuk ke domain baru
1. Cek MX record: `dig MX newdomain.com`
2. Pastikan domain ada di `virtual_mailbox_domains`
3. Pastikan domain aktif di Admin Dashboard
4. Cek log: `sudo tail -f /var/log/mail.log`

### Domain tidak muncul di dropdown
1. Pastikan domain ada di database dan statusnya `is_active = true`
2. Refresh halaman / clear cache browser
