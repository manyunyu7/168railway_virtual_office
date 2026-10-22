# Tool MCP untuk membangun kantor

Selain board, wiki, dan pesan, MCP `kantor` punya tool untuk merombak kantor itu sendiri: role (karyawan tetap), ruangan, denah, template, dan perabot. Tersedia di sesi Claude dan Codex (server yang sama, `server/mcp-stdio.js` meneruskan ke `/api/agent/tools` dan `/api/agent/call`). Kodenya di `server/denah-tools.js`; tes di `test/denah-tools.test.js`.

## Daftar tool

| Kelompok | Tool | Siapa |
|---|---|---|
| Role | `role_create`, `role_update`, `role_arsipkan` | manager |
| Ruangan | `room_create`, `room_update`, `room_pindah`, `room_resize`, `room_hapus` | manager |
| Denah | `denah_ubah`, `denah_rapikan`, `denah_pulihkan` | manager |
| | `denah_lihat` | semua |
| Template | `template_terapkan`, `template_pulihkan` | manager |
| | `template_list`, `template_pratinjau` | semua |
| Perabot | `perabot_katalog` | semua |
| | `perabot_taruh`, `perabot_pindah`, `perabot_hapus`, `perabot_isi_ruangan` | manager: ruangan mana pun; role biasa: hanya ruangannya sendiri |

Ringkas per tool (skema lengkap ada di deskripsi tool):

- `role_create({nama, jabatan, kepribadian?, skills?, ruangan?, model?, mesin?, effort?, atasan?, tampilan?})`: rekrut role. Manager tidak bisa dibuat dari sini. Bila ruangannya penuh, ruangan otomatis diperbesar (ukuran divalidasi seperti `room_resize`, ada cadangan untuk `denah_pulihkan`); kalau terhalang, role ditempatkan di ruangan lain sejenis yang punya meja; jenis ruangan yang tak menampung meja (mis. lobi) tetap ditolak. Hasilnya menyebut apa yang dilakukan. Setelah itu panggil `shift_start`.
- `role_update({role, ...field})`: field sama; status manager tidak bisa diubah. Sesi yang sedang jalan memakai pengaturan baru di shift berikutnya.
- `role_arsipkan({role, pulihkan?})`: arsip, bukan hapus permanen. Manager, diri sendiri, dan role yang sedang shift ditolak.
- `room_create({name, kind?, path?, create?, git_init?, ukuran?:{w,h}, posisi?:{x,y}})`: tanpa posisi, ruangan masuk baris baru di bawah denah.
- `room_update({room, nama?, jenis?, catatan?, ukuran?, posisi?})`: satu paket atomik. `jenis` hanya untuk ruangan tambahan.
- `room_pindah({room,x,y})`, `room_resize({room,w,h})`: pintasan satu operasi `denah_ubah`. Perabot ikut pindah bila ruangan hanya berpindah; bila ukurannya berubah, perabot tetap dan ditolak kalau keluar ruangan.
- `room_hapus({room})`: hanya ruangan tambahan tanpa folder/repo, tanpa penghuni dan tanpa sesi. Perabotnya ikut dihapus.
- `denah_lihat({room?})`: ukuran, tiap ruangan (jenis, posisi, ukuran, pintu, lantai, penghuni, jumlah perabot), template aktif, daftar `masalah` yang ada. Dengan `room`: daftar perabot beserta `uid`.
- `denah_ubah({ops, coba?})`: `ops` maksimal 60, masing-masing `{op:"pindah",room,x,y}`, `{op:"ukuran",room,w,h}`, `{op:"atur",room,x?,y?,w?,h?}`, `{op:"pintu",room,pintu:[{s,at,w}]}`, `{op:"lantai",room,lantai}`, `{op:"denah",w,h}`, `{op:"rapikan"}`. Koordinat harus bilangan bulat (tidak dibulatkan diam-diam). `coba:true` hanya menguji.
- `denah_rapikan({coba?})`: port "Rapikan otomatis" dari `web/js/layout-editor.js` (`tidyPlan`): ruangan disusun ulang ke baris rapi dengan koridor; ukuran tetap, perabot ikut.
- `denah_pulihkan({id?, daftar?})`: kembalikan ke cadangan (bawaan yang terbaru).
- `template_list()`, `template_pratinjau({template, seed?})`, `template_terapkan({template, seed?})`, `template_pulihkan()`: sama dengan galeri template di web (lihat `docs/TEMPLATES.md`).
- `perabot_katalog({kategori?, cari?})`: tanpa argumen daftar kategori; dengan argumen daftar item (maks 60).
- `perabot_taruh({room, item, x?, y?})`: tanpa x,y dicarikan tempat yang muat (menempel dinding untuk item dinding; menghindari meja, pendaratan pintu, dan perabot bawaan; paling dekat dinding dulu). `item` boleh id atau nama.
- `perabot_pindah({uid,x,y})` (dalam ruangan yang sama), `perabot_hapus({uid | uids})`, `perabot_isi_ruangan({room, kepadatan?, seed?})` (memakai `fillRoom` yang sama dengan editor dan template).

Tool pratinjau (`pratinjau_kirim`, `pratinjau_status`) untuk semua role; kontrak lengkapnya di bagian "Pratinjau" [`FRONTEND-CONTRACT.md`](FRONTEND-CONTRACT.md):

- `pratinjau_kirim({judul, files?:[path], folder?, mode?:'set'|'pilihan'|'bundle', jenis?:'info'|'persetujuan'|'pilihan', catatan?, kartu?, revisiDari?})`: `jenis` bawaan `info` (cukup dilihat); `persetujuan` hanya bila agen benar-benar butuh keputusan Setujui/Revisi; `pilihan` untuk memilih satu dari 2+ alternatif (bawaan mode pilihan). Kirim hasil visual (gambar, PDF, video, HTML, atau folder/.zip situs statis) untuk diputuskan pemilik. Dipakai saat pemilik minta pratinjau/preview. Path relatif terhadap folder kerja dan harus di dalam folder kantor (symlink diikuti, `..` keluar ditolak). Maks 30 berkas / 200 MB per pratinjau (`config.pratinjau.maxFiles/maxBytes`). Berkas disalin saat itu juga (snapshot). `revisiDari` membuat versi berikutnya (v2, v3, ...). Keputusan pemilik datang sebagai pesan langsung dari "Pemilik"; diskusi lewat pesan, bukan wiki.
- `pratinjau_status({id})`: jenis, status (baru/dilihat/dikomentari/sebagian/disetujui/revisi/dipilih), `dilihat` (waktu), `reaksi` [{emoji, at}], `komentar` [{teks, berkas, detik, waktu, at}], keputusan per berkas, pilihan, flag disimpan/arsip/ditunda, dan daftar versi. Komentar pemilik juga datang sebagai DM (membangunkan); tanda lihat dan reaksi tidak.

Tool board (`board_list`, `card_get`, `card_create`, `card_update`, `card_check`, `card_comment`) untuk semua role. Kantor bisa punya beberapa papan (lihat bagian Board di [`FRONTEND-CONTRACT.md`](FRONTEND-CONTRACT.md)):

- `board_list({papan?, col?, who?, repo?, mine?})`: hasilnya `papan_ini`, `papan_bawaanmu`, `papan` (semua papan aktif beserta kolom dan jenisnya), `kolom`, dan `kartu` (dengan `papan`, `kolom`, `jenis_kolom`, `tayang`). Tanpa `papan` = papan bawaan agen: papan yang mencantumkan role-nya (`roles`), lalu ruangannya (`rooms`), lalu Utama. `papan:"semua"` = kartu semua papan. `col` = nama kolom papan itu atau jenisnya (`antre|siap|dikerjakan|review|selesai`).
- `card_create({title, papan?, col?, publish_at?, ...})`: tanpa `papan` = papan bawaan agen (kecuali sub-kartu epic: ikut papan epic). `col` boleh nama kolom, jenis, atau nama kolom lama ("Siap", "Selesai") yang dipetakan lewat jenis.
- `card_update({id, papan?, col?, publish_at?, ...})`: `papan` memindah kartu ke papan lain (kolom ikut jenis yang sama kalau `col` kosong). `publish_at` kosong menghapus tanggal tayang.
- `card_get` menyertakan `papan`, `kolom`, `jenis_kolom`, dan `moves` (riwayat pindah kolom).

Tool aturan kantor (`aturan_list`, `aturan_set`) dan kunci bersama (`kunci_ambil`, `kunci_lepas`, `kunci_list`) dijelaskan di [`ATURAN-KUNCI.md`](ATURAN-KUNCI.md).

## Aturan izin

- Tulis ke denah, ruangan, role, dan template: **hanya manager** (`role.isMgr`). Sesi tanpa role selalu dianggap bukan manager.
- Role biasa boleh `denah_lihat`, `template_list`, `template_pratinjau`, `perabot_katalog`, dan mengubah perabot (`perabot_*`) hanya di ruangannya sendiri (atau ruangan terbuka tempat zonanya berada). Memindahkan perabot ke ruangan lain ditolak.
- Role tidak bisa menjadikan siapa pun manager, dan tidak ada tool yang menghapus role atau ruangan berfolder.
- Batas laju: 40 perubahan per menit per role (`setRateLimit` di tes). Membaca tidak dibatasi.
- Input divalidasi ketat: bilangan bulat, rentang, daftar tertutup (jenis ruangan, lantai, model, gaya rambut), panjang teks, warna `#RRGGBB`. Path ruangan harus relatif terhadap folder kantor (`..` ditolak, awalan `/` dibuang) dan hanya `create:true` yang membuat folder, selalu di dalam folder kantor. Tool tidak menulis file di luar data kantor kecuali folder ruangan itu.

## Atomik dan cadangan

- Setiap tool yang mengubah denah/perabot berjalan dalam satu transaksi (`atomic()`): setelah perubahan, masalah kantor dihitung ulang dengan `resultProblems` (tumpang tindih, ruangan atau meja tak terjangkau dari lobi, perabot keluar ruangan atau menutup pintu/meja, meja penghuni kurang). Masalah yang **baru** muncul membuat semuanya dibatalkan dan daftar masalahnya dikembalikan sebagai pesan error. Masalah yang sudah ada sebelumnya tidak menghalangi perubahan lain.
- Perombakan menyimpan cadangan di meta `denah-backup` (8 terakhir; berisi `layout`, `furniture`, `extraRooms`, `rooms`): `denah_ubah`, `denah_rapikan`, `room_create` dengan ukuran/posisi, `room_update` dengan ukuran/posisi, `room_hapus`, `template_terapkan`, `perabot_isi_ruangan`, dan `denah_pulihkan` sendiri (jadi pemulihan bisa dibatalkan). Template tetap juga memakai `layout-backup` miliknya (`template_pulihkan`).
- Perabot satuan (`perabot_taruh/pindah/hapus`) tidak membuat cadangan, hanya divalidasi.

## Efek samping

- Log kantor: tiap perubahan dicatat (`kind: 'denah'` untuk denah/ruangan/perabot, `'role'` untuk role).
- WebSocket: event yang sama dengan editor web. `{t:'changed', what:'plan'}` untuk denah, ruangan, role, dan template; `{t:'changed', what:'furniture'}` untuk perabot satuan. Web dan Ghina memuat ulang denah sendiri (`web/js/main.js`).

## Batasan

- `room_create` tanpa posisi menaruh ruangan di baris baru; ruangan tambahan lain di baris yang sama bisa tertabrak bila ukurannya diperbesar, dan itu ditolak (beri `posisi`).
- Denah lama yang sudah punya masalah (mis. ruangan yang tak terjangkau) tetap bisa diubah; hanya masalah baru yang menolak. `saveLayout` sendiri tetap menolak denah yang bertabrakan atau pintunya tak pas di dinding.
- `denah_rapikan` menolak bila pintu barunya tertutup perabot yang sudah ada; kosongkan perabot di depan pintu dulu.
- `template_terapkan` memakai transaksi dan pemeriksaan milik `applyTemplate`; bila ditolak, cadangan yang sempat dibuat dibuang lagi.
- Tidak ada penghapusan ruangan berfolder atau role, dan tidak ada perubahan peran manager lewat MCP.

## Toleransi tool kantor

Tool dirancang supaya salah panggil bisa dipulihkan dalam satu langkah, tanpa bertanya ke pengguna:

- `card_check`: item ditunjuk dengan `nomor` (mulai 1), id item, atau teks/potongan teks (`item` menerima ketiganya; `index` lama tetap mulai 0). Teks yang cocok dengan beberapa item mengembalikan kandidatnya; item tak ketemu mengembalikan daftar item kartu (id, nomor, teks, status). Teks yang tak cocok tanpa nomor/id tetap menambah item baru.
- Id kartu di `card_get`, `card_update`, `card_check`, `card_comment` boleh dengan `#`, huruf besar, atau awalan unik.
- Isi kosong (`announce`, `card_comment`, `card_create`, `note_write`, `role_notes_write`) ditolak dengan petunjuk field mana yang harus diisi.
- `shift_mode` saat sesi menampilkan dialog: perubahan dijadwalkan (dicoba tiap 3 detik, maks 10 menit, yang terbaru menang) dan dicatat di log kantor saat diterapkan atau batal.
- Log harness: baris `gagal: <tool>` menyertakan alasan (maks ~160 karakter; token dan kunci disamarkan).
