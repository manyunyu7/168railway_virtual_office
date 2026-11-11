# Multi-PC: agen di beberapa Mac, satu kantor

Satu daemon kantor (**hub**) mengendalikan agen yang jalan di Mac lain (**mesin**). Kamu membuka satu kantor;
ruangan FE bisa ada di Mac 1 dan ruangan BE di Mac 2, dan agen keduanya saling `pesan_ke`, berbagi board, wiki, dan kunci.

## Arsitektur

```
Mac 1 (hub: daemon kantor)                        Mac 2 (mesin "mac-studio")
┌──────────────────────────────┐   ssh (Tailscale) ┌───────────────────────────────┐
│ UI, DB, board, wiki, pesan,   │──────────────────►│ tmux  ─ claude / codex         │
│ kunci, audit                  │  tmux, cat, tail, │ ~/.kantor-node/                │
│ server/machines.js (transport)│  stat, git, ls    │   hooks/kantor-hook.cjs        │
│ ~/.kantor-claude/mirror/<id>/ │                   │   hooks/kantor-statusline.cjs  │
│   salinan transkrip Mac 2     │◄──────────────────│   server/mcp-stdio.js          │
└──────────────────────────────┘  HTTP hook + MCP  │   run/<sid>.{prompt,mcp,...}   │
                                   (token mesin)    └───────────────────────────────┘
```

- **Transport = SSH** dengan ControlMaster (`server/machines.js`). Semua kontrol tmux di kode ini sinkron; lewat SSH
  `tmux(args)` tetap sinkron, jadi pemanggilnya tidak perlu diubah. Tailscale membuat kedua Mac saling terjangkau
  walau pindah jaringan. Mac 2 hanya perlu Remote Login (atau Tailscale SSH), tmux, node, dan claude/codex. Tidak ada daemon di Mac 2.
- **Hook dan MCP** di Mac 2 mengirim ke `hubUrl` dengan **token mesin** (bukan token utama). Token mesin hanya boleh
  memanggil `POST /api/hook`, `/api/agent/*`, dan `POST /api/usage/limits/claude`.
- **Transkrip** Mac 2 dicerminkan byte demi byte ke `~/.kantor-claude/mirror/<mesin>/<path asli>`. `s.transcript`
  menunjuk ke salinan lokal itu, jadi semua pembaca transkrip yang ada (chat, kesehatan, konteks, payroll) jalan tanpa diubah.
- **Transport `local:`**: `ssh: 'local:'` menjalankan perintah di Mac ini lewat `/bin/sh` tapi melewati jalur kode remote.
  Dipakai di tes dan untuk mencoba fitur di satu Mac.

## Istilah

`s.host` sudah dipakai (aplikasi terminal: `vscode`, …). Konsep baru ini bernama **machine** (UI: "Mesin").
`'local'` atau `null` = Mac tempat hub jalan.

## Kontrak (dipegang semua modul)

### `server/machines.js` (sudah ada)
- `getMachine(id)` (dengan token) · `isRemote(id)` · `isOffline(id)` · `listMachines()` / `publicMachine(m)` (tanpa token)
- `addMachine({name, ssh, hubUrl, root?})` · `updateMachine(id, patch)` · `removeMachine(id)` (disimpan di `config.json` → `machines`)
- `machineForToken(tok)` → id | null
- `execSync(id, cmd, args, opts)` · `shSync(id, line, opts)` · `execAsync` / `shAsync` → `{stdout, stderr, code}` (tidak reject)
- `spawnArgs(id, cmd, args)` → `{file, args}` untuk `pty.spawn` (ssh -t)
- `writeFile(id, file, content, mode)` · `statFile(id, file)` · `readFrom(id, file, offset, max)` · `readFromAsync`
- `machineRoot(id)` (bawaan `~/.kantor-node`) · `machineRunDir(id)` · `mirrorPath(id, remoteFile)` · `remoteOfMirror(localFile)`
- `probeSync(id)` → `{ok, home, os, bins:{tmux,node,claude,codex,agy,git}, latencyMs, error?}` · `ensureProbed(id)`
- `setTmuxMachine(name, id)` · `tmuxMachineOf(name)` · `remoteTmuxSessions(id)` (null = tak terjangkau, **jangan anggap kosong**)
- `events` ('machine' → publicMachine) · `startMachineWatch(sec)` · `q(s)` (kutip shell)

### tmux (sudah ada di `server/tmux.js`)
- `tmux(args, {machine?})` memilih mesin dari `-t <nama>` lewat `tmuxMachineOf`. Perintah tanpa `-t` (new-session,
  set-buffer, list-sessions) harus memberi `{machine}`. `hasTmux`, `capture`, `sendKeys`, `sendText`, `paneModeAsync` ikut ter-route.
- `expectSession({..., machine})` mendaftarkan nama tmux ke mesinnya. `restoreFromDb` juga.
- `reapGoneTmux` dan `adoptRunning` melewati sesi remote. Sesi remote diurus `adoptRemote(machineId)` (agen 1).
  **Aturan keras: sesi di mesin offline tidak pernah diakhiri.** Sesi itu ditandai `machineOffline`.

### Sesi
- Kolom DB `sessions.machine` (null = lokal). `serialize(s)` menambah `machine` dan `machineOffline`.
- Payload hook: field `kantor_machine` diisi **server** dari identitas token (`/api/hook`). Nilai dari body dibuang.

### Ruangan (agen 3, `server/offices.js`)
- Ruangan tambahan (`meta.extraRooms`) boleh punya `machine` (id mesin) dan `remotePath` (path absolut di mesin itu); `path` = null.
- Ekspor `roomCwd(model, room)` → `{ machine, cwd }`, dan `roomForRemote(machine, cwd)` → `{ office, room } | null`
  (folder terdalam yang cocok menang).
- `POST /api/offices/:id/rooms` menerima tambahan `{ machine, remotePath }`. Foldernya dicek lewat `test -d` di mesin itu.

### Ringkasan per kantor
- `GET /api/state` → `offices[].machines?: [{ id: 'local'|<mesin>, rooms }]` (ruangan berfolder per mesin, terbanyak dulu). Tidak ada = semuanya di Mac ini; UI memberi lencana hanya bila ada mesin lain.
- Kantor baru dari wizard di mesin lain: root di hub = placeholder `DATA_DIR/remote-roots/<id>`, hasil scan folder di mesin itu disimpan di meta `remoteRoot` `{machine, root, scan}` dan dipakai officeModel (tidak di-scan ulang otomatis; repo baru → Tambah ruangan).
- Ruangan hasil scan bisa dipindah ke mesin lain (atau kembali) lewat `PATCH /api/offices/:id/rooms/:rid {machine, remotePath}` / `{machine: null}`; shift Claude yang ruangannya pindah bisa di-resume di sana (transkrip dibawa).

### Cermin transkrip (agen 4, `server/mirror.js`)
- `mirrorTranscript(machine, remoteFile)` → path lokal (sinkron). Mendaftarkan file untuk ditarik dan langsung menarik sekali.
- `startMirror()` / `stopMirror()`: poller async (≈1 s untuk sesi aktif, mundur saat idle). `syncNow(localPath)`.
- Hanya menarik byte yang ditambahkan (`tail -c +N`). Kalau file remote mengecil, salinan dibuat ulang.

### Auth (agen 2)
- `identify()`: Bearer = token mesin → `{ kind: 'machine', machine: id, ip }`. Berlaku di mode tunggal dan mode akun,
  dari alamat mana pun, **hanya** untuk rute di atas. Rute lain 403.
- `allowedHosts()` ikut menerima host dari setiap `machines[].hubUrl`.
- Hub harus listen di alamat yang bisa dijangkau Mac 2: `extraHosts: ['100.x.y.z']` (IP Tailscale) di config.

### Skrip di Mac 2 (agen 2), tanpa dependensi npm
- `hooks/kantor-hook.cjs`, `hooks/kantor-statusline.cjs`, `server/mcp-stdio.js`: kalau env `KANTOR_URL` dan
  `KANTOR_TOKEN` ada, pakai itu (http atau https) dan lewati cek pid `server.json`. Perilaku lokal tidak berubah.

### Peluncuran di mesin (agen 1)
- Ruangan role remote → `startShift` jalan di mesin itu: file prompt/mcp/settings ditulis ke `machineRunDir(id)`
  dengan `writeFile`. Perintahnya memakai bin remote (`probeSync().bins`). Env pane: `KANTOR_SID`, `KANTOR_URL=hubUrl`,
  `KANTOR_TOKEN=<token mesin>`, `KANTOR_MACHINE=<id>`. Hook dan statusline lewat `--settings` (menunjuk ke `<root>/hooks/...`),
  MCP lewat `--mcp-config` (`<remote node> <root>/server/mcp-stdio.js`).
- Mesin offline → `startShift` gagal dengan pesan jelas. Antigravity di mesin lain belum didukung (pesan jelas).

### API mesin (agen 6, `server/machines-api.js`), admin saja di mode akun
| Metode | Rute | Hasil |
|---|---|---|
| GET | `/api/machines` | `{ machines: [publicMachine] }` |
| POST | `/api/machines` `{name, ssh, hubUrl, root?}` | `{ machine }` |
| PATCH | `/api/machines/:id` `{name?, ssh?, hubUrl?, root?, disabled?, rotateToken?}` | `{ machine }` |
| DELETE | `/api/machines/:id` | `{ ok }`; ditolak kalau masih ada sesi hidup atau ruangan di mesin itu |
| POST | `/api/machines/:id/test` | `{ ok, latencyMs, os, home, bins, hubReachable, installed: {version, current}, problems: [teks] }` |
| POST | `/api/machines/:id/install` | `{ ok, version, root }`: salin skrip ke `<root>`, tulis `VERSION` |
| GET | `/api/machines/:id/browse?dir=<abs>` | `{ dir, parent, entries: [{ name, path, git }] }` (folder saja) |

Event WebSocket: `{ t: 'machine', machine: publicMachine }`. Saat mesin kembali online: `adoptRemote(id)` dan pengiriman pesan tertunda.

## Batas versi pertama
- Sesi manual (Terminal/VS Code) di Mac 2 tidak diadopsi; yang didukung adalah shift dari kantor.
- `tangkap_layar target=layar` untuk sesi remote mengambil layar Mac 2 (`screencapture` lewat ssh).
- Musik, sysmon, dan "Performa PC" tetap untuk Mac hub.

## Menyiapkan Mac kedua
1. Pasang Tailscale di kedua Mac dan login ke tailnet yang sama.
2. Di Mac 2: Pengaturan Sistem → Umum → Berbagi → **Remote Login** nyala. Pasang `tmux`, `node` (≥ 22), dan
   `claude` (sudah login) atau `codex`. Tambahkan public key hub (`~/.ssh/id_ed25519.pub` di hub) ke `~/.ssh/authorized_keys` Mac 2.
3. Di hub: `ssh <user>@<mac2>.ts.net true` sekali untuk menerima host key. Kantor memakai `BatchMode=yes`,
   jadi tidak pernah menanyakan password atau host key; tanpa langkah ini Tes gagal.
4. Di hub: config `extraHosts` berisi IP Tailscale hub (`tailscale ip -4`), lalu daemon dimulai ulang. Tanpa ini Mac 2 tidak bisa
   mengirim hook ke hub.
5. Di kantor: Pengaturan → **Mesin** → Tambah (nama, alamat SSH, URL hub mis. `http://<hub>.ts.net:4317`) → **Tes** → **Pasang**.
   Dari terminal juga bisa: `kantor mesin tambah mac-studio henry@mac-studio.ts.net http://macbook-air.ts.net:4317`,
   lalu `kantor mesin tes mac-studio` dan `kantor mesin pasang mac-studio`.
6. Tambah ruangan → pilih mesin → pilih folder repo di Mac 2. Role yang ruangannya di situ akan shift di Mac 2.

**Tes** memeriksa: SSH (dengan PATH dari shell login, jadi bin Homebrew ketemu), `tmux`, `node` ≥ 22, `claude` atau `codex`,
apakah skrip kantor sudah terpasang dengan versi yang sama dengan hub, dan apakah Mac 2 bisa menjangkau URL hub
(`curl` dari Mac 2 ke `<hubUrl>/`; 403 berarti host itu belum ada di `extraHosts`). Setiap masalah ditulis dengan langkah perbaikannya.

**Pasang** menyalin `hooks/kantor-hook.cjs`, `hooks/kantor-statusline.cjs`, `server/mcp-stdio.js` (plus file lokal yang
mereka require) ke root mesin (bawaan `~/.kantor-node`), menulis `package.json` (`type: module`) dan `VERSION` (hash isi skrip).
Setelah kantor diperbarui, Tes akan bilang "versi lama": tekan Pasang lagi. Hook langsung memakai skrip baru; MCP shift yang sedang jalan tetap versi lama sampai shift dimulai ulang.

Mesin tidak bisa dihapus selama masih ada sesi hidup atau ruangan yang memakainya. **Putar token** (PATCH `rotateToken`)
membuat token lama langsung ditolak, termasuk oleh shift yang sedang jalan di mesin itu; mulai ulang shift-nya sesudahnya.
