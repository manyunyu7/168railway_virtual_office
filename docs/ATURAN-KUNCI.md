# Aturan kantor, kunci bersama, dan peringatan kerja berulang

Tiga mekanisme harness yang menggantikan kebiasaan "umumkan lagi lewat announce" dan "buat kunci sendiri dengan mkdir". Kodenya: `server/aturan.js`, `server/locks.js`, `server/repeat.js`, `server/notices.js`, `server/hookctx.js`, tool MCP di `server/aturan-tools.js`; tes di `test/aturan-kunci.test.js`.

## 1. Aturan kantor sebagai data

Tiap kantor punya satu set aturan terstruktur dengan kategori tetap: `commit`, `migrasi`, `e2e`, `jendela-beku`, `kunci`, `lain`. Disimpan di tabel `meta` kantor (kunci `aturan`), tiap perubahan menaikkan **versi** kantor dan tercatat (30 perubahan terakhir, dengan pengubah, waktu, dan alasan).

- Saat shift dimulai, `rolePrompt` (tmux.js) menyisipkan bagian "Aturan kantor terstruktur (versi N)" di samping halaman wiki "Aturan Kantor" yang lama.
- Saat aturan berubah, **setiap sesi yang sedang hidup di kantor itu** (kecuali pengubahnya) diberi tahu **sekali**, tanpa membuka giliran baru: pemberitahuan masuk ke antrean `notices.js` dan keluar sebagai `additionalContext` pada hook `PreToolUse` (atau `PostToolUse` / `UserPromptSubmit`, mana yang datang dulu) milik sesi itu. Dua perubahan pada kategori yang sama sebelum sempat dibaca digabung jadi yang terbaru. Sesi Codex menerimanya lewat `PostToolUse` / `UserPromptSubmit` saja.
- Tool MCP: `aturan_list({riwayat?})` untuk semua; `aturan_set({kategori, isi, alasan?, versi_dasar?})` **hanya manager**. `isi` kosong menghapus kategori; maks 2000 karakter; `versi_dasar` menolak penimpaan kalau versi sudah berubah.
- API: `GET /api/offices/:id/aturan[?riwayat=1]`, `PUT /api/offices/:id/aturan` (`{kategori, isi, alasan?, versi_dasar?}`, atas nama "Kamu"). Event live `{t:'changed', what:'aturan'}`.
- `announce` tinggal untuk kabar sesaat dan insiden.

## 2. Kunci sumber daya bersama

Pengganti kunci `mkdir .git/kc-*.lock` buatan agen. Nama bebas (huruf kecil, angka, `.-_:`; maks 40), mis. `e2e`, `migrasi-db`, `dev-server-3100`, `git-commit`.

| Tool | Fungsi |
|---|---|
| `kunci_ambil({nama, alasan, maks_menit?, tunggu_menit?})` | Ambil kunci. Kalau dipegang orang lain, masuk antrean FIFO dan tool **menunggu** sampai kunci jadi milikmu. `maks_menit`: lama pakai sebelum dilepas otomatis (bawaan 30, maks 180). `tunggu_menit`: lama menunggu (bawaan 10, maks 15; 0 = coba sekali tanpa antre). Status: `didapat`, `dipegang` (sudah milikmu, waktu diperbarui), `belum` (waktu tunggu habis, keluar dari antrean), `sesi-berakhir`. |
| `kunci_lepas({nama, paksa?})` | Lepas kunci milikmu; yang antre paling depan langsung mendapatnya. Manager boleh `paksa:true` untuk kunci orang lain. |
| `kunci_list()` | Semua kunci: pemegang, alasan, sisa menit, antrean. |

Kunci dilepas otomatis ketika: pemegang memanggil `kunci_lepas`; `maks_menit` habis (pemegang diberi tahu sekali lewat pengingat); sesi pemegang berakhir (`SessionEnd`, termasuk `/clear`); atau penyapu 30 detik menemukan sesinya tidak ada lagi. Sesi yang sedang antre lalu berakhir keluar dari antrean. Keadaan ada di memori daemon: restart daemon membebaskan semuanya (agen yang sedang menunggu tidak ikut hidup lagi).

Terlihat di:
- **Web**: kartu "Kunci & aturan" di panel samping Kantor (`web/js/kunci-ui.js`): pemegang, alasan, sisa waktu, antrean, dan ringkasan aturan (versi + isi per kategori).
- **Ghina / klien lain**: `GET /api/offices/:id/kunci` mengembalikan `{kunci:[{nama, pemegang:{nama, role, sid}, alasan, sejak, kedaluwarsa, sisa_menit, maks_menit, antrean:[{posisi, nama, role, alasan, sejak}]}]}`. Perubahan disiarkan di WebSocket event sebagai `{t:'locks', office, locks:[...]}` (daftar yang sama), jadi daftar sederhana cukup muat sekali lalu mengganti isinya tiap event `locks`.
- Log kantor (`kind: 'kunci'`): ambil, antre, dapat setelah N detik, lepas, lepas otomatis, menyerah antre.

## 3. Peringatan kerja berulang (tanpa memblokir)

`hookctx.js` memasang dua hal ke `handleHook` (`live.js`): penyedia konteks (`addHookContext`) dan pengamat tool selesai (`addToolObserver`). Yang dikembalikan hanya `hookSpecificOutput.additionalContext` pada `PreToolUse`; tidak ada `permissionDecision`, jadi tool tetap jalan. Sudah diuji nyata dengan Claude Code 2.1.307: konteks tambahan sampai ke model dan dipatuhinya.

- **Gambar**: `Read` pada png/jpg/gif/webp/bmp yang isinya persis sama (hash isi sampai 8 MB, di atasnya ukuran+mtime) dengan yang sudah dibaca. Pesan menyebut jam pembacaan pertama, berapa kali, dan, bila ada, kalimat yang ditulis model sesudah melihat gambar itu (diambil dari transkrip). Kalau yang melihat sebelumnya sesi lain di kantor yang sama, pesan menyebut namanya.
- **tsc / tes / lint / build** lewat Bash (`tsc`, `npm run test|typecheck|lint|build|e2e`, `vitest`, `jest`, `playwright test`, `pytest`, `phpunit`, `go test`, `cargo test|check`, `flutter test|analyze`, `eslint`, dll; bukan `--watch`/`dev`): perintah yang sama (setelah `| tail/head/grep` dan `2>&1` dibuang) di folder yang sama, sementara sidik jari pohon kerja tidak berubah sejak run terakhir selesai. Sidik jari = `HEAD` + `git status` + ukuran/mtime tiap berkas yang berubah, jadi menyunting berkas yang sudah berubah pun dihitung. Di luar repo git tidak ada peringatan. Pesan menyebut jam, jumlah ulangan, dan hasil terakhir (lulus/gagal).
- Hanya sesi utama (bukan subagent). Status disimpan di memori daemon.

## Hook

`hooks/kantor-hook.cjs` kini mencetak jawaban daemon untuk `PermissionRequest`, `PreToolUse`, `PostToolUse`, dan `UserPromptSubmit` (dulu tanpa `PreToolUse`). Skrip tetap tidak pernah memblokir: bila daemon mati atau lambat (>1,5 dtk) ia keluar tanpa output. Penyedia konteks lain (mis. pengingat DM di `dm.js`) mendaftar lewat `setHookContext` / `addHookContext` di `live.js`; teks beberapa penyedia digabung.
