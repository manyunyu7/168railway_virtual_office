# Template kantor (suasana kantor)

Template mengganti susunan denah, pintu, lantai, dan seluruh perabot sebuah kantor dengan tema yang siap pakai, untuk kantor baru (wizard) maupun kantor yang sudah ada (Atur denah → Terapkan template). Ruangan kode dan penghuninya tidak pernah dihapus.

- Data: `server/templates/<id>.json` (dibaca ulang otomatis saat berubah).
- Generator, apply, restore, thumbnail: `server/templates.js`.
- Aturan isi perabot dipakai bersama browser dan server: `web/js/furnish-core.js` (`fillRoom`, `doorLands`, dan `builtIns` = port geometri dari `office-canvas.js` untuk meja dan perabot bawaan; harus ikut diubah bila `furnish()`/`placeDesks()` di `office-canvas.js` berubah).
- Galeri (editor + wizard): `web/js/template-gallery.js`, gaya di `web/css/layout.css`.

## Template bawaan

| id | nama | susunan | ruangan yang ditambahkan |
|---|---|---|---|
| `zen-garden` | Taman Zen | hub: taman di tengah, sisi tenang di kiri, sisi santai di kanan | taman, musholla, ruang tidur siang, bilik sunyi |
| `kafe-senja` | Kafe Senja | hub: pantry + lounge berdampingan di tengah, kayu hangat | lounge, musholla |
| `perpustakaan-tenang` | Perpustakaan Tenang | baris rapi; sayap sunyi dulu, yang ramai di ujung | perpustakaan besar, ruang baca, 2 bilik telepon, musholla |
| `startup-loft` | Startup Loft | baris, koridor 10, pintu lebar ganda | ruang main, gym, ruang santai, musholla |
| `stasiun` | Stasiun | baris, lobi lebar (hall), koridor diberi nama Peron | ruang tunggu, musholla |
| `minimalis` | Minimalis | baris ringkas, perabot sedikit | tidak ada |

## Skema

```jsonc
{ "id": "zen-garden", "order": 1, "name": "Taman Zen", "mood": "tenang · hijau", "accent": "#6BAE57", "desc": "…",
  "facilities": [ { "kind": "taman", "name": "Taman Zen", "size": 1 } ],   // dipakai ulang bila kantor sudah punya ruangan jenis itu
  "filler": { "kind": "taman", "name": "Taman Kecil" },                       // mengisi ujung baris yang kosong (≥ 10 tile)
  "layout": { "strategy": "hub" | "rows", "hub": ["taman"], "hubSize": 1.25, "corridor": 8, "rowH": 21, "lobbyW": 22,
              "doorW": 3, "twoDoorsFrom": 32, "codeSize": 1, "facilitySize": 1, "wingLabels": "groups" | "peron" },
  "groups": [ { "name": "Sisi Tenang", "kinds": ["musholla", "lib"] }, … ],   // urutan = urutan penempatan; nama = label koridor
  "floors": { "kode": ["teal", "teal2"], "*": "wood2" },                        // array = bergantian per ruangan jenis itu
  "furnish": { "*": { "density": 0.9 },
               "taman": { "center": ["taman-air-mancur"], "items": { "taman-bangku": 3 }, "others": 0, "density": 1.5, "walls": 1, "exclude": [] } },
  "corridorDecor": { "every": 12, "items": ["plant", "bench", "water", "vending"] } }
```

- `furnish[kind].items`: id katalog → bobot (boleh item yang `rooms`-nya tidak memuat jenis itu). `others`: pengali bobot untuk item katalog lain yang cocok dengan jenis ruangan (default 1 tanpa `items`, 0.15 dengan `items`). `center`: diletakkan dulu sedekat mungkin ke tengah lantai. `density`/`walls`: pengali kepadatan lantai dan dinding atas.
- Lantai yang dikenal: `wood teal teal2 wood2 carpet carpetGreen marble tile metal plum frozen musholla lounge gymMat grass`.

## Cara kerja generator

1. Ruangan kantor (seperti `officeModel`, yang disembunyikan tetap disembunyikan) + fasilitas template. Ruangan tambahan dari template sebelumnya yang tidak dipakai, kosong, dan tanpa folder dilepas.
2. Lebar tiap ruangan: lebar pilihan (`FN_WIDTH` × ukuran) dan lebar minimum yang dicek dengan aturan meja asli (`builtIns`) sampai semua penghuni dapat meja.
3. Susunan: lobi di kiri setinggi denah; K koridor horizontal, 2K baris (baris di atas koridor pintunya ke bawah, di bawahnya ke atas, baris yang membelakangi berbagi dinding). Hub berdiri di dua baris tengah dengan pintu ke dua koridor; sisi kiri hub diisi grup pertama, sisi kanan grup terakhir. Dicari K dan panjang baris dengan skor rasio ~1.6, sedikit ruang kosong, tanpa ruas kosong.
4. Pintu yang terbuka ke perabot bawaan (rak server, meja QA, konter) digeser di dinding yang sama; dekor koridor tidak menghalangi pintu.
5. Perabot per ruangan dengan `fillRoom` (seed per `seed:template:room`), tanpa menutup meja, pintu, dan perabot bawaan, dan tetap ada jalan dari pintu ke setiap titik duduk.
6. `resultProblems()` memeriksa: `layoutProblems`, semua ruangan dan kursi meja terjangkau dari lobi dengan perabot terpasang, perabot di dalam ruangan, perabot dinding di dinding atas, tidak bertabrakan, tidak menutup meja/pintu/perabot bawaan, setiap role dapat meja. Apply ditolak bila ada masalah.

## API

| | |
|---|---|
| `GET /api/templates` | `{templates:[{id,name,desc,mood,accent,facilities,strategy,thumb}]}`; `thumb` = SVG kantor contoh. |
| `GET /api/offices/:id/template` | `{current:{id,seed,at}|null, backup:{at}|null}` |
| `POST /api/offices/:id/template/preview` `{template, seed}` | `{template, seed, newRooms, dropped, plan, layout, furniture, problems}`; tidak menyimpan apa pun. |
| `POST /api/offices/:id/template/apply` `{template, seed}` | Dalam satu transaksi: meta `extraRooms`, `layout`, `furniture`, `template`. Cadangan susunan sebelum template **pertama** disimpan di meta `layout-backup` (mencoba beberapa template berturut-turut tetap kembali ke kantor asli). Event `changed/plan`. |
| `POST /api/offices/:id/template/restore` | Mengembalikan `layout`, `furniture`, `extraRooms` dari cadangan lalu menghapus cadangan. |

Wizard: `POST /api/wizard/preview` dan `/api/wizard/create` menerima `template` dan `seed`; preview menampilkan denah bertema, create menerapkan template setelah kantor dibuat (gagal menerapkan tidak menggagalkan pembuatan kantor).
