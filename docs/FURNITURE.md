# Sistem perabot

Perabot adalah data: katalog (`server/furniture/<kategori>.json`), aturan perilaku (`server/furniture/behaviors.json`), dan penempatan per kantor (meta `furniture` di DB kantor). Loader/validator: `server/furniture.js`. Waktu sholat: `server/prayer.js`.

Setiap file `*.json` di `server/furniture/` selain `behaviors.json` adalah katalog: array item, atau `{ "items": [...] }`. Item cacat dilewati dan dilaporkan (log daemon + `problems` di `GET /api/furniture`), tidak menjatuhkan daemon. File dibaca ulang otomatis saat berubah (dicek paling cepat tiap 1 detik; `version` berubah).

## Skema item

```jsonc
{ "id": "dapur-espresso", "name": "Mesin espresso", "cat": "dapur",
  "w": 2, "h": 1,                         // footprint dalam tile (1 tile = 8px), bilangan bulat 1..40
  "sprite": { "w": 16, "h": 18,           // w == w*8 (wajib); h bebas (>= footprint → menjulang ke atas)
              "palette": { "a": "#2A2430" },   // kunci 1 karakter (bukan '.'), warna #rgb/#rrggbb/#rrggbbaa
              "rows": ["....aaaa........"] },  // h baris, tiap baris w karakter; '.' transparan
  "frames": [ { "rows": [...] } ], "fps": 2,   // opsional; ukuran & palette sama dengan sprite
  "active": { "rows": [...] },                 // opsional, tampilan saat dipakai
  "solid": true, "wall": false,                // solid default true; wall = menempel dinding atas ruangan
  "affords": ["coffee"],
  "spots": [ { "dx": 0, "dy": 1, "pose": "stand", "face": "up" } ],
  "rooms": ["pantry", "lounge"], "weight": 1 }
```

- Sprite digambar menempel di **dasar** footprint: kiri-atas sprite = `(x*8, (y+h)*8 - sprite.h)`.
- `spots`: tile tempat agen berdiri/duduk relatif kiri-atas footprint (`dx` boleh -3..w+2, `dy` -3..h+2). `face` default `down`. `pose`: `stand|sit|sleep|pray|play|exercise|read`.
- `id` unik di seluruh katalog (yang kedua ditolak). `weight` (default 1) = frekuensi isi-otomatis; `rooms` = jenis ruangan yang boleh diisi.
- `affords` hanya dari daftar tetap: `type read whiteboard print phone test server meeting think coffee water eat snack sit sofa sleep chat play game music exercise pray wudhu plant train decor`.

## Jenis ruangan & lantai

`POST /api/offices/:id/rooms {name, kind}` menerima: `kode meeting lib qa server pantry beku game manager musik` + baru `musholla(20) lounge(28) gym(24) taman(30) telepon(10) tidur(18)` (lebar tile). Lantai: musholla→`musholla`, lounge→`lounge`, gym→`gymMat`, taman→`grass`, game→`wood`, telepon/tidur→`carpet`. (`FN_WIDTH`, `FLOOR` di `server/layout.js`.)

## API

| | |
|---|---|
| `GET /api/furniture` | `{items, behaviors, version, problems?}`. `version` = hash isi file; pakai untuk cache. |
| `GET /api/offices/:id/furniture` | `{items:[{uid,item,x,y}]}` |
| `PUT /api/offices/:id/furniture` | body `{items:[{uid?,item,x,y}]}` mengganti seluruh daftar. `x,y` = tile absolut kiri-atas footprint (bulat). 400 `{error}` bila item tak dikenal atau footprint keluar dari `plan.w/h` (tak ada yang tersimpan). `uid` kosong/dobel-tak-valid diisi `f<n>`. Mengirim event live `{t:'changed', office, what:'furniture'}`. |
| `GET /api/offices/:id` | `plan.furniture` ikut (sama dengan GET di atas). |
| `GET /api/prayer-times?date=YYYY-MM-DD` | `{date, location:{name,lat,lng,tz}, method:'kemenag', subuh,dzuhur,ashar,maghrib,isya,terbit}` ("HH:MM" waktu lokal lokasi). Tanpa `date` = hari ini. |

Lokasi dari `config.json` → `location: {name, lat, lng, tz}` (default Jakarta -6.2, 106.8, `Asia/Jakarta`). Metode Kemenag: Subuh 20°, Isya 18°, Ashar Syafi'i, ihtiyath +2 menit; dihitung lokal tanpa dependensi.

Penempatan tidak divalidasi terhadap ruangan/tumpang tindih (editor yang menjaga); server hanya menjamin item dikenal dan di dalam denah. Item yang kemudian hilang dari katalog tetap tersimpan; renderer melewatinya.

## behaviors.json

Dipakai kedua renderer (web & Flutter) agar perilaku sama. Server hanya menyimpan & memvalidasi; keputusan diambil klien.

```jsonc
{ "version": 1,
  "prayer": { "windowMin": 20, "names": ["subuh","dzuhur","ashar","maghrib","isya"],
              "steps": [ {"a":"wudhu","dwell":[25,50]}, {"a":"pray","dwell":[90,180]} ] },
  "chat":   { "distance": 6, "minIdleSec": 20, "dwell": [30,90] },
  "rules":    [ { "id", "when": {...}, "chance": 1, "pick": [{"a":"type","w":1}], "dwell":[15,50], "then":"prayer.steps" } ],
  "fallback": [ { "id", "pick": [...], "dwell": [...] } ] }
```

**Evaluasi** (tiap kali agen perlu tujuan baru, mis. dwell habis atau status/tool berubah): telusuri `rules` berurutan; aturan pertama yang `when`-nya cocok **dan** lolos undian `chance` (0..1, default 1) menang. Lalu pilih satu affordance dari `pick` secara acak berbobot `w`, cari perabot terdekat (utamakan ruangan agen, lalu seluruh kantor) yang `affords` memuatnya dan spot-nya kosong; bila tak ada, coba affordance lain dari `pick`; bila tetap tak ada, lanjut ke aturan berikutnya, terakhir `fallback`; terakhir kembali ke meja sendiri. Agen tinggal `dwell` = `[minDetik, maxDetik]` (acak seragam) lalu mengevaluasi ulang. Bila status berubah ke `working`, agen langsung kembali ke mejanya/perabot kerja.

**`when`** (semua kunci yang ada harus cocok; kunci lain tak dikenal membuat aturan dibuang):

| kunci | arti |
|---|---|
| `status` | `working` \| `idle` \| `waiting` (status sesi) |
| `tools` | daftar `session.tool.name` (cocok persis; nama mcp = nama server) |
| `bash` | regex (case-insensitive) pada `session.tool.label` (untuk Bash = perintahnya) |
| `label` | regex pada `tool.label` untuk tool apa pun |
| `subagent` | true bila sesi punya sub-agen `working` |
| `thinking` | true bila `working` tanpa `tool` aktif |
| `idleMin` | `[dari, sampai)` menit sejak status idle; `sampai` boleh `null` (tak terbatas) |
| `neighbor` | true bila ada agen idle lain dalam `chat.distance` tile |
| `prayer` | true bila sekarang dalam `windowMin` menit setelah azan salah satu `prayer.names` (waktu dari `/api/prayer-times`) dan agen belum sholat untuk waktu itu hari ini |

**`then`**: urutan lanjutan setelah langkah pertama; nilai `"prayer.steps"` berarti jalankan `prayer.steps` (wudhu lalu pray, masing-masing `dwell`-nya sendiri, lalu evaluasi ulang). Aturan `sholat` mengambil `wudhu` dulu; affordance `pray` memakai spot dengan pose `pray`.

Catatan: server tak tahu apakah `Write` membuat file baru, jadi aturan `kerja-cetak` memakai `chance` 0.15 sebagai pengganti. Validasi lunak: aturan rusak (affordance tak dikenal, regex rusak, dwell salah) dibuang dan dilaporkan di `problems` dengan `file: "behaviors.json"`; bila file hilang, `rules` kosong.
