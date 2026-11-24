# OpenCode sebagai mesin keempat

Kantor bisa menjalankan shift dengan **OpenCode** (`opencode` CLI), selain Claude Code, OpenAI Codex, dan Gemini (Antigravity). Mesin dipilih per role dan bisa diganti saat **Mulai shift**. Board, kotak masuk izin, chat, rapat, pesan antaragen, dan MCP kantor bekerja seperti pada mesin lain.

Diuji di macOS ARM64 dengan OpenCode 2.4.0 (Homebrew) dan langganan OpenCode Go. Login ditangani OpenCode sendiri; Kantor tidak membaca, menyalin, atau menyimpan kredensialnya.

## Pemakaian

1. Pasang OpenCode (`brew install opencode`) lalu login sekali di Mac daemon (`opencode`, atau `opencode auth`).
2. Di tab **Role**, pilih mesin **OpenCode**. Model berbentuk `provider/model` dari `opencode models`, misalnya `opencode-go/glm-5.3`. Kosong berarti model bawaan Kantor: `opencode.defaultModel` di `config.json`, atau `opencode-go/kimi-k3.1-pro` bila tidak diatur. Kalau login di Mac ini tidak menawarkan model itu, OpenCode memilih sendiri. Model `*-free` ditandai *gratis* dan ditaruh paling bawah, karena OpenCode Go menolaknya kecuali console org mengizinkan endpoint yang melatih model dengan data permintaan.
3. Mulai shift seperti biasa. Tugas pertama, kartu, dan mode izin diisi di dialog yang sama.
4. Balasan, panggilan tool, dan hasil tool tampil di tab **Chat**. Isi pemikiran (reasoning) tidak ditampilkan. Tab **Terminal** menampilkan TUI OpenCode yang asli.

Kalau binary ada di tempat lain, isi `"opencode": { "bin": "/path/absolut/opencode" }` di `~/.kantor-claude/config.json`. Mode bawaan saat shift tidak memilih mode bisa diatur dengan `"opencode": { "defaultMode": "acceptEdits" }`; tanpa itu Kantor memakai **Tanya dulu**.

## Cara kerja

Setiap shift menjalankan `hooks/opencode-run.cjs` di pane tmux `kc-<kantor>-<role>`:

1. **Server privat.** `opencode serve --hostname 127.0.0.1 --port 0` dengan kata sandi acak per shift. Konfigurasi shift disuntik lewat `OPENCODE_CONFIG_CONTENT`. OpenCode hanya membaca variabel itu pada server yang ia jalankan sendiri, bukan pada service latar (`opencode serve --service`). Karena itu tiap shift memakai server sendiri. `~/.config/opencode` dan service milik pemilik tidak disentuh.
2. **Sesi.** Id sesi OpenCode boleh dipilih di depan (`ses_…`), jadi sid Kantor sama dengan id sesi OpenCode sejak awal dan tidak pernah berganti. Sesi dibuat lewat API dengan aturan izin mode shift dan model pilihan. Tugas pertama dikirim lewat API (aman untuk kutip, unicode, dan teks panjang).
3. **Jembatan event.** Stream `GET /api/event` dari server privat diterjemahkan menjadi payload hook gaya Claude lalu dikirim ke `/api/hook` daemon:

   | Event OpenCode | Hook Kantor |
   |---|---|
   | `session.execution.started`, `session.inbox.delivered` | `UserPromptSubmit` (bekerja; teks perintah masuk log) |
   | `session.tool.called` | `PreToolUse` |
   | `session.tool.success` / `session.tool.failed` | `PostToolUse` / `PostToolUseFailure` |
   | `session.execution.succeeded` / `failed` | `Stop` (giliran gagal ditulis ke log kantor) |
   | `session.execution.interrupted` | `Interrupt` |
   | `session.compaction.started` / `ended` | `PreCompact` / `PostCompact` |
   | `session.created` dengan `parentID` sesi ini | `SubagentStart`; selesai anak → `SubagentStop` |
   | `permission.asked` | `PermissionRequest` (kotak masuk Kantor) |

   Nama tool dinormalkan ke kosakata Kantor (`shell` → `Bash`, `read` → `Read`, `edit`/`write` → `Edit`/`Write`, `kantor_board_list` → `mcp__kantor__board_list`).
4. **Transkrip.** Daftar pesan sesi (`GET /api/session/:id/message`) disalin ke `~/.kantor-claude/run/<sid>.opencode.jsonl`. Berkas itu hanya ditambah per pesan yang sudah selesai, sehingga tab Chat tidak di-reset. Berkas baru ditulis ulang hanya kalau riwayat berubah (revert).
5. **TUI.** `opencode --server <url-privat> --session <sid> <folder>` di depan. Kalau TUI ditutup, server, jembatan, dan sesinya ikut berhenti, dan Kantor menerima `SessionEnd`.

Berkas privat per shift di `~/.kantor-claude/run/` (mode 0600/0700): `<sid>.opencode-spec.json` (spesifikasi dan kata sandi server), `<sid>.opencode.json` (url dan pid saat berjalan), `<sid>.prompt.md` (persona), `<sid>.opencode.log` (log server), `<sid>.opencode.sh`.

### Persona dan MCP

- Persona, buku catatan, playbook, aturan, dan kartu ditulis ke `<sid>.prompt.md` lalu dipasang sebagai `instructions` sesi. Saat resume, berkas itu ditulis ulang, jadi persona tetap berlaku.
- MCP `kantor` dipasang per shift (`mcp.servers.kantor`) dengan identitas `KANTOR_OFFICE`, `KANTOR_ROLE`, dan `KANTOR_SID` di environment-nya. Token daemon tidak ikut di konfigurasi; `mcp-stdio.js` membacanya dari `server.json`. `codemode` dimatikan untuk server ini, jadi tool muncul langsung sebagai `kantor_<tool>`.
- Dua shift OpenCode yang jalan bersamaan punya server, MCP, dan identitas masing-masing.

### Mode izin

OpenCode mengevaluasi aturan izin dengan urutan "yang terakhir cocok menang". Aturan bawaan agen `build` mengizinkan semuanya, jadi Kantor memasang aturan sesi secara eksplisit:

| Mode (API) | Label | Aturan |
|---|---|---|
| `default` | Tanya dulu | `edit`, `shell`, `webfetch`, `websearch`, `external_directory` → ask |
| `acceptEdits` | Edit file otomatis | seperti di atas, `edit` → allow |
| `plan` | Rencanakan (tanpa edit) | seperti di atas, `edit` → deny |
| `bypassPermissions` | Lewati semua izin | `*` → allow |

Semua mode mengizinkan `kantor_*` (tool MCP kantor). Aturan `deny` di `~/.config/opencode/opencode.json(c)` milik pemilik ditambahkan lagi di akhir, jadi mode Kantor tidak pernah melonggarkannya. `auto`, `dontAsk`, dan mode lain dari manager dipetakan ke `default`; `readOnly` menjadi `plan`. Mode bisa diganti saat sesi berjalan (pilihan **Izin** di drawer/chat, `POST /api/sessions/:sid/mode`, atau `shift_mode` manager). Penggantian dikirim lewat API (`PATCH /api/session/:id`), bukan Shift+Tab.

### Izin dan kotak masuk

Permintaan izin OpenCode masuk kotak masuk Kantor dan ditahan `approvals.holdKantorSec` detik. Izinkan → `once`, tolak → `reject`, **Hentikan** → tolak lalu interupsi giliran. Prompt yang sama juga tampil di TUI. Kalau dijawab di terminal, kartu kotak masuk langsung ditutup dengan status `terminal`. Permintaan izin **subagent** juga masuk kotak masuk. Subagent berjalan di latar dan TUI tidak menampilkan prompt-nya, jadi tanpa kotak masuk subagent itu akan menunggu tanpa terlihat.

## API

```
GET  /api/engines                          (mesin "opencode": available, models, permissionModes)
GET  /api/opencode/models[?fresh=1]        -> {available, models:[{slug,name,provider}], modes, error?}
POST /api/offices/:id/roles/:rid/start     {engine:"opencode", model?, permissionMode?, task?, cardId?, resumeSid?}
POST /api/sessions/:sid/opencode/settings  {model?, mode?}   (lewat server privat shift)
POST /api/sessions/:sid/mode               {mode}
POST /api/sessions/:sid/action             text | esc | stop-all | compact | exit | kill
```

`GET /api/opencode/models` menjalankan `opencode models --standalone` (cache sepuluh menit), jadi Kantor tidak menyalakan service latar milik pemilik. Model yang tidak ada di daftar itu ditolak saat role disimpan dan saat shift dimulai, termasuk dari `shift_start` manager.

Aksi sesi semuanya lewat API server privat: `text` → prompt, `esc`/`stop-all` → interrupt, `compact` → compact, `exit` → menutup supervisor dengan rapi. `clear` ditolak, karena sesi baru di OpenCode berarti id baru; akhiri shift lalu mulai yang baru.

## Resume dan restart daemon

- Shift tetap berjalan saat daemon restart. Pane-nya diadopsi lagi, dan mode izin dipulihkan dari spec shift.
- Resume sesi yang sudah selesai memakai id yang sama (`--session <sid>`) dan selalu dengan mesin OpenCode. Riwayat percakapan tetap ada, karena sesi tersimpan di database OpenCode (`~/.local/share/opencode/opencode.db`) yang juga dipakai service milik pemilik.
- Konsekuensinya, sesi shift Kantor ikut tampil di `opencode session list` milik pemilik. Sesi rapat dibuat dengan status *archived*, tetapi `session list` di OpenCode 2.4.0 tetap menampilkannya.

## Rapat

Role OpenCode ikut rapat lewat `opencode run --standalone --format json --archived`. Persona dipasang sebagai `instructions`. Semua tool ditolak (`* deny`), kecuali membaca file (`read`, `grep`, `glob`, `list`) di giliran riset. MCP tidak dipasang. Biaya dicatat 0.

`PWD` selalu diisi folder proyek. OpenCode menentukan folder proyeknya dari `PWD`, bukan dari cwd proses. Tanpa itu, rapat sempat membaca repo daemon Kantor.

## Batas integrasi

- **Mac lain (multi-PC)**: belum didukung. Mulai shift OpenCode di ruangan yang ada di Mac lain ditolak dengan pesan jelas.
- **Token/payroll dan kesehatan konteks** belum diimpor. Anggaran role OpenCode tidak dihitung, dan nilai kesehatan tampil kosong.
- **Pindahkan dari Terminal ke kantor** (`adopt`) hanya untuk Claude. Sesi OpenCode yang dibuka manual di luar Kantor tidak dilacak.
- **`/clear`** dari Kantor tidak didukung (lihat di atas).
- **Pertanyaan agen** (tool `question` OpenCode) dijawab di TUI, belum lewat kotak masuk.
- **TUI kadang menampilkan prompt izin yang sudah dijawab** dari Kantor (OpenCode 2.4.0 tidak menyegarkan tampilan itu saat klien lain menjawab). Permintaannya sendiri sudah selesai di server; anggap prompt itu usang. Status yang benar ada di kotak masuk dan tab Chat.
- **Variant model** (`provider/model#variant`) diterima, tetapi effort tidak punya pemilih sendiri di UI.

## Verifikasi

- `test/opencode.test.js`: persistensi mesin, katalog, parser model, aturan izin per mode (termasuk deny milik pemilik), spec shift (identitas MCP, unicode), pemetaan tool/izin/event (termasuk subagent), alur hook ke status/kotak masuk, transkrip tanpa reasoning, konfigurasi rapat, pencarian binary, dan supervisor ujung ke ujung terhadap server OpenCode tiruan.
- Uji nyata di daemon, data, dan tmux terisolasi dengan OpenCode Go: persona dan MCP `sessions_list` mengenali role yang tepat, izin disetujui/ditolak dari kotak masuk dan dari terminal, Hentikan di tengah tool, ganti mode dan model, restart daemon, resume, dua shift bersamaan dengan pesan antaragen, subagent dengan izin, dan rapat.
