# Rancangan Fitur Domain, Direct Inbox, dan Protected Inbox

Dokumen ini adalah baseline implementasi. Setiap perubahan harus dibandingkan dengan dokumen ini agar tidak ada jalur akses yang terlewat atau perilaku lama yang berubah tanpa sengaja.

## Tujuan

1. Pengguna dapat menghubungkan domain miliknya ke Hubify Mail dengan panduan DNS.
2. Inbox dapat dibuka langsung melalui URL yang memuat alamat email.
3. Alamat tertentu dapat di-reserve dan dilindungi password.
4. Inbox publik yang sudah ada, generator, OTP Finder, admin domain, dan external API tetap berfungsi.

## Keputusan Produk yang Sudah Disepakati

- Email/inbox biasa tetap publik dan berumur 24 jam seperti perilaku saat ini.
- Email yang di-reserve bersifat protected: password diperlukan untuk membaca inbox, OTP, dan detail email, atau untuk menghapus inbox tersebut.
- API eksternal tetap dipakai untuk membuat email biasa dan mengambil OTP inbox biasa.
- API eksternal **tidak** akan diberi akses untuk membaca protected inbox. API key bukan bypass password inbox.
- URL direct inbox memakai alamat yang di-encode, misalnya `/raihan%40zephyr.com` untuk `raihan@zephyr.com`.
- Domain hanya dapat menerima email jika sudah diverifikasi kepemilikannya, DNS/MX-nya diarahkan ke server, dan Postfix berhasil disinkronkan.
- Tidak ada fitur "anti DevTools" sebagai kontrol keamanan. Keamanan harus dipastikan backend, bukan JavaScript di browser.

## Kondisi Saat Ini yang Wajib Dipertahankan atau Diamankan

- Public API membuat dan membaca inbox melalui `/api/inbox/*`.
- External API menggunakan `X-API-Key` pada `/api/ext/*`.
- Admin API menggunakan JWT pada `/api/admin/*`.
- Postfix menerima email lalu menjalankan `backend/src/handlers/email-handler.js` melalui pipe.
- Inbox dan email publik dibersihkan setelah 24 jam.
- Saat ini detail email dapat diambil berdasarkan ID global. Saat protected inbox ditambahkan, endpoint ini harus selalu mengikat email ke hak akses inbox asalnya.
- Telegram, Discord, daftar recent emails admin, serta endpoint OTP tidak boleh menjadi jalur bypass protected inbox.

## Desain Domain Milik Pengguna

### Status domain

Domain tidak langsung aktif saat dikirim pengguna. Gunakan status berikut:

- `pending_verification`: domain dibuat, token TXT tersedia, belum terbukti dimiliki.
- `verified`: TXT terdeteksi, menunggu aktivasi/sinkronisasi penerimaan email.
- `active`: Postfix sudah disinkronkan; domain boleh masuk dropdown dan menerima email.
- `sync_failed`: verifikasi berhasil tetapi sinkronisasi Postfix gagal; domain tidak boleh muncul di dropdown.
- `disabled`: domain sengaja dimatikan oleh admin/pemilik.

Data tambahan yang diperlukan pada domain atau tabel onboarding terpisah:

- token verifikasi TXT;
- waktu dibuat, diverifikasi, dan terakhir dicek;
- status sinkronisasi dan error terakhir;
- identitas pemilik bila self-service domain dibuka untuk pengguna umum.

### Alur onboarding

1. Pengguna memasukkan nama domain.
2. Server membuat token unik dan menampilkan instruksi TXT serta MX.
3. Pengguna menambahkan TXT untuk verifikasi dan MX menuju mail server Hubify.
4. Pengguna menekan cek verifikasi; server memeriksa TXT melalui DNS.
5. Jika valid, server mencoba sinkronisasi Postfix.
6. Hanya jika sinkronisasi sukses, domain menjadi `active`.
7. UI menampilkan status dan tombol cek ulang; dokumentasi DNS dapat disalin langsung.

### Batasan

- Domain arbitrer yang belum terdaftar dan MX-nya belum menuju server tidak dapat menerima email.
- Pada tahap pertama, fitur ini sebaiknya admin-only. Self-service publik membutuhkan identitas/akun pemilik domain agar tidak ada pihak lain yang mengklaim domain.

## Desain Direct Inbox URL

1. Nginx/Vite tetap mengarahkan path yang bukan file statis ke `index.html`.
2. `frontend/js/unified.js` membaca path saat halaman dimuat.
3. Jika path berisi alamat email valid, UI mengisi dan membuka inbox tersebut.
4. Jika domain belum aktif, UI menampilkan pesan koneksi domain, bukan inbox kosong yang menyesatkan.
5. Jika inbox protected, UI menampilkan modal password sebelum polling atau membuka detail.
6. Path tidak pernah menyimpan password, token, atau data rahasia.

## Desain Protected Inbox

### Penyimpanan

Gunakan tabel reservasi/credential terpisah dari `inboxes`, dengan identitas unik `local_part + domain_id`. Alasannya: inbox biasa dapat dihapus setelah 24 jam, sedangkan status reserve/password tidak boleh hilang secara tidak sengaja.

Kolom minimum:

- `id`;
- `local_part` dan `domain_id`;
- `password_hash` (bcrypt, tidak pernah plaintext);
- `is_active`;
- `credential_version` untuk mencabut sesi lama setelah reset password;
- `created_at`, `updated_at`, dan optional `expires_at`;
- metadata audit seperlunya, tanpa menyimpan password.

### Akses

1. Pemilik/admin membuat reservasi dan mengirim password melalui HTTPS request body.
2. Server menyimpan bcrypt hash saja.
3. Saat alamat dibuka, pengguna mengirim password ke endpoint unlock khusus.
4. Jika benar, server menerbitkan akses inbox berumur pendek, terikat pada satu alamat dan `credential_version` saat ini.
5. Semua endpoint pembaca/penghapus protected inbox memverifikasi akses tersebut di backend.
6. Password salah mendapat rate limit per alamat dan IP, serta respons generik tanpa membocorkan informasi inbox.

### Jalur yang harus diperiksa

- `/api/inbox/:address`;
- `/api/otp/:address`;
- `/api/email/:id`;
- `DELETE /api/inbox/:address`;
- seluruh endpoint pembaca/penghapus di `/api/ext/*`;
- command Telegram `/inbox`, `/otp`, dan `/del`;
- notifikasi Telegram/Discord dari email handler;
- recent email list dan tampilan admin yang mungkin memaparkan metadata protected inbox.

### Aturan API eksternal

- `POST /api/ext/inbox/create` tetap membuat inbox publik secara default.
- `GET /api/ext/inbox/{email}/otp/latest` tetap berfungsi untuk inbox publik dengan `X-API-Key`.
- Jika alamat protected diminta dari external API, API mengembalikan status terkunci tanpa data email/OTP.
- External API tidak menerima password maupun token unlock untuk membaca protected inbox dalam scope saat ini.

## Keamanan Pendukung

- Hilangkan fallback `JWT_SECRET` default di production dan wajibkan secret dari environment.
- Perketat CORS ke origin frontend yang sah.
- Tambahkan security headers/CSP dari Nginx atau Express.
- Jangan menyimpan password atau token akses inbox jangka panjang di URL/localStorage.
- Pisahkan atau sanitasi HTML email sebelum dirender; jangan memberi email HTML tidak tepercaya akses ke origin aplikasi yang memiliki credential.
- Catat event reserve, unlock gagal/berhasil, reset password, dan perubahan status domain tanpa mencatat rahasia.

## Tahap Implementasi

### Fase 0 — Kontrak dan test dasar

- Tambahkan test untuk endpoint inbox, OTP, detail email, delete, dan external API yang ada.
- Definisikan respons locked, validasi input, dan error handling.
- Pastikan perubahan tidak mengubah perilaku inbox publik.

### Fase 1 — Fondasi protected inbox

- Tambahkan migrasi idempoten untuk reservasi/credential.
- Buat service dan middleware akses inbox terpusat.
- Proteksi semua jalur backend, bot, dan notifikasi yang relevan.
- Tambahkan test negatif untuk bypass melalui email ID, API key, admin JWT, dan bot.

### Fase 2 — UI reserve dan unlock

- Tambahkan aksi reserve serta modal password dengan pola UI modern yang sudah ada.
- Tambahkan indikator inbox terkunci dan alur unlock yang jelas.
- Pertahankan generator, OTP Finder, polling, dan inbox publik yang ada.

### Fase 3 — Direct inbox URL

- Implementasikan resolver path email pada halaman utama.
- Tambahkan validasi, pesan domain tidak aktif, dan test URL encoded.
- Protected inbox dari URL harus mengikuti modal unlock Fase 2.

### Fase 4 — Onboarding domain aman

- Tambahkan skema status/verifikasi domain dan service DNS verification.
- Ubah aktivasi agar sukses hanya setelah Postfix sync sukses.
- Tambahkan wizard/panduan di UI dan perluas dokumentasi DNS/VPS.
- Mulai dari admin-only; evaluasi model akun sebelum membuka self-service umum.

### Fase 5 — Hardening dan rilis

- Terapkan CORS, header, secret, dan aturan rendering HTML email.
- Uji migrasi pada salinan database/staging.
- Deploy bertahap: migrasi, backend, frontend, lalu verifikasi Postfix dan DNS.
- Pantau error sync, unlock, dan delivery email setelah rilis.

## Kriteria Selesai

- Inbox publik tetap dapat dibuat, dipoll, menerima OTP, dan terhapus seperti sebelumnya.
- Inbox protected tidak dapat dibaca/dihapus dari UI, API, detail email, bot, notifikasi, atau admin tanpa password inbox.
- Domain baru tidak aktif sebelum verifikasi DNS dan sinkronisasi Postfix sukses.
- Direct URL membuka alamat yang valid tanpa mengekspos kredensial.
- Semua migrasi aman dijalankan ulang dan seluruh test lulus.
- Dokumentasi deployment dan domain mencerminkan perilaku baru.

## Status Implementasi (2026-07-10)

- [x] Migrasi idempoten untuk reservation/password dan status verifikasi domain.
- [x] Protected inbox dengan bcrypt hash, token akses singkat di memori, dan rate limit unlock.
- [x] Penutupan bypass pada public API, external API, detail email, Telegram, Discord/Telegram notification, dan recent-email admin.
- [x] UI reserve/unlock serta direct inbox URL pada halaman utama.
- [x] Wizard TXT/MX dan aksi verify domain pada dashboard admin.
- [x] CORS, security headers, secret environment, dan sandbox HTML email diperketat.
- [x] Admin reservation management: search/filter, reset/takeover, enable/disable, clear inbox, release, statistik, dan audit log.
- [x] Kuota reservation publik per IP hash serta expiry otomatis yang menghapus protected content sebelum release.
- [x] Admin dapat mengubah inbox lama menjadi protected tanpa mengganti alamat atau menghapus pesan; cleanup mengikuti masa reservasi.
- [ ] Jalankan migrasi pada PostgreSQL production dan set environment production sebelum deploy.
- [ ] Uji end-to-end pada VPS: TXT DNS, sync Postfix, delivery email, serta protected inbox.
