# Tab Konten: manajemen konten sosial media

Tempat satu pintu untuk konten sosial media sebuah kantor: stok, review, jadwal, paket posting, kit merek, dan performa. Posting tetap manual oleh pemilik; tidak ada auto-post, inbox DM, atau tarikan data dari API platform.

Repo ini publik dan generik: jangan menulis nama proyek, akun, atau path pribadi di kode. Semua yang spesifik sebuah kantor masuk `conf`.

## Konsep

Satu post = satu kartu di papan `konten` (template `konten`) + satu baris tabel `konten`. Tahap = kolom papan, tanggal = `cards.publish_at`, sampul kartu = `cards.cover`. File tetap di folder proyek; kantor hanya menyimpan path relatif.

| Tahap (`id` kolom) | Nama | kind | Arti |
|---|---|---|---|
| `ide` | Ide | antre | |
| `riset` | Riset | antre | |
| `produksi` | Produksi | dikerjakan | |
| `review` | Review kamu | review | menunggu keputusan pemilik |
| `revisi` | Revisi | dikerjakan | pemilik minta perubahan |
| `siap` | Siap tayang | selesai | disetujui, belum dijadwalkan |
| `terjadwal` | Terjadwal | selesai | punya tanggal |
| `tayang` | Tayang | selesai | sudah tayang minimal di satu platform |
| `arsip` | Arsip | selesai | batal atau tersalip |

Papan `konten` dikecualikan dari tawaran kerja autopilot (`candidates`) dan ronde manager (`staleCards`), karena stok lama di Review tidak boleh memicu pesan ke agen.

## Data

Migrasi kantor baru (tambahkan di akhir `OFFICE_MIGRATIONS`, jangan ubah yang lama):

```
konten(card_id PK, folder, jenis, seri, jam, jadwal_status, lagu, sensitif INT, acuan INT, platforms JSON, perf JSON, media JSON, catatan, created_at, updated_at)
konten_kit(id PK, jenis, nama, path, catatan, ord, created_at)
```

- `folder`: relatif ke `conf.root`, mis. `belum-posting/carousel/post-x`.
- `jenis`: `carousel | video | lain`.
- `jadwal_status`: `'' | usulan | fix`. Usulan editor tampil beda sampai pemilik menyetujui.
- `platforms`: `{ instagram: { link, at }, threads: {…} }`, hanya platform yang sudah tayang.
- `perf`: `{ instagram: { reach, like, comment, save, share, at } }`, diisi tangan.
- `media`: penimpa deteksi otomatis, `{ slides: [rel], video: rel, cover: rel }`.
- `konten_kit.jenis`: `logo | outro | slide-jualan | acuan | sfx | lain`.

`conf` disimpan per kantor (tabel `meta`, kunci `konten.conf`), bawaan:
`{ root: '', targetPerMinggu: 5, targetPerHari: 0, platforms: ['instagram','threads','tiktok','youtube'], jamDefault: '19:00', pindahFolder: true, statusFile: '', wikiTayang: '', wikiBelum: '', editor: '' }`. `root` relatif ke akar kantor. Kalau `root` kosong: API tetap jalan, impor menolak dengan pesan jelas.

Platform per jenis: `carousel` tidak ditawarkan ke `youtube`. Key platform: `instagram | threads | tiktok | youtube`.

## Bentuk Item

```
{ id, title, tahap, tahapNama, board:'konten', who, whoName, folder, jenis, seri, labels,
  publishAt, jam, jadwalStatus, lagu, sensitif, acuan, catatan, updatedAt, createdAt,
  coverUrl,                         // thumb, null kalau tidak ada
  platforms: { instagram: { link, at } },
  perf: { instagram: {...} },
  pratinjau: [{ id, title, status }],   // lewat pratinjau.card
  // hanya di GET satuan:
  media: { slides: [{ rel, name, url, thumb }], video: { rel, name, url, thumb, size } | null, cover: { rel, url, thumb } | null },
  captions: { instagram, threads, tiktok, youtube, sumber },  // teks atau null
  platformTarget: ['instagram', ...], desc }
```

`url` dan `thumb` mengarah ke `GET /api/offices/:id/konten/:cid/file?path=<rel>[&thumb=1]`, hanya boleh berkas di dalam `conf.root` (tolak `..` dan symlink keluar). Dukung Range untuk video. Thumb pakai `thumbFile` dari `server/attachments.js`.

Deteksi media kalau `media` kosong: carousel = `out/slide-*.png`, lalu `clean/*.png`, lalu `out/*.png` (urut nama, abaikan subfolder `opsi`); video = `<root>/_hasil/FINAL/<nama>*-FINAL.mp4`, lalu `<root>/_hasil/siap/<nama>*.mp4` terbaru, lalu `out/*.mp4` terbaru selain `old-*` dan `scene-*`, dengan `<nama>` = nama folder tanpa awalan `post-`/`video-`, dan render milik proyek saudara (`<nama>-x` yang punya folder sendiri) tidak dihitung; carousel yang punya slide tidak melihat `_hasil`; sampul = `<nama>*cover*` di dua folder `_hasil` itu, lalu slide pertama.

Caption dibaca dari `caption-instagram.md` di folder, per bagian `## Instagram`, `## TikTok`, `## Threads`, `## YouTube`; berkas tanpa bagian itu = teks pembukanya (sampai garis `---`) atau `## Versi ...`/`## 01 ...` pertama jadi caption Instagram, `## Versi Threads` jadi Threads, sisanya (catatan redaksi, build ulang) tidak ikut. YouTube kosong memakai TikTok. `PUT caption` menulis balik hanya bagian itu.

## API (`/api/offices/:id/konten`, auth sama seperti endpoint kantor)

| Metode | Path | Isi |
|---|---|---|
| GET | `` | `?tahap=&seri=&jenis=&q=` → `{ items:[Item], stages:[{id,name,kind,n}], seri:[{nama,n}], conf }` |
| POST | `` | `{ title, jenis, folder?, seri?, tahap?, who? }` → Item |
| GET | `/conf`, PATCH `/conf` | conf |
| GET | `/jadwal` | `?from=&to=` → `{ items, peringatan:[{kode,pesan,ids,tanggal}], minggu:[{mulai,n,target}] }` |
| POST | `/jadwal/setujui` | `{ ids }` → `jadwal_status='fix'`, kartu ke `terjadwal` |
| POST | `/impor` | `{ dryRun }` → `{ dibuat, dilewati, perTahap, contoh }`; idempoten per `folder` |
| GET/POST | `/kit` | list, tambah `{jenis,nama,path,catatan}`; DELETE `/kit/:kid` |
| GET | `/:cid` | Item lengkap |
| PATCH | `/:cid` | `{ tahap, title, publishAt, jam, seri, jenis, lagu, sensitif, acuan, catatan, folder, media, who }`. Mengisi `publishAt` memindah ke `terjadwal` bila tahapnya `siap`; mengosongkan mengembalikan ke `siap` |
| PUT | `/:cid/caption` | `{ platform, text }` |
| POST | `/:cid/review` | `{ keputusan:'setuju'\|'revisi', catatan?, slide? }`. Setuju → `siap`; revisi → `revisi`. Kirim DM ke `who` lewat `dm.fromOwner` bila ada, komentar kartu selalu |
| POST | `/:cid/tayang` | `{ platform, link?, at? }`. Pertama kali → tahap `tayang`, tulis `SUDAH-POSTING.txt`, pindah folder bila `pindahFolder` dan polanya `belum-posting/<jenis>/x`, tambah baris di `statusFile` bila diatur, segarkan wiki. Respons memuat `pathPerluCek` (daftar berkas yang masih menyebut path lama, tidak diubah otomatis) |
| POST | `/:cid/performa` | `{ platform, reach, like, comment, save, share }` |
| GET | `/:cid/file` | lihat di atas |

Setiap perubahan memancarkan `{ t:'changed', office, what:'konten', id }`, ditambah event papan yang sudah ada.

Peringatan jadwal (`kode`): `seri-berdempet` (seri sama dalam 2 hari berurutan), `sensitif-berjejer` (dua `sensitif` berurutan), `harian-lebih` (melewati `conf.targetPerHari`, 0 = mati), `target-lebih`, `target-kurang` (per minggu ISO, Senin awal), `tanpa-caption`, `tanpa-media`.

Pengingat (`conf.pengingat = { aktif, pagi, sebelumMenit, terlewatMenit, susulanJam }`, dicek tiap menit, tiap satu terkirim sekali): ringkasan pagi, "Waktunya posting" sebelum jam tayang untuk semua kartu bertanggal yang belum tayang, "Belum ditandai tayang" sesudahnya, dan "Belum di <platform>" untuk post yang tayang di sebagian platform dalam 48 jam terakhir. `POST /konten/pengingat/tes` mengirim satu notifikasi percobaan. Saat ada kartu baru masuk `review` juga satu notify.

## Impor

`server/konten-import.js`, generik, baca `conf.root`:
- `sudah-posting/*/*` → `tayang`. Link dari `SUDAH-POSTING.txt`; tanggal tayang diturunkan dari shortcode Instagram bila ada (`id = base64url → BigInt`, `ms = (id >> 23n) + 1314220021721n`), kalau tidak ada biarkan kosong, jangan mengarang.
- `belum-posting/*/*` → punya media + caption: `review`; media tanpa caption: `produksi`; hanya `OPSI.md`/`riset.md`/`BRIEF.md`/`NASKAH.md`: `riset`; selain itu `ide`.
- `cek-dulu/*/*` → `review` dengan label `cek-dulu`.
- Lewati `_kit`, `node_modules`, folder berawalan `_` di tingkat jenis, entri bukan folder.
- Judul: dari `Judul IG:` di `SUDAH-POSTING.txt`, lalu baris pertama caption dipotong 90 karakter di batas kata, lalu nama folder dimanusiakan.
- `jenis` dari awalan folder atau induknya. `seri`: folder yang berbagi 2 atau 3 token awal (tanpa `post`/`video`) minimal dengan satu folder lain. `sensitif`: nama folder memuat tahun 19xx/20xx dan jenisnya video.
- Tidak memindah atau mengubah berkas apa pun.

## Tool MCP

Di `server/konten-tools.js`, didaftarkan seperti `PRATINJAU_TOOLS`, boleh semua role. Identitas pemanggil jadi `who` bila kosong.

`konten_list` (filter tahap/seri/q, ringkas), `konten_get`, `konten_buat`, `konten_set` (tahap, media, lagu, seri, sensitif, catatan; tidak boleh memindah ke `siap`, `terjadwal`, atau `tayang`: itu keputusan pemilik), `konten_kirim` (`{ id, catatan? }`: pindah ke `review`, notify pemilik, kartu tampil di Paket Posting), `konten_jadwal_usul` (`{ jadwal:[{id,tanggal,jam?}] }`: `jadwal_status='usulan'`, tolak yang belum `siap`, kembalikan peringatan), `konten_tayang` (hanya kalau pemilik sudah bilang tayang), `konten_performa`, `kit_list`, `kit_tambah`.

## Web (`web/js/konten.js`, `web/css/konten.css`)

Tab `Konten` (`#/o/<id>/konten[/<sub>|/p/<cid>]`), ditambahkan di `TABS` dan `MODULES`. Sub-tampilan:
- **Galeri**: kisi sampul; filter tahap, seri, jenis, cari. Pil tahap, ikon sensitif.
- **Review**: antrean tahap `review`, urut lama ke baru; lihat slide atau video penuh, Setuju, atau Revisi dengan catatan.
- **Kalender**: bulan; sampul per hari, seret dari panel "Siap tayang" ke tanggal, peringatan di atas, angka target per minggu, tombol "Setujui jadwal" untuk usulan.
- **Grid**: pratinjau 3 kolom seperti profil IG, terjadwal paling atas lalu yang sudah tayang.
- **Kit**: kartu per jenis; tambah, hapus, pratinjau.
- **Performa**: tabel post tayang per platform, isi cepat, urut per metrik.
- **Paket Posting** (`/p/<cid>`): media besar, unduh per berkas, tombol Bagikan (`navigator.share` dengan files bila didukung), caption per platform dengan Salin dan sunting, sampul, saran lagu, baris "Sudah tayang" per platform dengan isian link. Harus nyaman di layar 360px.

Warna dari token `web/css/theme.css`, terang dan gelap. Bahasa Indonesia santai, tanpa em dash.

## Ghina (`lib/presentation/features/kantor/konten/`)

Tab Konten native memakai API di atas: Paket Posting (simpan ke galeri lewat `gal`, bagikan lewat `share_plus`, salin caption, tandai tayang, isi performa), Galeri, Review, Jadwal (daftar per tanggal plus peringatan, geser tanggal lewat pemilih, setujui usulan). Kit dan Grid cukup di web. Aman kalau server lama membalas 404: tampilkan keadaan kosong.

## Catatan server (bentuk yang dipakai kode)

Hal yang tidak tertulis di atas atau sedikit lebih rinci; sumber kebenarannya `server/konten.js`.

- Semua path di Item, `media`, kit, dan query `file?path=` **relatif ke `conf.root`** (bukan ke folder kantor). `conf.root` sendiri relatif ke folder kantor; `.` boleh (folder kantor itu sendiri), kosong = belum diatur.
- `GET /kit` membalas `{ items:[{id,jenis,nama,path,catatan,ord,createdAt,ada,url,thumb}] }` (`url`/`thumb` hanya untuk berkas, lewat `GET /konten/kit/file?path=<rel>[&thumb=1]`, aturan keamanan sama dengan `/:cid/file`). `POST /kit` membalas satu item, `DELETE /kit/:kid` membalas `{ok:true}`.
- `POST /jadwal/setujui` membalas `{ items:[Item] }`; semua `ids` harus punya `publishAt`, kalau tidak galat 400 dan tidak ada yang berubah.
- `POST /:cid/review` membalas Item ditambah `dm` (`{id,ke,status,pengiriman}`, `{error}`, atau `null` bila kartu tanpa `who`). `revisi` wajib bercatatan; kartu harus sedang di `review` (409 bila tidak).
- `POST /:cid/tayang` membalas Item ditambah `dipindah:{dari,ke}|null`, `pathPerluCek:[rel]`, `sudahPosting:'dibuat'|'ditambah'|'sudah-ada'|null`, `statusFile:bool`, `wiki`, `peringatan:[teks]`. Galat 409 bila tujuan pemindahan sudah ada (tidak ada yang berubah). `publishAt` kartu diisi tanggal `at` saat pertama tayang. `statusFile` relatif ke `conf.root`; baris ditambah di akhir tabel pertama berkepala `| Folder |`. Halaman wiki hanya ditimpa bila belum ada atau berisi penanda `<!-- digenerate Kantor: tab Konten -->`.
- `PATCH /:cid` dengan `tahap:'tayang'` ditolak (pakai `/tayang`). Mengisi `publishAt` lewat PATCH menandai `jadwal_status='fix'`; usulan editor hanya lewat tool `konten_jadwal_usul` (kartu tetap `siap` dengan tanggal terisi sampai disetujui).
- `GET /jadwal` memuat kartu `siap` bertanggal, `terjadwal`, dan `tayang` yang `publishAt`-nya di dalam rentang. `peringatan.tanggal` adalah tanggal item kedua (berdempet/berjejer) atau Senin minggunya (target). `target-kurang` hanya untuk minggu ini dan yang akan datang.
- Sampul kartu disimpan di `cards.cover` sebagai `kt:<cid>:<rel>` (papan umum ikut menampilkannya lewat endpoint file).
- Notifikasi ke Ghina memakai `kind:'konten'`, diteruskan sebagai event `pratinjau` dengan `path` `#/o/<kantor>/konten/p/<cid>` (judul "Konten perlu review" atau "Waktunya tayang"); `ghinaNotify.konten=false` mematikannya. Pengingat jadwal tidak menyebut kartu yang terlewat lebih dari 7 hari.
- `POST /impor` tanpa `conf.root` galat 400.
- Caption: judul `##` apa pun mengakhiri bagian sebelumnya; hanya `## Instagram` (atau `## Caption`), `## TikTok`, `## Threads`, `## YouTube` yang dihitung caption. `## Threads balasan`, `## Catatan`, dsb. bukan caption (tidak tersalin) dan dijaga apa adanya saat `PUT caption`.
- `POST /:cid/tayang` idempoten: untuk platform yang sudah tayang hanya memperbarui link (tanpa link tidak menghapus yang lama; `at` awal dipertahankan kecuali diberikan), tidak memindah folder lagi, tanpa galat.
