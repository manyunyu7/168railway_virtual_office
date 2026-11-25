# Ravel Remote: signaling remote desktop

Kantor jadi **signaling + otorisasi + daftar host** untuk Ravel Remote (remote desktop ke Mac pemilik lewat app Ravel).
Media (video, DataChannel input) mengalir langsung host ↔ app lewat WebRTC di Tailscale; kantor tidak menyentuhnya.
Kontrak lengkap: `ravel-remote/docs/PROTOCOL.md` (bagian 1 signaling, bagian 4 keamanan). Kode: `server/remote.js`,
wiring auth di `server/index.js` (`onUpgrade`), tes: `test/remote.test.js`.

## Endpoint

| | Auth | Isi |
|---|---|---|
| WS `GET /api/remote/host` | `Authorization: Bearer <token mesin>`, atau token config **dari loopback** (Mac hub sendiri). Cookie tidak diterima. | ravel-host. Pesan pertama wajib `register`. |
| WS `GET /api/remote/ws?machine=<id>&device=&w=&h=&dpr=` | pemilik: Bearer token config / cookie `kc_token`; mode akun: admin (cookie `kc_sesi` atau token aplikasi). Token mesin 403. | viewer (Ravel). |
| `GET /api/remote/hosts` | sama dengan viewer | `[{machine, name, online, displays, version, busy, sessions, maxSessions?}]` |

`device`, `w`, `h`, `dpr` di query diteruskan ke host di pesan `join` sebagai `viewer` (dipotong: device ≤ 80 karakter, angka saja).

### Alur
1. Host: `{"type":"register","machine":"<id>","name":"Mac mini","version":"1.0.0","displays":[...]}` → `{"type":"registered","machine":"<id>","maxSessions":2}`.
   `machine` boleh dikosongkan (kantor memakai id dari token). Kalau diisi harus sama dengan mesin pemilik token (kalau tidak: `error` + close 4403).
   `register` berikutnya di koneksi yang sama hanya memperbarui nama/versi/display. Koneksi baru untuk mesin yang sama
   **menggantikan** yang lama (yang lama ditutup 4000, viewer-nya dapat `bye` `host-diganti`).
2. Viewer membuka `/api/remote/ws?machine=<id>` → kantor membuat session `s_<acak>`, kirim `join` ke host dan `ready` ke viewer
   (`{"type":"ready","session","machine","name","displays"}`). Host offline / penuh → `{"type":"error","message"}` lalu WS ditutup.
3. Relay: host boleh kirim `offer`, `ice`, `bye`, `error`; viewer boleh `answer`, `ice`, `bye`. `session` wajib cocok dengan sesi
   pengirim (viewer boleh tidak mengisinya; kantor menambahkannya). Selain itu → `error`, tidak diteruskan.
4. `bye` dari salah satu pihak diteruskan ke pihak lain dan WS viewer ditutup. Host `error {session, message}` = menolak sesi
   (viewer dapat `error` lalu `bye`). WS putus → pihak lain dapat `bye` dengan `reason` `viewer-putus` / `host-putus`.

### Batas
- Maks **2 sesi per host** (`config.json` → `remote.maxSessions`).
- Pesan maks **256 KB** (lebih besar → WS ditutup 1009). Binary ditolak.
- Ping WS tiap **20 dtk**; yang tidak membalas pong sampai ping berikutnya diputus (→ `bye`).

### Event dan audit
- Setiap host online/offline/sesi berubah: event `{"t":"remote-hosts","hosts":[...]}` di WS events `/ws` (isi sama dengan `/api/remote/hosts`).
- Audit `kind: 'remote'`: "membuka remote desktop <host> dari <device>" dan "menutup remote desktop <host> (<n> menit, <alasan>)",
  meta `{machine, session, device}`.

### Daftar host
Mesin dari `config.json` → `machines` (yang tidak disabled) selalu tampil, offline sampai ravel-host-nya register.
Mac hub sendiri: kalau ada mesin dengan `ssh: 'local:'`, itulah id Mac ini (token config dari loopback dipetakan ke id itu,
dan `register` boleh menyebut `machine: "local"`). Kalau tidak ada, Mac hub muncul sebagai `local` (nama: `remote.localName` atau hostname).

## Token untuk ravel-host

- **Mac lain (MacBook)**: tombol **Pasang** di tab Mesin menulis `~/.kantor-node/hub.json` = `{url, token, machine}` (mode 600).
  ravel-host membaca file itu dan membuka `wss://<host dari url>/api/remote/host` dengan `Authorization: Bearer <token>`.
- **Mac hub (Mac mini)**: dua cara, hasilnya id mesin yang sama.
  1. Sama seperti MacBook: `~/.kantor-node/hub.json` (ada kalau Mac ini terdaftar sebagai mesin `local:`).
  2. Token config dari loopback: baca `~/.kantor-claude/server.json` (`port`, `token`) lalu `ws://127.0.0.1:<port>/api/remote/host`.
     Harus loopback dan lewat header `Authorization` (bukan cookie, bukan lewat reverse proxy).
- Ganti token (PATCH `/api/machines/:id {rotateToken:true}`) → Pasang lagi; host yang tersambung dengan token lama tetap jalan sampai putus.
