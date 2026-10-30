# Gemini melalui Antigravity CLI

Kantor menyediakan mesin `antigravity` dengan label **Gemini (Antigravity)** pada editor role dan dialog **Mulai shift**. Claude dan Codex tetap tersedia. Pilihan per shift mengalahkan bawaan role.

## Pemakaian

1. Pasang CLI resmi dari https://antigravity.google/cli/install.sh dan jalankan `agy` untuk login akun Google pada mesin daemon Kantor.
2. Di tab **Role**, ubah mesin role menjadi **Gemini (Antigravity)**, atau pilih mesin tersebut saat **Mulai shift**.
3. Pilih model dari daftar akun; kosong berarti mengikuti bawaan Antigravity. Tugas pertama dan kartu bisa diisi seperti shift lainnya.
4. Balasan, panggilan tool, dan hasil tool tampil di tab **Chat**. Terminal asli tetap tersedia. Gunakan `/model`, `/permissions`, `/usage`, dan `/credits` di terminal untuk pengaturan sesi serta kuota.

Diuji pada macOS ARM64, Antigravity CLI 1.4.11, login Google AI Pro. Pembaruan ini di-deploy ke daemon Mac yang menggunakan sesi langganan tersebut; tidak menyalin kredensial ke server lain. `antigravity.bin` di konfigurasi Kantor bisa menunjuk lokasi executable absolut lain.

## Integrasi

- `engine: "antigravity"` disimpan pada role dan sesi; model adalah slug dari `agy models`. `GET /api/antigravity/models` mengembalikan ketersediaan binary, daftar model akun (cache sepuluh menit), serta mode yang didukung. UI menampilkan model Gemini.
- Shift menggunakan `agy --settings <berkas-privat>`, dengan model/effort opsional dan `--prompt-interactive` untuk tugas pertama. Resume memakai `--conversation <id>` dan mesin sesi asal, meskipun bawaan role sudah berubah. ID percakapan CLI mengambil alih ID sementara shift melalui mekanisme hook Kantor yang sudah ada.
- Persona, buku catatan, playbook, dan aturan disimpan di berkas privat per shift, lalu diinjeksikan oleh hook `SessionStart`. Resume juga dapat menerima persona melalui hook `PreInvocation` pertama.
- Antigravity tidak memuat hook/MCP dari `--settings`. Kantor menambahkan hook bernama `kantor-claude` di `~/.gemini/config/hooks.json` serta MCP `kantor` di `~/.gemini/config/mcp_config.json`. Entri lain dipertahankan dan berkas yang berubah dicadangkan. Nama MCP yang dipakai integrasi lain ditolak. Hook tidak melakukan apa pun di luar sesi dengan `KANTOR_ENGINE=antigravity`.
- MCP mewarisi identitas kantor/role/sesi dari environment; token daemon dibaca oleh proses MCP dari `server.json`. Kredensial Google ditangani CLI sendiri, tidak dibaca atau disalin Kantor.
- Protokol camelCase hook dinormalisasi menjadi event Kantor: `PreInvocation` → bekerja, `PreToolUse`/`PostToolUse` → aktivitas tool, `Stop` ketika `fullyIdle` → idle. Transkrip native `transcript.jsonl` maupun `transcript_full.jsonl` dibaca menjadi item Chat, tanpa menampilkan pesan sistem atau pemikiran internal.
- Pengaturan izin dan trust hanya untuk invocation tersebut. Hanya folder kerja shift yang dipercaya. Aturan deny/ask pengguna dipertahankan; tool MCP `kantor/*` diizinkan seperti pada engine lain. Mode bawaan adalah tanya dulu, tanpa mengikuti bypass Claude. `useG1Credits` selalu false untuk shift Kantor.
- Rapat memakai headless `--output-format stream-json`, persona role, mode plan, serta deny untuk perintah, penulisan file, web, dan MCP. Giliran riset hanya diizinkan membaca file.

## Batas integrasi awal

- Antigravity tidak menyediakan event `PermissionRequest` yang setara. Izin native dijawab dari **Terminal**, belum dari kotak masuk izin Kantor. Tombol model/izin mengarahkan ke terminal agar menu Claude tidak terkirim ke Gemini.
- Sesi manual di luar Kantor belum ditemukan oleh pemindai proses. Mulai shift dari Kantor untuk mendapatkan persona dan pelacakan sesi.
- Subagent, kesehatan konteks, token/payroll, dan persentase kuota Gemini belum diimpor. Nilai kesehatan yang tidak tersedia ditampilkan kosong; gunakan `/usage` untuk kuota resmi. Hentikan mengirim Esc untuk giliran utama, bukan sapuan Ctrl+X Ctrl+K milik Claude.

## Verifikasi

- Suite `npm test`; tes tambahan `test/antigravity.test.js` mencakup persistensi mesin, normalisasi hook/MCP, pelestarian konfigurasi, flag izin/resume, serta dispatch transkrip native setelah resume.
- Uji nyata di kantor, data, dan tmux terisolasi: persona diterima, balasan terbaca, MCP `sessions_list` mengenali role yang tepat, dan resume mempertahankan penanda percakapan serta memanggil MCP tanpa prompt tambahan.
- Form editor di Chrome memuat pilihan Gemini 4 Argon dan Gemini 3.8 Flash dari akun yang login.

Referensi resmi: [hooks](https://antigravity.google/docs/hooks), [settings](https://antigravity.google/docs/settings?tab=cli), [MCP](https://antigravity.google/docs/mcp), [headless](https://antigravity.google/docs/cli/headless), [kuota](https://antigravity.google/docs/plans).
