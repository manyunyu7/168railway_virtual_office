# OpenAI Codex sebagai mesin kedua

Kantor bisa menjalankan shift dengan **Claude Code** (bawaan) atau **OpenAI Codex CLI**. Mesin dipilih per role (bawaan role) dan bisa diganti saat mulai shift. Sisanya (denah, board, kotak masuk izin, chat, notifikasi Ghina) bekerja sama untuk kedua mesin.

Diuji dengan Codex CLI 0.163.0, login langganan ChatGPT. Auth dibaca Codex sendiri dari `~/.codex/auth.json`; Kantor tidak membaca, menyalin, atau menyimpannya.

## Riset ringkas (sumber: dokumentasi Codex di learn.chatgpt.com/docs, `codex --help`, `codex features list`, dan percobaan nyata)

| Hal | Hasil |
|---|---|
| Hooks | `features.hooks` stabil. Event: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`, `Interrupt`. Stdin JSON hampir sama dengan Claude Code (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `tool_name`, `tool_input`, ...). Tidak ada `Notification` dan `PostToolUseFailure`. `SessionStart` baru jalan saat prompt pertama, bukan saat TUI terbuka. |
| Hook menahan izin | **Bisa.** `PermissionRequest` boleh membalas `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` atau `deny` + `message`; selama hook jalan (timeout bawaan 600 dtk) TUI menampilkan "Running hook". Beda dengan Claude: `interrupt`, `updatedInput`, `updatedPermissions` ditolak (fail closed), jadi Hentikan tetap lewat Esc. `PreToolUse` hanya bisa deny/rewrite, tidak `ask`. |
| Pasang hook per sesi | Hook dibaca dari `hooks.json`/`[hooks]` di config, **dan** dari `-c hooks.<Event>=[...]` di CLI. Hook non-managed harus "ditrust" lewat `/hooks` (disimpan ke `~/.codex/config.toml`); `--dangerously-bypass-hook-trust` melewatinya untuk satu invocation, jadi config global tidak disentuh. |
| Trust folder | Codex menanyakan "Trust this folder?" dan menyimpan jawabannya ke config global. `-c 'projects={"<folder>"={trust_level="trusted"}}'` melewatinya tanpa menyimpan apa pun (bentuk `projects."<folder>".trust_level` lewat `-c` tidak berfungsi). |
| Model | `codex debug models` mengeluarkan JSON daftar model akun (slug, nama, deskripsi, effort yang didukung, default). `-m <slug>`. |
| Effort | `-c model_reasoning_effort="low"`. Nilai: `low`, `medium`, `high`, `xhigh`, `max`, `ultra` (tergantung model; lihat `supported_reasoning_levels`). |
| Izin/sandbox | `--sandbox read-only|workspace-write|danger-full-access`, `--ask-for-approval on-request|never`, `--approve-for-me` (review otomatis), `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`). `--full-auto` tidak ada lagi di 0.163. |
| Instruksi tambahan | `-c developer_instructions="..."` (pesan developer tambahan, prompt bawaan Codex tetap ada). `model_instructions_file` menggantikan prompt bawaan, jadi tidak dipakai. Codex membaca `AGENTS.md`, bukan `CLAUDE.md`; prompt role menyuruhnya membaca keduanya. |
| MCP per sesi | `-c 'mcp_servers.kantor={command=..,args=[..],env={..},default_tools_approval_mode="approve"}'`. Tidak perlu `codex mcp add` (itu menulis ke config global). Token daemon tidak ikut di argumen; `mcp-stdio.js` membacanya dari `server.json`. |
| Slash command | `/model` (model lalu effort; `s` = hanya sesi ini, Enter = simpan sebagai default global, jadi **jangan Enter**), `/permissions`, `/compact`, `/clear`, `/new`, `/stop` (tutup terminal latar), `/exit`, `/resume`, `/status`. Konfirmasi: "Model changed to X low for this session only", "Permission selection requested: Read Only". |
| Resume | `codex resume <thread-id>`; id sama dengan `session_id` di hook dan nama berkas rollout. |
| Interrupt | Esc saat bekerja (event `Interrupt`, tidak ada `Stop`). Penanda sibuk di layar: `Working (12s • esc to interrupt)` / `Compacting context (...)`: teks "esc to interrupt" sama dengan Claude. Esc di composer kosong = "esc again to edit previous message", jadi tidak dikirim saat idle. |
| Rollout | `~/.codex/sessions/YYYY/MM/DD/rollout-<waktu>-<id>.jsonl`, JSONL `{timestamp, type, payload}`. Isi percakapan ada di `event_msg` / `item_completed` dengan `item.type`: `UserMessage`, `AgentMessage` (`phase`: commentary / final_answer), `CommandExecution` (`command`, `aggregated_output`, `exit_code`), `FileChange` (`changes{path: {type: add/update/delete, content | unified_diff}}`), `McpToolCall` (`server`, `tool`, `arguments`, `result`), `ContextCompaction`, `Reasoning`, `SubAgentActivity`. Kebijakan tiap giliran ada di `turn_context` (`approval_policy`, `approvals_reviewer`, `sandbox_policy`, `effort`) dan `thread_settings_applied`; ukuran konteks di `token_count`. |

## Yang setara 1:1

- Mulai shift (per role / per sesi), resume, task awal, kartu, worktree (folder kerja sama seperti Claude).
- Status bekerja / idle, tool yang dipakai (nama dinormalkan: `apply_patch` -> `Edit`/`Write`, `update_plan` -> `TodoWrite`, `spawn_agent` -> `Agent`), waktu, log kantor, subagent.
- Kotak masuk izin dengan **hold** (allow/deny dari web atau Ghina) dan notifikasi Ghina. Kalau tidak dijawab dalam `approvals.holdKantorSec` dilepas dan prompt biasa muncul di terminal ("jawab di terminal").
- Tab Chat: rollout dibaca menjadi item yang sama (`user`, `text`, `tool`, `result`, statistik `+N -M` untuk edit).
- Kirim teks, Hentikan, `compact`, `clear`, `exit`, `kill`, ganti model/effort/mode saat sesi berjalan.
- MCP kantor (board, wiki, notes, rapat, announce, dll.) tersedia di sesi Codex.
- Kesehatan konteks (`ctx`, `health`) dari event `token_count`.

## Yang tidak setara

- **Biaya/payroll**: token sesi Codex dibaca dari rollout (`server/codexusage.js`, event `token_usage_record`) ke tabel `usage` yang sama, tapi biaya selalu 0 karena langganan ChatGPT tidak ditagih per token.
- **Kunci mode saat start**: mode bawaan kantor (`defaultPermissionMode`) khusus Claude. Codex memakai `codex.defaultMode` di `config.json` (bawaan `default`).
- **Hentikan saat izin tertahan**: Claude berhenti lewat `interrupt:true` di balasan hook; Codex menolak field itu, jadi izin ditolak lalu Esc dikirim.
- **Notification** (idle_prompt, elicitation) tidak ada; status idle datang dari `Stop`/`Interrupt`.
- **Pindahkan dari Terminal ke kantor** (`adopt`) hanya untuk Claude.
- **Rapat**: role Codex ikut lewat `codex exec --json` (sandbox read-only, persona sebagai developer instructions, tanpa MCP kantor); biaya 0. Tool tidak bisa dimatikan total di giliran tanpa tool, hanya diminta lewat instruksi.
- **AskUserQuestion**: Codex belum punya padanan yang bisa dijawab lewat hook (`request_user_input` masih dalam pengembangan).
- Ganti model lewat daftar `/model` Claude (`model/open`, `model/select`) ditolak untuk sesi Codex; pakai `codex/settings`.
- Mode `plan`, `acceptEdits`, `dontAsk` tidak ada di Codex. Dari manager (`shift_start`): `plan` -> `readOnly`, lainnya -> `default`.

## Cara kerja di Kantor

`startShift` (server/tmux.js) memilih mesin: `engine` dari permintaan mulai shift, kalau kosong dari role. Untuk Codex ia menulis skrip peluncur privat `~/.kantor-claude/run/<sid>.codex.sh` (prompt role yang panjang tidak muncul di `ps` atau baris perintah tmux), lalu membuka tmux `kc-<kantor>-<role>` seperti Claude, di folder ruangan role.

Argumen (server/codex.js `codexArgs`):

```
codex [resume <id>] --dangerously-bypass-hook-trust
  -c 'projects={"<folder>"={trust_level="trusted"}}'
  -m <model> -c model_reasoning_effort="<effort>"
  <argumen mode>                         (tabel di bawah)
  -c developer_instructions="<prompt role>"
  -c 'mcp_servers.kantor={...}'
  -c 'hooks.<Event>=[{hooks=[{type="command",command="node .../hooks/kantor-hook.cjs",timeout=N}]}]'   (12 event)
  [-- "<tugas pertama>"]
```

Lingkungan: `KANTOR_SID`, `KANTOR_ENGINE=codex`, `KANTOR_HOME` (bila ada). `hooks/kantor-hook.cjs` yang sama dengan Claude meneruskan event ke `/api/hook` dengan `kantor_engine: "codex"`.

Id sesi: Codex memakai id thread-nya sendiri. Event pertama membawa `KANTOR_SID`, dan daemon memindahkan shift ke id Codex (mekanisme `inheritShift` yang sama dengan `/clear` di Claude), jadi `sid` di API berubah satu kali setelah prompt pertama dan sama dengan id untuk `codex resume`.

| Mode (API) | Menu Codex | Argumen |
|---|---|---|
| `default` | Ask for approval | `--sandbox workspace-write --ask-for-approval on-request` |
| `auto` | Approve for me | `--approve-for-me` |
| `readOnly` | Read Only | `--sandbox read-only --ask-for-approval on-request` |
| `bypassPermissions` | Full Access | `--dangerously-bypass-approvals-and-sandbox` |

Hanya `~/.codex/config.toml` yang **tidak pernah ditulis**: hook, MCP, trust, model, effort, mode, dan instruksi semuanya lewat argumen sesi. Ganti model/effort memakai `s` (hanya sesi ini), bukan Enter.

Peringatan keamanan: `--dangerously-bypass-hook-trust` menjalankan **semua** hook yang aktif di sesi itu tanpa review, termasuk hook dari plugin Codex yang terpasang. Kantor hanya memakainya untuk shift yang ia mulai sendiri. Folder ruangan ditandai trusted untuk sesi itu saja, jadi konfigurasi `.codex/` di repo ikut aktif; pakai hanya untuk repo milikmu.

## API

Role (`GET/POST/PATCH /api/offices/:id/roles`): tambahan `engine` (`claude` | `codex`) dan `effort`. Untuk role Codex, `model` adalah slug Codex (kosong = bawaan dari config Codex).

Sesi (`serialize`, event `session`): tambahan `engine` dan `effort`. `permMode` berisi `default|auto|readOnly|bypassPermissions` untuk Codex (dibaca dari rollout, karena hook selalu melaporkan `default`). `model` berisi slug Codex.

```
POST /api/offices/:id/roles/:rid/start
  {task?, cardId?, worktree?, resumeSid?, permissionMode?, engine?, model?, effort?}
GET  /api/codex/models
  -> {available, source: 'codex'|'config'|'none', default: {model, effort},
      models: [{slug, name, desc, defaultEffort, efforts: [{effort, desc}]}],
      modes: ['default','auto','readOnly','bypassPermissions']}
POST /api/sessions/:sid/codex/settings    {model?, effort?, mode?}   (sesi harus idle)
  -> {ok, model, effort, mode}
POST /api/sessions/:sid/mode              {mode}   (juga untuk Codex: lewat menu /permissions)
```

`codex/settings` membuka `/model` atau `/permissions` di pane, mencari baris berdasarkan teks (bukan nomor urut), memilih, lalu membaca hasilnya (konfirmasi "Model changed to ..." atau menu `(current)`). Gagal dengan 409 bila agen sedang bekerja atau menunggu izin di terminal. `GET /api/codex/models` membaca `codex debug models` (cache 10 menit); bila tidak bisa dibaca, `models` kosong dan klien memakai isian bebas dengan `default`.

Aksi sesi (`/api/sessions/:sid/action`): `text`, `esc`, `stop-all` (Esc + `/stop` untuk terminal latar), `compact`, `clear`, `exit`, `kill`, sama seperti Claude.

Transcript (`GET /api/sessions/:sid/transcript`) mengenali rollout Codex dari baris pertamanya (`session_meta`).

## Uji

`test/codex.test.js`: argumen CLI per mode, hook per sesi, parser layar dan rollout, pemetaan hook, serta penggerak menu terhadap TUI tiruan di tmux. Uji nyata dengan Codex asli dijalankan di daemon demo dan tmux terpisah (lihat laporan pengerjaan).
