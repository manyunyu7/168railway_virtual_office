# Ravel Remote: signaling remote desktop

Kantor jadi **signaling + otorisasi + daftar host** untuk Ravel Remote (remote desktop ke Mac pemilik lewat app Ravel).
Media (video, DataChannel input) mengalir langsung host ↔ app lewat WebRTC di Tailscale; kantor tidak menyentuhnya.
Kontrak lengkap: `ravel-remote/docs/PROTOCOL.md` (bagian 1 signaling, bagian 4 keamanan). Kode: `server/remote.js` (relay), `server/remote-api.js` (auth dan rute),
`server/remote-devices.js` (perangkat dan pairing). Tes: `test/remote.test.js`, `test/loopback.test.js`.

## Kredensial

| Peran | Token | Berlaku untuk |
|---|---|---|
| host (ravel-host) | token mesin (`kcmesin_…`), atau token config **hanya lewat listener HTTP lokal** (`127.0.0.1:<port>` dari `server.json`) | WS `/api/remote/host` |
| viewer (app Ravel) | **token perangkat** `kcview_…` dari pairing | WS `/api/remote/ws`, `GET /api/remote/hosts`, `GET /api/remote/pair`, approve tanpa kode, `/api/remote/devices` |
| owner | token owner (config) / token admin mode akun | `POST /api/remote/pair`, ambil hasil pairing, approve dengan kode, `/api/remote/devices` |

- Semua lewat `Authorization: Bearer …`. **Cookie tidak pernah diterima** di `/api/remote/*`.
- Token owner dan token mesin **ditolak (403)** di `/api/remote/ws` dan `/api/remote/hosts`: token owner juga dipakai hook, MCP, dan agen.
- "Lokal" = koneksi dari 127.0.0.1 tanpa header forwarded, **tidak terenkripsi, di `cfg.port`**. Koneksi ke listener TLS
  dari 127.0.0.1 (TCP passthrough atau tunnel ke listener TLS) tidak dihitung lokal. Aturan ini juga berlaku untuk token config di mode akun.
- Origin: app native tidak mengirim Origin. Kalau ada, harus asal kantor ini sendiri dan bukan nama di `tls.proxy`
  (aplikasi lain di sertifikat yang sama); `Origin: null` ditolak. Berlaku untuk semua `/api/remote/*`.

## Pairing perangkat viewer

1. App (token owner): `POST /api/remote/pair` `{device: "Fold 8"}` →
   `{id, claim, device, expiresAt, hostsNotified}`. Berlaku 5 menit. Simpan `claim` (rahasia peminta).
2. Setiap host online menerima `{"type":"pair","id","device","code":"123456","expiresAt"}` dan menampilkan kode di
   status bar/notifikasi Mac.
3. Persetujuan, salah satu:
   - **Kode dari Mac**: app (token owner) `POST /api/remote/pair/:id/approve` `{code, claim}` →
     `{id, status:"approved", token, device}`. Kode salah 5 kali → permintaan dibuang.
   - **Dari perangkat yang sudah ter-pair**: perangkat itu (token `kcview_`) melihat `GET /api/remote/pair`
     (`[{id, device, ip, createdAt, expiresAt}]`, tanpa kode/claim) lalu `POST /api/remote/pair/:id/approve` tanpa body.
     Peminta mengambil token dengan token owner: `GET /api/remote/pair/:id` + header `X-Pair-Claim: <claim>` (atau `?claim=`)
     → `{status:"pending"}` | `{status:"approved", token, device}` (token **sekali saja**) | `{status:"expired"}`.
4. Setelah selesai, host menerima `{"type":"pair-done","id","status":"approved"|"gagal"}` untuk menutup notifikasinya.

Token perangkat disimpan **hanya sebagai hash SHA-256** di `~/.kantor-claude/remote-devices.json` (mode 600). App menyimpannya di
Android Keystore dan meminta biometrik sebelum membuka sesi.

`GET /api/remote/devices` → `[{id, device, createdAt, lastUsed, lastIp, via, current}]`.
`DELETE /api/remote/devices/:id` → cabut; sesi perangkat itu langsung diakhiri (`bye` `perangkat-dicabut`).

## Signaling

| | Isi |
|---|---|
| WS `GET /api/remote/host` | ravel-host. Pesan pertama wajib `register`. |
| WS `GET /api/remote/ws?machine=<id>&w=&h=&dpr=` | viewer. |
| `GET /api/remote/hosts` | `[{machine, name, online, displays, version, fingerprint, busy, sessions, maxSessions?}]` |

### Host
- `{"type":"register","machine":"<id>","name","version","displays":[...],"fingerprint":"sha-256 AB:CD:…","instance":"<acak per proses>"}`
  → `{"type":"registered","machine","maxSessions":2}`. `machine` boleh kosong; kalau diisi harus mesin pemilik token
  (selain itu `error` + close **4403**). Lewat token config lokal, `machine:"local"` diterima sebagai alias Mac hub.
- `register` berikutnya di koneksi yang sama hanya memperbarui nama/versi/display.
- **Penggantian host** (koneksi baru untuk mesin yang host-nya masih tersambung):
  - host lama punya sesi aktif → koneksi baru ditolak **4409**;
  - tanpa sesi, `fingerprint` atau `instance` sama dengan host lama → diganti langsung (yang lama ditutup 4000);
  - tanpa sesi, identitas berbeda → host lama di-ping; ada pong dalam 5 dtk → koneksi baru ditolak **4409**, tidak ada → diganti.
- Token mesin dirotasi atau mesin dinonaktifkan → host ditutup **4401** (dicek tiap 5 dtk).
- Host boleh kirim `offer`, `ice`, `bye`, `error {session, message}` (menolak sesi).

### Viewer
- Buka `/api/remote/ws?machine=<id>` → kantor membuat session `s_<acak>`, kirim ke host
  `{"type":"join","session","viewer":{"device","w","h","dpr"}}` (`device` = nama dari pairing, bukan query) dan ke viewer
  `{"type":"ready","session","machine","name","displays","fingerprint"}`.
- **Pinning**: app mencocokkan `fingerprint` di `ready` dengan `a=fingerprint` di SDP offer, dan dengan fingerprint yang
  disimpan untuk mesin itu sejak pairing pertama (TOFU). Beda → tutup sesi dan peringatkan.
- Host offline / penuh → `{"type":"error","message"}` lalu WS ditutup.
- Viewer boleh kirim `answer`, `ice`, `bye`. `session` boleh kosong (kantor mengisinya); kalau diisi harus sesi koneksi ini.

### Relay
- Pesan dibangun ulang dengan field yang dikenal saja: `offer/answer` `{type, session, sdp}`,
  `ice` `{type, session, candidate, sdpMid, sdpMLineIndex}`.
- `bye` dari salah satu pihak diteruskan ke pihak lain dan WS viewer ditutup. WS putus → pihak lain dapat `bye` dengan
  `reason` `viewer-putus` / `host-putus` / `host-diganti` / `token-dicabut` / `perangkat-dicabut`.

### Batas
- Maks **2 sesi per host** (`config.json` → `remote.maxSessions`).
- Pesan maks **64 KB** (lebih besar → close 1009). Binary ditolak. Ping WS tiap **20 dtk**.
- Laju per IP (`remote.rate`, `[jumlah, ms]`): join viewer 10/menit, pair 5/10 menit, approve 10/menit, auth gagal
  20/10 menit (setelahnya semua `/api/remote/*` dari IP itu 429).
- Koneksi dicek ulang tiap `remote.revalidateMs` (bawaan 5000). Token owner hanya berubah lewat restart daemon, yang menutup semua WS.

### Event dan audit
- Event `{"t":"remote-hosts","hosts":[...]}` di WS `/ws` setiap host online/offline/sesi berubah.
- Audit `kind: 'remote'`: buka/tutup sesi (aktor = `Perangkat <nama>`), permintaan dan persetujuan pairing, pencabutan perangkat,
  host diganti, register ditolak, fingerprint berubah.

## Token untuk ravel-host

- **Mac lain (MacBook)**: tombol **Pasang** di tab Mesin menulis `~/.kantor-node/hub.json` = `{url, token, machine}` (mode 600).
  ravel-host membuka `wss://<host dari url>/api/remote/host` dengan `Authorization: Bearer <token>`.
- **Mac hub (Mac mini)**: sama seperti MacBook lewat `hub.json` (Mac ini terdaftar sebagai mesin `ssh: 'local:'`), atau token
  config dari `~/.kantor-claude/server.json` ke `ws://127.0.0.1:<port>/api/remote/host` (bukan lewat listener TLS).
  Keduanya memetakan ke id mesin `local:` itu.
- Catatan: token mesin juga ada di env agen di Mac itu. Aturan penggantian host (4409) dan pinning fingerprint di app yang
  mencegah token itu dipakai untuk menyamar sebagai host.

## Relay publik (tanpa Tailscale)

Relay mandiri (repo ravel-remote, folder `relay/`) memakai endpoint `/api/remote/*` yang sama. Untuk meminta pairing di
relay, app butuh token owner relay (`kcowner_`). Kantor menyajikannya supaya tidak perlu diketik:

`GET /api/remote/relay-owner` (Bearer token owner kantor; token perangkat/mesin 403, cookie 401) → `{url, token}` dari
`~/.kantor-claude/remote-relay.json` (dibuat manual, **wajib mode 600**, isi `{"url":"https://…","token":"kcowner_…"}`).
Berkas tidak ada → 404; mode longgar, url bukan https/wss, atau token tidak berawalan `kcowner_` → 409. Setiap pengambilan
dicatat di audit. Token owner relay hanya bisa *meminta* pairing; persetujuan tetap butuh kode dari Mac atau perangkat ter-pair.

## Pekerjaan lanjutan

- **Token host terpisah** (awalan mis. `kchost_`) per Mac, dibuat saat memasang ravel-host dan disimpan di Keychain Mac itu
  (bukan `hub.json`, bukan env agen), hanya berlaku untuk `/api/remote/host` dan bisa dicabut per mesin. Setelah ada,
  token mesin dan token config tidak lagi diterima di `/api/remote/host`.
