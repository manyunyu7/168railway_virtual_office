# Akun anggota dan audit

Mode untuk **kantor bersama di server**: beberapa orang membuka kantor yang sama lewat browser, masing-masing dengan akun sendiri, dan setiap aksi tercatat atas nama orangnya. Di Mac pribadi mode ini tidak perlu; kantor tetap memakai satu token seperti biasa (audit tetap dicatat atas nama "Kamu").

Kode: `server/akun.js` (anggota, password, 2FA, sesi), `server/akun-pages.js` (halaman `/masuk` dan `/undangan`), `server/audit.js` (catatan audit), `server/actor.js` (siapa pelaku request yang sedang berjalan), halaman `web/js/akun.js` (`#/akun`). Tes: `test/akun.test.js`.

## Mengaktifkan

Di `~/.kantor-claude/config.json`:

```json
{
  "akun": { "enabled": true, "names": ["cz.tentrem.space"], "trustProxy": true, "sessionDays": 14 }
}
```

- `names`: nama host publik yang dikirim reverse proxy (header `Host`). Tanpa ini, request lewat domain ditolak.
- `trustProxy`: baca IP asli dari `X-Real-IP` / `X-Forwarded-For` dan HTTPS dari `X-Forwarded-Proto`. Nyalakan **hanya** kalau daemon berada di belakang proxy yang menimpa header itu (nginx di bawah).
- `sessionDays`: lama login bertahan di satu perangkat.

Mulai ulang daemon, lalu buat admin pertama dari server:

```bash
node bin/kantor.js akun buat henry "Henry" admin
# Link undangan untuk Henry (henry), berlaku sampai …:
# https://cz.tentrem.space/undangan?k=…
```

Buka link itu, buat password, scan QR dengan aplikasi authenticator, masukkan kodenya. Anggota berikutnya bisa dibuat dari halaman **Akun & riwayat → Anggota** atau dari CLI.

| Perintah | Fungsi |
|---|---|
| `kantor akun buat <username> "<Nama>" [admin\|anggota]` | Buat anggota, cetak link undangan |
| `kantor akun daftar` | Semua anggota dan statusnya |
| `kantor akun reset <username>` | Hapus password + 2FA, keluarkan dari semua perangkat, undangan baru (HP hilang, lupa password) |
| `kantor akun nonaktif <username>` / `aktif <username>` | Kunci / buka akun; nonaktif langsung mengeluarkan semua sesinya |
| `kantor akun periksa-audit` | Periksa rantai hash audit (exit 2 kalau rusak) |

## Login

- **Username + password + kode 2FA (TOTP)**, wajib untuk semua. Kode 6 digit dari Google Authenticator, Authy, 1Password, dan sejenisnya; toleransi ±30 detik untuk jam HP yang meleset.
- Password di-hash dengan **scrypt** (N=2¹⁵, r=8). Minimal 10 karakter, tidak boleh memuat username.
- Satu kode hanya bisa dipakai sekali (kode yang sama atau lebih lama ditolak).
- **Pembatasan percobaan**: 5 kali salah per username mengunci username itu 15 menit; 20 kali salah per IP dalam 15 menit memblokir IP itu. Pesan salahnya selalu sama, jadi tidak membocorkan bagian mana yang salah.
- Undangan: token acak 256 bit, disimpan sebagai hash, berlaku 72 jam, sekali pakai.
- Cookie `kc_sesi`: `HttpOnly; SameSite=Strict`, plus `Secure` lewat HTTPS. Di database hanya hash-nya yang disimpan.
- Setiap POST dan WebSocket harus punya `Origin` kantor ini, supaya situs lain tidak bisa memakai cookie anggota.
- Token di `config.json` tetap jalan untuk hooks dan MCP, tetapi **hanya dari loopback** dan tanpa header proxy. Dari luar, satu-satunya pintu adalah `/masuk`.

## Peran

| | Anggota | Admin |
|---|---|---|
| Denah, board, wiki, notes, rapat, pratinjau | ✅ | ✅ |
| Terminal sesi, menyuruh agen, menyetujui izin, mengganti mode | ✅ (tercatat) | ✅ |
| Riwayat | hanya miliknya | semua orang + periksa keutuhan |
| Anggota, pengaturan, hooks, aturan kantor, autopilot, anggaran, tambah kantor/ruangan, jelajah folder | ❌ | ✅ |
| `/api/hook`, `/api/agent/*` | ❌ (hanya token dari loopback) | ❌ |

Daftar persisnya ada di `ADMIN_ONLY` dan `SYSTEM_ONLY` di `server/index.js`.

## Yang tercatat di audit

Disimpan di `~/.kantor-claude/audit.db`, terpisah dari data kantor, dan **selamanya** (tidak ada pemangkasan).

| Jenis | Isi |
|---|---|
| `api` | Setiap request yang mengubah sesuatu (POST/PUT/PATCH/DELETE): siapa, kapan, IP, kalimat yang bisa dibaca ("mengizinkan Bash (rm -rf build) untuk Bayu", "membuat kartu …"), status, dan isi request (password/kode/token disamarkan). Beberapa yang sering dan kosmetik dilewati (posisi karakter pemilik, pratinjau tata letak, potongan upload); lihat `AUDIT_SKIP`. |
| `prompt` | Setiap prompt yang diterima Claude, **atas nama orang yang terakhir mengetik di pane itu**: lewat terminal browser, kotak "Suruh", atau tugas awal shift. Prompt tanpa pengetik dari kantor dicatat sebagai "Pesan agen" (dikirim agen lain) atau **"Tidak diketahui"** (mis. seseorang `tmux attach` lewat SSH). |
| `terminal` | Membuka dan menutup terminal (sesi, shell, dock) beserta durasinya. Isi ketikan per tombol tidak disimpan; yang dicatat adalah prompt yang sampai ke Claude. |
| `agen` | Tool kantor yang dipanggil agen dan mengubah sesuatu (bukan yang hanya membaca), dengan kolom **asal**: manusia yang memulai rantai perintahnya. Contoh: Budi menyuruh Manager → Manager `pesan_ke` Backend → prompt Backend dan aksinya tercatat "atas perintah Budi". |
| `masuk`, `masuk-gagal`, `keluar`, `akun` | Login berhasil/gagal (dengan username yang dicoba dan IP), logout, aktivasi undangan. |

Anggota hanya bisa membaca catatannya sendiri (`/api/audit` memaksa filter ke dirinya), admin melihat semua. Ekspor: `/api/audit.csv` dengan filter yang sama.

### Seberapa bisa dipercaya

- Trigger SQLite menolak `UPDATE` dan `DELETE` pada tabel audit.
- **Rantai hash**: tiap baris menyimpan SHA-256 dari baris sebelumnya plus isinya sendiri. Baris yang diedit atau dihapus di tengah langsung ketahuan lewat `kantor akun periksa-audit` atau tombol "Periksa keutuhan".
- Batasnya: siapa pun yang bisa menulis `audit.db` bisa membuang trigger, dan juga bisa memotong baris-baris **terakhir** tanpa memutus rantai. Karena terminal di kantor = shell, di server bersama daemon dan agen harus berjalan sebagai **user Linux yang berbeda**: daemon (pemilik `audit.db`, `akun.db`, `config.json`) sebagai `kantor`, tmux/Claude/terminal sebagai `agen` tanpa akses baca ke `~kantor`. Tanpa pemisahan itu, audit hanya mencatat pemakai yang jujur.
- Untuk salinan yang tidak bisa dihapus sama sekali, kirim `audit.db` (atau ekspor CSV harian) ke luar server.

## Di belakang nginx

```nginx
server {
  listen 443 ssl; server_name cz.tentrem.space;
  # ssl_certificate … (certbot)
  client_max_body_size 50m;
  location / {
    proxy_pass http://127.0.0.1:4317;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
  }
}
```

`X-Forwarded-For` sengaja **ditimpa** (bukan `$proxy_add_x_forwarded_for`), supaya klien tidak bisa menyelipkan IP palsu. Port daemon jangan dibuka di firewall.

Catatan: link undangan ada di query string, jadi bisa ikut tercatat di access log nginx. Link itu hanya bisa dipakai sekali dan kedaluwarsa dalam 72 jam. Kalau perlu, matikan `access_log` untuk `location = /undangan`.
