# Lampiran dua arah di percakapan agen

Kontrak API untuk klien web dan app Ghina. Semua endpoint di bawah `/api/` memakai auth yang sama dengan API lain (`Authorization: Bearer <token>` atau cookie `kc_token`). Kode: `server/attachments.js`.

Sebuah "percakapan" = satu sesi (`sid`). Lampiran selalu terikat ke `sid`.

## Bentuk item lampiran

```json
{
  "id": "a1b2c3d4e5", "sid": "…", "office": "shop",
  "dir": "in",                      // "in" = dari pemilik, "out" = dari agen
  "name": "video.mp4",              // nama asli
  "path": ".kantor/inbox/20261021-1930-video.mp4",   // relatif terhadap folder kerja sesi
  "mime": "video/mp4", "size": 12345678,
  "kind": "video",                  // image | video | audio | file
  "caption": "lihat bagian tengah",
  "at": "2026-10-21T12:30:00.000Z",
  "duration": 62.4, "width": 1280, "height": 720,       // null bila tidak diketahui
  "frames": { "dir": "/abs/…-frames", "count": 60 },     // hanya video masuk; null kalau belum/tidak ada
  "processing": false,              // true selagi ffprobe/ffmpeg bekerja (video/audio masuk)
  "delivered": true,                // hanya dir "in": teks sudah diketik ke sesi agen. false = tersimpan saja
  "url": "/api/attachments/a1b2c3d4e5/raw",
  "thumb": "/api/attachments/a1b2c3d4e5/thumb"            // null untuk non gambar/video
}
```

## A. Pemilik ke agen: upload bertahap (bisa dilanjutkan)

1. `POST /api/sessions/:sid/uploads` body JSON `{ "name": "video.mp4", "size": 123456789, "mime"?: "video/mp4", "caption"?: "…" }`
   -> `201 { id, offset: 0, size, chunk }`. `chunk` = ukuran potongan yang disarankan (4 MB). `404` bila sesi atau folder kerjanya tidak ada, `413` bila `size` melebihi batas (bawaan 4 GB, `config.attachments.maxBytes`).
2. `PUT /api/uploads/:id` header `Upload-Offset: <n>`, body biner potongan (tanpa JSON; `Content-Type` bebas).
   -> `200 { offset, done: false }`, dan setelah potongan terakhir `200 { offset, done: true, attachment: <item> }`.
   - `Upload-Offset` harus sama dengan jumlah byte yang sudah tersimpan di server; kalau tidak: `409 { error, offset: <offset benar> }`. Lanjutkan dari `offset` itu.
   - Satu PUT maksimal 64 MB dan tidak boleh melewati sisa ukuran file (`413`). File kecil (<= 20 MB) boleh dikirim dalam satu PUT dengan `Upload-Offset: 0` (header boleh dihilangkan pada potongan pertama).
   - Koneksi putus di tengah potongan tidak apa-apa: byte yang sudah masuk disimpan. Panggil `HEAD` lalu lanjutkan dari offset itu.
   - Satu potongan per upload pada satu waktu (potongan kedua yang menyusul -> `409`).
3. `HEAD /api/uploads/:id` (header respons `Upload-Offset`, `Upload-Length`) atau `GET /api/uploads/:id` -> `{ id, offset, size, done, chunk, attachment? }`. Untuk upload yang sudah selesai `done: true` dan `attachment` terisi (idempoten: aman dipanggil ulang setelah klien lupa hasil PUT terakhir).

Upload yang menggantung > 48 jam (`config.attachments.staleHours`) dibersihkan; `404` sesudahnya, mulai ulang dari langkah 1.

Setelah selesai server: memindahkan file ke `<folder kerja sesi>/.kantor/inbox/<YYYYMMDD-HHMM>-<nama-aman>` (folder kantor bila folder kerja sudah hilang), menambah `.kantor/` ke `.git/info/exclude` bila folder itu repo git (`.gitignore` tidak disentuh), lalu untuk video mengambil frame 1 per detik (maks 60, lebar <= 1280, jpg) ke `<nama>-frames/` (video > 60 detik disampel merata jadi 60 gambar). Terakhir mengetik pesan ke sesi agen ("Kamu menerima file dari pemilik: …", plus caption). Respons PUT terakhir datang SEBELUM frame selesai: `attachment.processing = true`; item yang diperbarui (frames, durasi, `delivered`) datang lewat event live. Sesi yang tidak bisa diketik (bukan tmux dan terminal tak dikenal) -> `delivered: false`, file tetap tersimpan dan tampil di chat.

## B. Agen ke pemilik

Tool MCP `kantor`:
- `kirim_ke_pemilik { path, caption? }`: berkas dari folder kerja (atau folder kantor, atau /tmp) disalin ke `.kantor/outbox/` lalu dikirim.
- `tangkap_layar { target?: 'layar'|'url', url?, caption? }`: `screencapture -x` atau Chrome headless untuk halaman lokal (localhost / jaringan rumah), hasilnya otomatis dikirim. Hanya dipanggil bila pemilik memintanya.

Keduanya mencatat item `dir: "out"`, menyiarkan event live, dan mengirim notifikasi Ghina.

Notifikasi Ghina: `POST /api/kantor/notify` dengan `event: "file"`, `title: "<Nama> mengirim file"`, `body: "<nama berkas> — <caption>"`, `office`, `sid` (server Ghina menerima teks bebas untuk `event`). Aktif kecuali `ghinaNotify.file === false`; tidak bergantung pada daftar `events`. Bila `ghinaNotify` belum diatur, tidak ada yang terkirim.

## C. Daftar dan berkas

- `GET /api/sessions/:sid/attachments?limit=200&after=<iso>` -> `{ items: [<item>…] }` urut lama ke baru, dua arah sekaligus. `after` = hanya yang lebih baru dari waktu itu.
- `GET /api/attachments/:id/raw` -> berkas dengan `Content-Type` yang benar, `Accept-Ranges: bytes`, mendukung `Range` (`206`, juga `bytes=-N`, `416` bila di luar batas) dan `HEAD`. Gambar/video/audio/PDF `inline`; lainnya `attachment`. `?dl=1` memaksa unduhan. Berkas HTML/SVG dilayani dengan CSP sandbox.
- `GET /api/attachments/:id/thumb` -> JPEG <= 480 px lebar (gambar, atau frame video), di-cache. `404` untuk jenis lain.

## Event live (WebSocket `/ws`)

```json
{ "t": "attachment", "office": "shop", "sid": "…", "item": <item> }
```

Dikirim saat item dibuat dan setiap kali berubah (video selesai diproses, `delivered` terisi). Klien melakukan upsert berdasarkan `item.id`.

## Kode galat

`400` input salah, `404` tidak ada / kedaluwarsa, `409` offset salah (ada `offset`), `413` terlalu besar, `416` Range di luar batas. Bentuk: `{ "error": "…", "offset"?: n }`.

## Antrean pesan

Pesan yang pemilik kirim ke sesi (aksi `text` dari web, Ghina, tombol cepat, komentar kartu, catatan, dan pesan "Kamu menerima file…" di atas) ditahan Claude Code bila Claude sedang sibuk, dan transcript baru memuatnya setelah dibaca. Supaya tetap kelihatan di chat, server mencatat tiap pesan keluar per sesi (tabel `outbox`, 200 terakhir per sesi) dan menandainya:

- `pending`: sudah diketik ke sesi, belum dibaca Claude. Tampilkan di chat sebagai bubel "menunggu" (mis. abu-abu dengan jam kecil).
- `read`: sudah dibaca. Saat itu transcript memuatnya sebagai pesan user, jadi klien menyembunyikan bubel antrean dan memakai item transcript (cocokkan lewat `readAt` / teks).
- `cancelled`: dibatalkan pemilik; tidak muncul lagi di daftar.

Item:

```json
{ "id": "q1a2b3c4d5", "sid": "…", "text": "tolong cek test-nya", "at": "2026-10-21T12:30:00.000Z", "status": "pending", "readAt": null }
```

Kapan jadi `read`: (1) hook `UserPromptSubmit` untuk sesi itu datang dengan teks sama (spasi dinormalkan; pending tertua yang cocok; awalan >20 karakter juga dianggap sama); (2) hook datang tapi tidak ada yang cocok: pending tertua yang sudah menunggu >= 10 detik ditandai (Claude Code kadang mengubah teksnya); (3) teks yang sama muncul sebagai pesan user di transcript (diperiksa saat `GET` dan tiap 15 detik).

Endpoint:
- `GET /api/sessions/:sid/outbox` -> `{ items: [<item>…] }`, `pending` dan `read`, 50 terakhir, lama ke baru.
- `DELETE /api/sessions/:sid/outbox/:id` -> `{ ok, item, stillQueued: true, note }`. Hanya untuk `pending` (`400` bila sudah `read` atau `cancelled`, `404` bila tidak ada). Batal hanya MENYEMBUNYIKAN di kantor: pesan yang sudah ada di antrean Claude Code tidak bisa dicabut dari luar tanpa menekan tombol di terminalnya (Esc ikut menghentikan giliran yang sedang jalan), jadi tidak ada tombol yang dikirim ke terminal. Klien sebaiknya memberi tahu "Claude mungkin masih membacanya" (`note`).
- Event live `{ "t": "outbox", "office", "sid", "item": <item> }` saat pesan dicatat, dibaca, atau dibatalkan. Upsert berdasarkan `item.id`.
