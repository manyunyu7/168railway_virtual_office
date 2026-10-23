# Kontrak frontend Kantor Claude

Frontend = ES modules biasa di `web/js/`, tanpa framework dan tanpa build. Disajikan oleh daemon (`server/index.js`) di `http://127.0.0.1:4317`. Semua teks UI berbahasa Indonesia, lugas, tanpa emoji. Pakai kelas CSS yang sudah ada di `web/app.css` (lihat daftar di bawah); tambahkan CSS baru ke `web/app.css` hanya kalau benar-benar perlu, di bagian paling bawah, dengan token warna yang ada (`var(--surface)` dll, jangan warna literal kecuali untuk ilustrasi).

Referensi tampilan/UX: mockup awal (di luar repo) (board, role, arsip, terminal sudah ada contohnya di sana; versi asli harus memakai API sungguhan).

## Antarmuka modul view

Setiap modul tab (`board.js`, `roles.js`, `archive.js`, `meetings.js`, `notes.js`, `wiki.js`, `payroll.js`, `settings.js`) mengekspor:

```js
export async function render(el, ctx, route) {}   // el = elemen kosong untuk isi tab
export function live(msg, ctx) {}                 // opsional: event realtime (lihat di bawah)
export function route(r) {}                       // opsional: hash berubah tapi masih tab yang sama (mis. #/o/x/wiki/<slug>)
export function unmount() {}                      // opsional: bersihkan timer/listener
```

`route` (argumen ketiga render) = `{ name: 'office', id, tab, rest: [] }`. `rest` = sisa segmen hash, mis. `#/o/168railway/wiki/aturan-kantor` → `rest = ['aturan-kantor']`; `#/o/x/notes/n123` → `['n123']`. Untuk notes/wiki kompleks: `id = '_kompleks'` dan hash-nya `#/kompleks/notes/...`, `#/kompleks/wiki/...`. Buat link pakai helper: `const base = ctx.office.id === '_kompleks' ? '#/kompleks' : '#/o/' + ctx.office.id`.

`ctx` (dari `main.js`):
- `ctx.office` = hasil `GET /api/offices/:id` (lihat bawah); untuk `_kompleks` berupa `{ id:'_kompleks', name:'Kompleks', roles:[], sessions:[], plan:{rooms:[]}, cards:[] }`.
- `ctx.st` = hasil `GET /api/state`.
- `ctx.stage` = denah canvas (hanya di tab Kantor).
- `main.js` juga mengekspor `go(hash)`, `refreshState()`, `loadOffice(id)`, `updateSub()`.

Satu-satunya listener klik global ada di `main.js` untuk aksi umum (`data-act` = allow, deny, open-sess, open-role, close-drawer, …). Modul sebaiknya memasang listener sendiri pada elemen root-nya (`el.addEventListener('click', …)`) dan memakai nama `data-act` yang diawali prefiks modul (mis. `bd-`, `nt-`, `wk-`, `mt-`, `py-`, `rl-`, `ar-`, `st-`) supaya tidak bentrok. Drawer berada di luar `el`, jadi pasang listener di elemen drawer saat membukanya (`showDrawer` mengembalikan elemennya).

## Utilitas (`web/js/util.js`)

`$, $$, esc, short(s,n), usd(v,d), num, tok, hhmm(iso), ago(iso), dateLong(iso), MODELS, modelName, hashStr, SKINS, HAIRS, SWATCHES, guestLook(key), sprite(roleLike, px), mini(roleLike), ICON {chat,file,clock}, api(path,{method,body}), post(p,body), patch(p,body), del(p), onLive(fn), toast(msg, ''|'ok'|'warn'|'bad'), modal({title, body, html, actions:[{label, kind, fn}]}) (fn mengembalikan false = modal tetap terbuka), closeModal(), confirmDo(title, body, label, fn), md(src, {wiki: title=>bool, roles, cardIds:Set, taskIndex}), toggleTask(src, n), diffLines(a,b), debounce(fn,ms)`.

`md()` merender markdown aman: `[[Judul]]` → `<a class="wl" data-wiki="Judul">` (kelas `missing` bila `wiki(title)` falsy), `- [ ] x` → checkbox `data-task="n"`, `@nama` → `<span class="mention" data-role>`, `#k123abc` → `<a data-card>` bila id ada di `cardIds`.

Media di markdown (wiki/kartu): `![alt](/api/offices/<id>/media/<mid>)` = gambar. **Video** (mp4, webm, mov, m4v) = `![nama](/api/offices/<id>/media/<mid>.mp4)` (URL berakhiran ekstensi video, server menerima `<mid>.<ext>`) dan dirender `<figure class="md-video"><video controls preload="metadata" playsinline>` + tautan Unduh. Tautan lama `[📎 klip.mp4](…media/<mid>)` (label berekstensi video) juga jadi pemutar. Satu baris berisi tautan YouTube (watch?v=, youtu.be, shorts) jadi iframe `youtube-nocookie.com`. `POST /api/offices/:id/media?name=` mengembalikan `{id,name,mime,size,url,image,video}` (maks 500 MB). `GET …/media/:mid` mendukung `Range` (206, `Accept-Ranges: bytes`, `Content-Range`; 416 bila di luar ukuran). Agen MCP: `wiki_write` cukup menulis sintaks di atas; `attach_file` dengan `wiki` menyisipkannya otomatis.

**PDF dan dokumen** (sama polanya dengan video: URL berakhiran ekstensi, server menerima `<mid>.<ext>`). `![nama](/api/offices/<id>/media/<mid>.pdf)` jadi kartu pratinjau `<figure class="md-pdf" data-src data-name>` (halaman 1 + jumlah halaman) dengan tombol `data-pdf`; ketuk membuka penampil layar penuh (halaman bergulir, navigasi halaman, zoom, Unduh, Tab baru; pdf.js 4.4.168 dari cdnjs, jatuh ke `<iframe sandbox>` bawaan browser bila CDN tak terjangkau). `![nama](…/media/<mid>.md)` (juga `.markdown`, `.txt`) jadi kartu `<figure class="md-doc">` (judul dari heading pertama + 4 baris cuplikan); penampil merender isinya dengan `md()` yang sama (sanitasi: semua di-escape, tanpa HTML mentah, tautan hanya `http(s)`/`/api/`) dengan tombol Lihat sumber, Jadikan halaman wiki (`POST /api/offices/:id/wiki` dengan judul dari heading, `msg` "Diimpor dari …"; menyiarkan event `kantor:wiki-changed`) dan Unduh. Tautan lama `[📎 x.pdf|md|txt](…/media/<mid>)` ikut jadi kartu. Hanya URL `/api/` milik kantor yang dijadikan kartu. Respons media: unggahan kini punya `pdf` dan `doc` (boolean) selain `image`/`video`; PDF dikirim `Content-Type: application/pdf`, `Content-Disposition: inline`, tanpa CSP sandbox, dengan `Range`; md/txt tetap `attachment` + CSP sandbox (isinya diambil lewat fetch, bukan ditampilkan browser). Kode: `web/js/docs.js`, gaya di `web/css/wiki.css`. `attach_file` dan editor wiki (unggah/seret/tempel) menyisipkan sintaks ini otomatis; `wiki_write` cukup menulisnya. Ghina: `wiki/wiki_documents.dart` (pdfrx).

## Drawer (`web/js/panel.js`)

`showDrawer(html, { wide, key, close })` → elemen drawer; `closeDrawer()`; `drawerState()` → `{open, key}`; `drawerEl()`. Struktur isi yang dipakai CSS: satu baris `.dr-top` berisi `.dr-head` (+ `.dr-ava`, `.dr-id`, `.dr-name`, `.dr-title`), `.dr-tabbar` (`.dr-tabs` dengan button `aria-selected`; yang tidak muat pindah ke menu `.dr-tmore`), `.dr-tools` (kontrol terminal, hanya di tab Terminal) dan `.dr-btns` (tombol `.icon-btn`, termasuk `data-act="close-drawer"`); lalu `.dr-body` (+ `.dr-sec h3`, `dl.facts`).

## Event realtime (`onLive` / fungsi `live(msg)`)

- `{t:'session', office, session}` — status sesi berubah. `session = {sid, office, room, role, kind:'kantor'|'manual'|'rapat', worktree, cwd, status:'starting'|'working'|'idle'|'waiting'|'ended', tool:{name,label,at}|null, title, model, startedAt, lastSeen, tmux, waiting:{id,tool,summary}|null, slot, compacting, subs:[{id,type,desc,status:'working'|'done',tool,started,ended,tokens}], bgAgents (jumlah subagent berstatus working), ctx, health, errStreak, compactions}`. `main.js` sudah memperbarui `ctx.office.sessions` sebelum memanggil `live`. Subagent yang selesai tetap ada di `subs` (status `done`, `ended` ms) selama ±60 detik. `tokens` = total token giliran terakhir subagent (input + cache + output, seperti "↓ … tokens" di daftar agen Claude Code) dari `<transcript>/subagents/agent-<id>.jsonl`, `null` bila belum ada/sesi Codex; tab Chat menampilkannya sebagai panel subagent (`web/js/subagents.js`).
  - Kesehatan konteks (dibaca dari transcript sesi, diperbarui di setiap event sesi): `ctx = {used, limit, pct, at} | null` (`used` = input + cache read + cache creation pada balasan assistant terakhir; `limit` = jendela model, 200k, atau 1M bila varian `[1m]` atau pemakaian sudah melewati 200k; `pct` 0-100 satu desimal; `at` = waktu balasan itu; `null` bila transcript belum ada). `health = 'segar'` (<50%) `| 'sedang'` (50-75) `| 'lelah'` (75-90) `| 'kritis'` (>=90) `| null` (ctx kosong). `errStreak` = jumlah tool_result galat beruntun di ujung transcript (0 bila hasil terakhir sukses). `compactions` = berapa kali konteks dirangkum otomatis atau lewat /compact. Tabel jendela model ada di `server/health.js` (`WINDOWS`).
- `{t:'session-gone', office, sid}`
- `{t:'transcript', office, sid, size, switched?}` — transcript sesi bertambah (debounce ~200 ms; server memantau file transcript setiap sesi live). `size` = ukuran file dalam byte, sama dengan `size` di `GET /api/sessions/:sid/transcript`; muat ulang bila berbeda dari yang terakhir dimuat. `switched:true` = sesi pindah ke file transcript baru (sesudah /clear, /compact, atau resume): selalu muat ulang. Polling transcript cukup sebagai cadangan (~10 dtk).
- Item gambar di `GET /api/sessions/:sid/transcript`: `{k:'image', src:'gen'|'view'|'user', path, name, s?, at}`. `gen` = gambar hasil image generation Codex (`s` = prompt yang direvisi), `view` = gambar yang dilihat agen (Codex view_image, Claude Read file gambar; tampilkan kecil bersama rangkaian aksi), `user` = gambar yang ditempel pemilik di terminal Codex. Base64 tidak pernah ikut; muat lewat `GET /api/sessions/:sid/image?path=<path ter-encode>` (asli) atau `&thumb=1` (JPEG <=480 px). Hanya berkas gambar di folder kerja/kantor sesi, `~/.codex/generated_images`, atau folder temp yang dilayani; selain itu 400/404. Berkas bisa sudah hilang: sembunyikan bila gagal dimuat.
- `{t:'log', office, entry:{who,text,at,kind}}`
- `{t:'inbox', item}`, `{t:'inbox-update', id, status}`
- `{t:'changed', office, what:'board'|'notes'|'wiki'|'meetings'|'roles'|'plan'|'news'|'payroll'|'git', card?, note?, slug?, meeting?, room?}` — `office:'*'` berarti semua. Modul me-refetch datanya sendiri.
- `{t:'meeting-msg', office, meetingId, msg:{id,who,text,at,cost,kind:'bicara'|'kamu'|'sistem'}}`
- `{t:'meeting-typing', office, meeting, who, role, text, done}` — peserta rapat yang sedang giliran bicara. Dikirim saat giliran dimulai (`text:''` = sedang berpikir, belum ada token), lalu tiap ~80 ms selama teks bertambah (`text` KUMULATIF, bukan delta, jadi aman bila ada event terlewat), dan terakhir `done:true` sesudah `meeting-msg` final tersimpan. Klien mengganti gelembung live dengan pesan final (cocokkan `who` dengan `msg.who`). Hanya giliran bicara peserta yang disiarkan, bukan penyusunan notulen. `role` = id role.
- `{t:'owner', office, owner}` — karakter owner (pemilik kantor) bergerak/duduk/keluar. `owner` = bentuk yang sama dengan `GET /api/offices/:id/owner` (lihat bagian Owner di bawah). Abaikan event yang `owner.client`-nya milik klien sendiri.

## API (semua JSON, cookie auth otomatis; error → `{error}` dengan status 4xx, `api()` melempar Error berisi pesannya)

Kantor
- `GET /api/state` → `{offices:[{id,name,root,style,sessions:[{sid,role,status,title}],roles,cards:{open,blocked,done},monthCost}], inbox:[…], hooks:bool, tmux:bool, claude:bool, settings:{approvals:{holdKantorSec,holdManualSec}, roots, extraHosts, defaultPermissionMode, musicDir, ghinaNotify:{enabled,ready,events}}}` (ghinaNotify tanpa url/token)
- `GET /api/offices/:id` → `{id,name,root,style,plan:{w,h,rooms:[{id,name,kind,path,stack,md,worktrees,aliases,zoneOf,note}],…}, roles:[Role], sessions:[Session], news:[{id,text,at,author}], log:[{who,text,at,kind}], wall:[Note], cards:[{id,title,col,who,repo,blocked}]}`
- `POST /api/offices/:id/rescan`
- Git per ruangan (hanya ruangan yang foldernya repo git; ruangan lain tidak muncul)
  - `GET /api/offices/:id/git[?fresh=1]` → `{rooms:{<roomId>:{branch, upstream, dirty, untracked, ahead, behind, last:{hash,subject,at}|null, stash, prs?}}}`. `dirty` = file berubah + untracked (untracked = bagian di antaranya); `branch` = `(detached)` bila HEAD lepas; ruangan yang foldernya subfolder repo hanya menghitung isi foldernya. `prs:[{number,title,headRefName,url}]` (maks 5) hanya ada bila remote origin di GitHub dan `gh` tersedia; `null` = belum diketahui (diambil di latar belakang, lalu event `changed what:'git'`). Cache server 30 dtk (PR 5 mnt); `fresh=1` melewatinya.
  - `GET /api/offices/:id/git/:roomId/diff` → `{files:[{file,status:'M'|'A'|'D'|'R'|'?'…,untracked,from,conflict,add,del,binary?}]}` (add/del dari `git diff --numstat` terhadap HEAD; untracked dihitung dari isi file). Dengan `?file=<path dari daftar>` → `{file, diff (unified, maks 200 KB), truncated, binary?}`; path di luar daftar → 404.
  - `POST /api/offices/:id/git/:roomId/commit {message, files?:[path]}` → `{ok, hash, subject, at, files, git}`. Hanya file yang disebut yang di-commit (file baru/untracked hanya bila disebut; `files` kosong = semua file tracked yang berubah, tanpa untracked); file lain yang sudah di-stage tidak ikut. Tidak pernah push. 400 bila pesan kosong, 409 bila tidak ada perubahan, file tidak ada di daftar, atau ada konflik. Tercatat di log kantor (`kind:'git'`).
  - Event `{t:'changed', office, what:'git', room?}` dikirim setelah edit/perintah git di sebuah ruangan (ditunda ~1,5 dtk, hanya bila hasilnya berubah), setelah commit, dan saat data PR tiba; refetch `GET …/git`. `office:'*'` tidak dipakai.
- Ruangan: `GET /api/offices/:id/folders` → `[{dir,stack,used}]`; `POST /api/offices/:id/rooms {name, kind:'kode'|'meeting'|'lib'|'qa'|'server'|'pantry'|'beku'|'game'|'manager', path, create:bool, gitInit:bool}` → `{id}`; `PATCH /api/offices/:id/rooms/:rid {name?, note?, frozen?:bool, remove?:bool}` (remove hanya untuk ruangan tambahan).

Role = `{id,name,title,model:'opus'|'sonnet'|'haiku'|'fable',room,color,hair,skin,hairStyle:'short'|'long'|'bun',tie,isMgr,persona,skills:[],notes,budget,archived}`
- `GET /api/offices/:id/roles` (termasuk yang diarsipkan), `POST /api/offices/:id/roles {name,title,model,room,color,hair,skin,hairStyle,tie,persona,skills}`, `PATCH /api/offices/:id/roles/:rid {…sebagian; archived:bool; notes; budget}`
- `POST /api/offices/:id/roles/:rid/start {task?, cardId?, worktree?:bool, permissionMode?:'default'|'acceptEdits'|'auto'|'plan', resumeSid?}` → `{sid,tmux,slot}`. Role boleh punya beberapa sesi paralel (slot 0,1,2…). `worktree:true` membuat git worktree terpisah untuk slot > 0.

Sesi
- `POST /api/sessions/:sid/action {action:'esc'|'stop-all'|'compact'|'clear'|'exit'|'kill'|'text', text?}` (hanya sesi tmux kantor). `stop-all` (alias `kill-agents`): Esc bila agen utama sibuk, lalu Ctrl+X Ctrl+K dua kali bila ada subagent latar (efek samping: auto-reply artifact mati untuk sisa sesi); butuh ~4 dtk; respons `{ok, via, stoppedMain, agentsBefore, agentsAfter}`
- `GET /api/sessions/:sid/peek` → `{text}` (isi layar tmux)
- Terminal: WebSocket `/ws/term?kind=session&sid=…&cols=&rows=` atau `/ws/term?kind=shell&office=…&room=…&cols=&rows=`. Server mengirim teks terminal mentah; klien mengirim ketikan mentah; resize dikirim sebagai string `'\x00' + JSON.stringify({cols, rows})`. xterm.js tersedia global: `window.Terminal`, `window.FitAddon.FitAddon`.
- `GET /api/offices/:id/archive` → `[{sid,role,room,title,first_prompt,started_at,ended_at,last_seen,source,tmux,cost,output,active}]`

Kotak masuk: `GET /api/inbox`, `POST /api/inbox/:iid {behavior:'allow'|'deny', message?}`

Board: beberapa papan per kantor, kolom per papan
- Kantor punya N papan (`boards`): `Board = {id, name, icon, color, template:'dev'|'kreatif'|'custom', columns:[{id,name,kind}], ord, archived, rooms:[roomId], roles:[roleId], isDefault}`. Papan `utama` (Utama, template Dev) selalu ada, tidak bisa dihapus/diarsipkan; semua kartu lama dimigrasi ke sana (migrasi office db: `cards.board`, `cards.kind`, `cards.publish_at`, tabel `boards` dan `card_moves`; aman diulang, tidak menghapus data).
- Jenis kolom (`kind`): `antre | siap | dikerjakan | review | selesai`. Tiap papan minimal satu kolom `selesai`. SEMUA logika memakai jenis, bukan nomor kolom: selesai (metrik, dependensi, kurir magang, sub-kartu epic, autopilot), WIP, warna Gantt, tunggu_kerja (`kartu_masuk` = antre/siap, `review_diminta` = review), pratinjau.
- Template: Dev = Backlog(antre) → Siap(siap) → Dikerjakan(dikerjakan) → Review(review) → Selesai(selesai). Kreatif = Brief(antre) → Konsep(dikerjakan) → Produksi(dikerjakan) → Review(review) → Revisi(dikerjakan) → Final(selesai) → Tayang(selesai) → Arsip(selesai). Bebas diubah setelah dibuat.
- `GET /api/offices/:id/boards` → `{boards:[Board], kinds:[…], kindLabels:{…}, templates:[{id,name,icon,color,columns}]}`
- `POST /api/offices/:id/boards {name?, template?, columns?, color?, icon?, rooms?, roles?}` → Board (nama unik di antara papan aktif; tanpa nama = nama template)
- `PATCH /api/offices/:id/boards/:bid {name?, icon?, color?, rooms?, roles?, ord?, archived?, columns?, moveTo?}` → Board. `columns` = daftar lengkap urutan baru; kolom lama dikenali dari `id` (rename/ganti jenis/urut ulang memindah kartu ikut kolomnya). Kolom yang dibuang dan masih berisi kartu ditolak kecuali `moveTo` = `{idKolomLama: idKolomBaru}` atau satu id untuk semua. `POST /api/offices/:id/boards-order {ids}`.
- `DELETE /api/offices/:id/boards/:bid?moveTo=utama` → arsipkan papan; kartunya pindah ke papan tujuan, kolomnya lewat jenis.
- `GET /api/offices/:id/board?board=<id|nama|all>&moves=1` → `{board:Board|null, boards:[Board], cols:[nama kolom], columns:[{id,name,kind}], cards:[Card], labels, moves?:{idKartu:[{at,board,toCol,toKind,toName}]}}`. **Tanpa `board` = papan Utama** (perilaku lama persis; `cols` = nama kolom Utama). `all` = kartu semua papan (`board:null`, `cols`/`columns` = milik Utama).
- `Card` = `{id,title,desc,board,boardName,col,colName,colKind,stage,done,who,repo,prio:'P0'..'P3',due,start,estDays,progress,labels,milestone,publishAt,cover,coverUrl,blocked,epic,epicId,deps,createdAt,updatedAt,movedBy,movedAt,ord,checks:{total,done},comments:n,attachments:n}`.
  - `col` = indeks kolom di papan kartu itu. `colKind` = jenis kolomnya, `done` = `colKind === 'selesai'`.
  - **Kompatibilitas angka `col`**: di papan Utama (Dev) `col` 0..4 tetap Backlog..Selesai. Klien lama tanpa `board` hanya melihat Utama, jadi tidak berubah. `stage` = nomor kolom lama menurut jenis (antre 0, siap 1, dikerjakan 2, review 3, selesai 4) untuk tampilan 5 kolom di papan mana pun (dipakai papan tulis kantor dan mode Semua papan). Input `col` boleh angka (indeks di papan, dijepit), nama/id kolom, jenis (`'review'`), atau nama kolom lama (`'Selesai'`, `'Dikerjakan'`…) yang dipetakan ke kolom pertama berjenis itu (jenis yang tidak ada di papan: jenis terdekat).
  - `publishAt` = tanggal tayang `YYYY-MM-DD` (kosong = tidak ada). `cover` = id media lampiran, atau `pv:<idPratinjau>:<idBerkas>` (berkas gambar/video pratinjau); `coverUrl` = URL siap pakai (`/api/offices/…/media/<id>` atau gambar kecil bertanda tangan `/pvt/…`).
- `GET /api/offices/:id/cards/:cid` → kartu + `checklist:[{id,text,done}], comments, history, links, children:[{id,title,col,colName,colKind,done,board,repo,who}], deps/blocks:[{id,title,col,colName,colKind,done,board}], moves:[{board,fromCol,toCol,fromKind,toKind,fromName,toName,by,at}], attachments`
- `POST /api/offices/:id/cards {title,board?,col,desc,who,repo,prio,due,start,publishAt,cover,checklist:[str],epicId,deps,labels,milestone}` (tanpa board: papan epic induk, lalu Utama); `PATCH /api/offices/:id/cards/:cid {title,desc,board,col,who,repo,prio,due,start,publishAt,cover,blocked,epicId,ord,deps,labels,milestone,estDays,progress}`. `board` memindah kartu ke papan lain; tanpa `col` kolomnya = kolom pertama berjenis sama. Dependensi lintas papan boleh. `DELETE /api/offices/:id/cards/:cid`
- Pratinjau yang punya `kartu`: disetujui semua → kartu yang sedang di kolom berjenis review pindah ke kolom `selesai` pertama; minta revisi → pindah ke kolom bernama "Revisi" (kalau ada) atau kolom `dikerjakan` pertama; keduanya menambah komentar berisi catatan pemilik.
- Event realtime: `{t:'changed', what:'board', card?, from?:{col,kind,board,who}, boards?:true}` (boards = daftar/kolom papan berubah).
- Web: pemilih papan di tab Board (diingat per kantor di `localStorage kc.board.sel.<kantor>`, dipakai juga Timeline), "Semua papan" = 5 kolom menurut jenis. Tab Timeline: pemilih papan, kartu papan lain yang jadi dependensi tampil sebagai bar abu-abu samar, Semua papan dikelompokkan per papan dulu, segmen tahap dari `moves`, ◆ tanggal tayang. Tab Kalender (`web/js/calendar.js`): kartu menurut `publishAt` (kalau kosong `due`), seret untuk menjadwalkan ulang.
- `POST …/cards/:cid/check {text?, itemId?, index?, done?, remove?}` (tanpa item yang cocok + text → menambah item)
- `POST …/cards/:cid/comment {text, notify:bool}` (notify = teruskan juga ke sesi tmux role yang ditugaskan bila sedang jalan)
- `POST …/cards/:cid/split {parts?:[str]}` (tanpa parts = item checklist yang belum dicentang jadi sub-kartu; kartu jadi epic)

Notes (catatan umum)
- `GET /api/offices/:id/notes?q=&tag=&view=aktif|arsip|sampah` → `{notes:[{id,title,body,color:'kuning'|'hijau'|'biru'|'merah'|'ungu'|'abu',tags:[],pinned,wall,archived,deleted,room,author,createdAt,updatedAt}], tags:[{tag,n}]}`
- `POST /api/offices/:id/notes {id?, title, body, color, tags, pinned, wall, archived, deleted, room}` (tanpa id = buat baru; dengan id = ubah sebagian) → note
- `DELETE /api/offices/:id/notes/:nid` (hapus permanen, hanya dari sampah)
- `POST …/notes/:nid/to-card {mode:'one'|'each', who?, repo?}` → `{cards:[id]}` (`one` = satu kartu, checklist dari `- [ ]`; `each` = tiap item belum dicentang jadi kartu)
- `POST …/notes/:nid/send-role {role, live:bool}` → `{ok, live}` (menambah ke buku catatan role; `live` = kirim juga ke sesi yang sedang jalan)
- Warna catatan di CSS: `var(--n-kuning)` dst.

Wiki
- `GET /api/offices/:id/wiki` → `[{slug,title,author,updated_at}]`
- `GET /api/offices/:id/wiki/page?ref=<slug atau judul>` → `{slug,title,body,author,createdAt,updatedAt,backlinks:[{slug,title}],revs}` atau `null`
- `POST /api/offices/:id/wiki {title, body, msg, prevSlug?}` (prevSlug untuk ganti judul/alamat) → page
- `DELETE /api/offices/:id/wiki/:slug`
- `GET /api/offices/:id/wiki-search?q=` → `[{slug,title,score,snippet}]`
- `GET /api/offices/:id/wiki-revs/:slug` → `[{id,title,author,at,msg,size}]`; `GET /api/offices/:id/wiki-rev/:rid` → `{id,slug,title,body,author,at,msg}`
- `GET /api/offices/:id/wiki-sources` → `[{kind:'claude-md'|'memory', label, file, size}]` (sumber hanya-baca); `GET /api/offices/:id/wiki-source?file=` → `{text}`

Rapat
- `GET /api/offices/:id/meetings` → `[{id,topic,status:'berjalan'|'selesai'|'gagal',participants:[roleId],chair,created_at,ended_at,cost}]`
- `GET /api/offices/:id/meetings/:mid` → `{…, agenda, rounds, summary, decisions:[str], actions:[{title,who,prio,detail,card}], wiki_slug, error, messages:[{id,who,text,at,cost,kind}], running, typing}`; `typing` = `{who,role,text}` bila ada peserta yang sedang bicara (teks parsial sampai saat ini), selain itu `null` (untuk klien yang membuka rapat di tengah ucapan)
- `POST /api/offices/:id/meetings {topic, agenda, participants:[roleId] (min 2), rounds:1-4, chair}`; `POST /api/offices/:id/meetings-cancel`; `POST …/meetings/:mid/say {text}` (menyela saat berjalan); `POST …/meetings/:mid/action {index: n | 'all'}` (tindak lanjut → kartu)
- Rapat memakai `claude -p` per giliran; biaya nyata, jadi form harus menyebut perkiraan jumlah giliran (peserta × ronde + 1 notulen).

Payroll (biaya = estimasi setara harga API dari transcript, bukan tagihan langganan)
- `GET /api/payroll?office=&month=YYYY-MM` (tanpa office = semua kantor) → `{month, months:[…], total:{cost,input,output,cache_w,cache_r,msgs,sessions}, byRole:[{role,cost,output,input,sessions}], byModel:[{model,label,cost,output}], byDay:[{day,cost}] (30 hari terakhir), bySession:[{sid,role,cost,output,first,last,title,first_prompt,room,source}], byOffice:[{office,cost,sessions}], budget:number|null, scan:{running,files,done,lastRun,error}}`
- `POST /api/offices/:id/budget {usd}`; `POST /api/payroll/rescan`
- `GET /api/offices/:id/metrics?range=today|night|24h|7d|custom&from=&to=&stuck=<jam>` (`:id` = `_kompleks` atau `GET /api/metrics` untuk semua kantor) → `{range:{key,label,from,to,bucket:'hour'|'day'}, series:{starts,created,done,commits,dm}, cards:{created,done,started,cycle:{n,avgH,medianH,p90H,minH,maxH},review:{entries,bounces,bouncedCards},stuck:{hours,count,cards:[…]},board}, dm:{total,pesan,tanya,balasan,deliver:{n,avgSec,p90Sec,maxSec,medianSec},reply,slow1,slow5,askTimeout,perRole:[…],waitingNow}, sessions:{perRole:[{role,name,workSec,idleSec,waitSec,compactions,interrupts,…}],totals,compactions,interrupts,permissions:{total,byStatus,toTerminal,…}}, cost:{days,total,perDoneCard,perCommit,tokenOnlyTokens,perRole}, git:{total,reverts,kinds,perRepo}, friction:{toolErrors:{total,byTool:[{tool,n,reasons}]},announcements,rules}}`. Biaya dibulatkan ke hari penuh; jam kerja diperkirakan dari log aktivitas.
- `GET /api/offices/:id/metrics/report?…` (parameter sama) → `{markdown}`: laporan shift untuk postmortem.

Pengaturan
- `POST /api/settings {approvals:{holdKantorSec, holdManualSec}}`
- `GET /api/settings/tabs` -> `{order:[ids]|null}`; `PUT /api/settings/tabs {order:[ids]|null}` simpan urutan tab kantor global (config.json `tabOrder`). Id: `^[a-z][a-z0-9-]{0,31}$`, maks 64, duplikat dibuang; `null` = bawaan (kantor, wiki, lalu sisanya). Klien menggabungkan dengan `mergeOrder` (web/js/tab-order.js): id yang tidak dikenal diabaikan, tab baru disisipkan di posisi bawaannya.
- `POST /api/hooks/install`, `POST /api/hooks/uninstall` (mengubah `~/.claude/settings.json`, cadangan otomatis)

## Owner: karakter pemilik di denah

Pemilik kantor bisa "masuk kantor" sebagai karakter (mahkota kecil, nama **Kamu**, lencana OWNER). Posisi per kantor disimpan di memori daemon; tampilan (look) global di DB global (`kv` kunci `owner.look`). Web: `web/js/owner.js` (dipasang oleh `office-canvas.js` di stage tab Kantor), CSS `web/css/owner.css`.

- `GET /api/offices/:id/owner` → `{x, y, face, room, pose, fx, present, client, at, look}`
  - `x, y` = koordinat **tile** (boleh pecahan saat berjalan; bilangan bulat = tengah tile; titik kaki karakter = `x*8+4, y*8+7` px). `null` bila owner belum pernah masuk.
  - `face` = `up|down|left|right`; `room` = id ruangan di bawah kaki (atau `null` di koridor); `pose` = `stand|sit|sleep|pray|play|exercise|read|null` (null = berdiri/jalan biasa); `fx` = affordance yang sedang dipakai (`coffee`, `water`, `snack`, `sofa`, `wudhu`, `pray`, …) atau `null` — dipakai renderer untuk properti (cangkir, tetes wudhu, buku).
  - `present` = owner sedang di kantor. Otomatis `false` bila tidak ada `PUT` selama **2 menit** (klien mengirim heartbeat tiap 30 dtk selama tab terbuka); saat itu daemon mengirim satu event `owner` dengan `present:false`.
  - `client` = id klien yang terakhir mengendalikan (string bebas ≤64, mis. `web-xxxx`, `ghina-android`). Klien lain menggambar owner dari event; bila `present:true` datang dari `client` lain saat klien ini sedang mengendalikan, klien ini melepas kendali (owner "pindah" ke perangkat itu).
  - `look` = `{color, hair, skin, hairStyle, outfit, acc, hijab, crown:true}` — kosakata sama dengan role (`hairStyle: short|long|ponytail|bob|bun|pigtails|curly|hijab`, `outfit: kemeja|rok|dress|hoodie|jas`, `acc: ''|kacamata|anting|topi`, warna `#rrggbb`, `hijab` warna atau null). `crown` selalu true (penanda owner).
- `PUT /api/offices/:id/owner {x?, y?, face?, room?, pose?, fx?, present?, client?, look?}` → bentuk GET. Field yang tidak dikirim tetap. `present:true` butuh `x,y` (sekarang atau sebelumnya). `present:false` mengosongkan `pose/fx`. `look` (parsial) disimpan global. 400 bila nilai tidak valid, 404 bila kantor tidak ada. Setiap PUT mengirim event `{t:'owner', office, owner}`.
  - Klien web: kirim maks ~4×/dtk saat bergerak (`SEND_MS` 250), heartbeat 30 dtk saat diam, `present:false` saat tombol Keluar atau halaman ditutup (`fetch keepalive`). Pindah tab di dalam kantor (Board/Wiki/Rapat) tidak mengirim `present:false`; kembali ke tab Kantor dalam 2 menit melanjutkan dari posisi yang sama.
- `GET /api/owner/look` → look; `PUT /api/owner/look {…look parsial}` → look tersimpan.

Perilaku di denah (web; Ghina native sebaiknya menyamakan):
- Masuk lewat lift; jalan per tile dengan WASD/panah (tabrakan = walk grid), klik/ketuk lantai = A*, joystick virtual di layar sentuh; kamera mengikuti (tombol Ikuti / F; menggeser denah mematikannya).
- Bar aksi muncul untuk benda/agen terdekat (E/Enter = aksi pertama, 1–9 = aksi ke-n, Q = ganti target bila lebih dari satu, Esc = berdiri/kembali). Perabot katalog sesuai affordance: `sit/sofa` duduk, `coffee/water/snack/eat` berdiri memegang cangkir, `wudhu` lalu otomatis ke `pray`, `sleep`, `play/game/music`, `exercise`, `read`; `whiteboard` → tab Board, rak buku (`rak-buku|katalog|rak-dokumen|rak-quran`) → tab Wiki, `meeting` → tab Rapat (atau duduk), `*pengumuman*` → panel pengumuman, `server` → dock Proses ruangan itu. Perabot bawaan denah (rak buku, server rack, meja rapat, whiteboard, sofa, pantry, dispenser, kulkas/vending, arcade) ikut.
- Spot perabot yang dipakai owner diklaim (`engine.claim('owner:me', inst, si)`), jadi agen tidak memilihnya; owner dari perangkat lain mengklaim spot di bawah kakinya bila `pose` terisi.
- Agen ≤2 tile dari owner menoleh dan memunculkan balon 👋 (sekali per 30 dtk). Menu agen: **Ngobrol** (drawer tab Chat), **Tepuk bahu** (`POST /api/sessions/:sid/action {action:'text', text:'lanjut'}` atau `{action:'esc'}`), **Kasih kartu** (kartu kolom < Selesai → `PATCH /api/offices/:id/cards/:cid {who: roleId}`), **Lihat layar** (drawer tab Terminal).
- Duduk di ruang rapat (`kind:'meeting'`): manager (bila sesinya ada) berbalon "Ada yang bisa dibantu?" dan bar menambah **Suruh manager** (sama dengan form Suruh manager).
- Agen yang jalannya terhalang owner berhenti, setelah ~0,9 dtk mencari jalan memutar, dan setelah 4 dtk tetap lewat (tidak pernah macet).

## Magang (minion): NPC kosmetik

Karyawan magang meramaikan kantor. **Bukan agen**: tidak memanggil Claude, Codex, atau model apa pun (0 token); murni simulasi di klien. Ukuran sama dengan agen; pembeda: kaos + topi oranye (`#F2842B`), lanyard biru, name tag oranye **MAGANG** + nama depan. Web: `web/js/minions.js` (simulasi), `web/js/minions-ui.js` (panel/menu), pemasangan di `office-canvas.js`. Ghina: `floor/floor_minions.dart`, `floor_minion_ui.dart`.

- `GET /api/offices/:id/minions` → `{count, auto, seed, max:30, minions:[{id:'mg-N', name, look}]}`. `minions` = daftar Magang yang aktif (`count` pertama yang belum diusir), identitas diturunkan server dari `seed` sehingga web dan Ghina menampilkan nama/tampilan yang sama. `look` = kosakata role (`color, hair, skin, hairStyle, outfit, acc, hijab`) + `lanyard` (warna). Bawaan `count: 6`, `auto: false`. Juga ikut di `GET /api/offices/:id` sebagai `minions`.
- `PUT /api/offices/:id/minions {count?, auto?, usirSemua?}` → bentuk GET. `count` bilangan bulat 0–30 (400 bila di luar), `auto` boolean, `usirSemua:true` = count 0 + seed baru (Magang berikutnya orang baru). Disimpan di `meta` DB kantor (kunci `minions`).
- `POST /api/offices/:id/minions/:mid/usir` → bentuk GET. `:mid` = `mg-N` (400 bila tidak ada), atau `semua`. Satu Magang diusir: `count` berkurang satu, yang lain tetap (identitas stabil).
- Event `{t:'minions', office, minions}` (bentuk GET) setiap PUT/usir. Klien membandingkan dengan yang ada: yang hilang berpamitan lalu jalan ke lift; yang baru muncul dari lift.
- **Mode otomatis** dihitung di klien dari `count` sebagai batas atas: malam (22.00–05.30) 25%, 20–22 50%, 18–20 80%, dikurangi 1 per agen bekerja di atas 2; minimal 1. Rumus sama di web (`autoCount`) dan Ghina (`minionAutoCount`).
- **Simulasi** (tidak disinkronkan antarperangkat, jumlah/identitas/nama sama, posisi boleh beda): memakai perabot katalog lewat afford (ngopi, print, siram tanaman, baca/arsip, whiteboard, olahraga, mengetik di meja kosong, makan siang, sholat saat waktu sholat, dll.), perabot bawaan generator ruang (counter, dispenser, kulkas, printer, rak, whiteboard, tanaman), bersih-bersih dengan sapu, dan jalan antar ruangan membawa barang. Selalu mengalah ke agen asli dan owner (spot yang dipakai Magang boleh diambil; Magang berhenti dan pergi). 30 Magang tetap mulus: A* di-cache dan dibatasi 2 pencarian baru per frame.
- **Kurir kerja nyata** (antrean maks 10; kerja lama yang terlewat dibuang; kunci yang sama tidak diulang dalam jeda tertentu): `dm` -> bawa surat dari meja pengirim ke penerima; kartu dibuat/ditugaskan/dipindah (selisih daftar kartu setelah event `changed what:'board'`) -> map ke meja agen, kartu Selesai -> map ke lemari arsip; sesi `kind:'rapat'` baru -> dua Magang bawa kopi ke ruang meeting; `proc` gagal/berhenti atau perintah deploy -> lari ke ruang server; `attachment` dan `show` -> paket ke lobi; `changed what:'wiki'` -> buku ke perpustakaan; sesi menunggu izin -> berdiri di dekat agen memegang tanda "?" sampai izin diputuskan.
- Usir: ketuk Magang -> "Usir"; owner di dekatnya -> "Suruh pergi"; panel Magang -> "Usir semua". Web: kartu "Magang" di panel samping Kantor (slider, otomatis, usir semua). Ghina: tombol grup di sisi kanan denah.

### Penampilan Magang dan adegan per ruangan

- **Tampilan beragam**: `look` Magang dibuat server (`identity(seed, i)` di `server/minions.js`) dari kosakata role yang sama (`color` dari 12 warna kaos, `hair`, `skin`, `hairStyle` termasuk `hijab`, `outfit` kemeja/rok/dress/hoodie/jas, `acc` kacamata/topi/anting, `hijab` warna). Penanda Magang hanya `lanyard` oranye kecil `#F2842B` + name tag "MAGANG". Klien tidak membuat tampilan sendiri.
- **Adegan** = data di `server/furniture/scenes.json` (ikut di `GET /api/furniture` sebagai `scenes`, versi katalog berubah bila file berubah). Web dan Ghina memakai file yang sama; menambah adegan tidak butuh ubah kode.

```
{ "version": 1, "scenes": [ {
  "id": "menghadap-bos",
  "title": "Menghadap bos",
  "rooms": ["manager"],            // kind atau id ruangan; adegan hanya dipilih bila SALAH SATU ada di denah
  "weight": 1,                      // bobot dasar
  "hourWeights": [{"h": [8, 11], "w": 3}],   // pengali menurut jam lokal (default 1); sholat dll. tetap dari behaviors.json
  "actors": [1, 1],                 // [min, max] Magang (1-3); "withAgent": true = boleh mengajak agen asli yang idle sebagai lawan bicara (aktor tambahan)
  "cooldown": 90,                   // detik sebelum adegan yang sama diulang di kantor itu
  "steps": [ {...}, {...} ]
} ] }
```
Langkah (`step`) dijalankan berurutan oleh tiap aktor; semua kunci opsional kecuali satu dari `go`/`wait`/`say`:
- `go`: tujuan. `door` (tepat di luar pintu ruangan), `inside` (tile bebas di dalam ruangan), `aff:<afford>` (spot bebas berafford itu di ruangan; pose/arah dari spot), `stand:<kind>` (titik berdiri bawaan generator: coffee, water, snack, print, read, file, whiteboard, plant), `desk:mgr` (depan meja manager), `desk:agent` (belakang/samping meja agen asli yang sedang bekerja di ruangan itu), `partner` (di sebelah aktor 0, saling berhadapan), `lift`, `room:<kind|id>` (tile bebas di ruangan lain).
- `actor`: indeks aktor (0 bawaan) atau `"all"`.
- `pose` (`stand|sit|read|exercise|play|sleep|pray`), `face` (`up|down|left|right|partner|target`), `fx` (afford untuk prop, mis. `type`, `coffee`).
- `say`: teks/emoji balon, atau array (dipilih bergantian), `ms`-nya mengikuti `wait`. `wait`: detik `[lo, hi]` atau angka. `carry`: prop (`folder|box|paper|mail|book|cup|broom|sign|clip`) atau `""` untuk menaruh. `speed`: px/dtk.
- `sync: true`: aktor menunggu semua aktor sampai langkah ini.
- `skipIf`: `"agent-in-room"` (ada agen asli duduk bekerja di ruangan itu: lewati langkah, atau `"waitOutside": true` menunggu di `door` sampai ≤ 20 dtk lalu lewati).
- Aturan: adegan memakai spot lewat klaim yang sama dengan agen (tidak merebut spot terklaim); agen asli/owner yang datang membatalkan adegan Magang di spot itu; diusir membatalkan seluruh adegan; adegan tak boleh menahan pintu lebih dari beberapa detik.
- Tambahan format (final): scene `rooms` boleh `"*"` (ruangan mana pun yang bukan toilet; dipilih ruangan tempat aktor 0 berada); `need`: array syarat, `"agent"` (ada agen asli bekerja), `"mgr-desk"` (ada meja manager); `when: "prayer"` = hanya dipilih saat jendela waktu sholat; `hourWeights.h` boleh melewati 24 (mis. `[22, 29]` = 22.00–05.00). Step: `optional: true` (bila `go` tidak ketemu, lewati langkah, jangan jatuh ke `inside`), `turnAgent: true` (agen asli terdekat di ruangan menoleh ke aktor). `go` yang tidak ketemu jatuh ke `inside` (kecuali `optional`). `actor: "all"` tanpa `go` = semua aktor melakukan `say/wait/sync` itu. `go:"partner"` untuk aktor 0 = tetap di tempat; untuk aktor lain = di sebelah aktor 0 saat langkah itu dijalankan (dihitung saat itu, bukan di awal). `skipIf:"agent-in-room"` + `waitOutside:true`: tunggu di luar pintu sampai agen asli itu tidak bekerja (maks 20 dtk), lewat 20 dtk = adegan dibatalkan; tanpa `waitOutside` = hanya langkah itu dilewati. `sync` = tunggu semua aktor sampai (maks 15 dtk, lalu lanjut). Aktor "agen asli idle" (`withAgent`) hanya berdiri di tempatnya: ia tidak berjalan dan state-nya tidak diubah; ia hanya mendapat balon, dan adegan dibatalkan bila ia mulai berjalan/bekerja. `sapa-owner` bukan adegan data: perilaku bawaan (Magang yang berpapasan dengan owner < 3 tile membalas dengan balon 👋, jeda 40 dtk per Magang).
- Pilihan adegan oleh klien: dari `rooms` yang ada, bobot `weight x hourWeights`, beda dari adegan terakhir Magang itu, `cooldown` per adegan.
- Sosial = adegan biasa dengan 2-3 aktor (`ngobrol`, `makan-bersama`, `main-berdua`, `diskusi-papan`, `sapa-owner`); balon 💬 ☕ 😂 👍.

## Pesan langsung antaragen

Tool MCP `pesan_ke` (opsi `fyi`), `kabari`, `siaran`, `tanya`, `balas`, `pesan_list` (Claude dan Codex). Pesan disimpan di tabel `dm` (db kantor), diketik ke sesi tmux penerima begitu idle, dan masuk log kantor dengan `kind:'dm'`. Status: `menunggu` (tersimpan, belum diketik), `terkirim`, `dibaca`, `dibalas`. Batas per pasangan dan opsi `dm.autoStart` ada di `config.json` (`dm: {autoStart:false, maxPerPair:20, windowMin:10}`). `maxPerTurn` (bawaan 8) membatasi pesan keluar manager per giliran (balasan tidak dihitung, satu siaran dihitung satu); `midTurn:false` mematikan pengingat tengah-giliran.
- `GET /api/offices/:id/dm[?role=<id>]` -> `{threads:[{key, a:{id,name,title}, b, count, pending, last:Dm}]}`; `GET /api/offices/:id/dm/:a/:b` -> `{key, a, b, items:[Dm]}` (lama ke baru).
- `Dm = {id, from, to, fromName, toName, kind:'pesan'|'tanya'|'balasan'|'fyi', group, text, card, replyTo, status, at, sentAt, readAt, repliedAt}`.
**Pengiriman tengah-giliran.** Pesan tidak lagi menunggu penerima idle. `dm.reminder(office, role)` menyusun blok `📨 N pesan menunggu: dari X (jenis, id ...): "cuplikan"` untuk pesan berstatus `menunggu` (maks 5 per blok, cuplikan 280 karakter), menandainya `dibaca` (`seenAt` terisi) sehingga tidak diketik lagi saat idle. Blok itu menumpang di (1) hasil setiap tool MCP kantor milik role itu (`agent.js callTool` menambah blok teks kedua; blok pertama tetap JSON hasil tool), dan (2) hook `PostToolUse` / `UserPromptSubmit` lewat `hookSpecificOutput.additionalContext` (`live.js handleHook`; `hooks/kantor-hook.cjs` mencetak balasan daemon untuk dua event itu). Sumber: Claude Code https://code.claude.com/docs/en/hooks.md ("Add context for Claude"; PostToolUse harus JSON, tool MCP diperlakukan seperti tool biasa); Codex https://developers.openai.com/codex/hooks (bentuk JSON sama untuk PostToolUse dan UserPromptSubmit). Hook membuat pengingat tetap datang walau agen tidak memanggil tool kantor, tetapi tetap butuh agen memanggil tool apa pun. Terukur di daemon demo (Claude haiku, tugas panjang): pertanyaan masuk saat Ani bekerja dijawab dalam 21 detik dengan pengingat, 130 detik tanpa (menunggu Ani selesai).
- Jenis `fyi` (`pesan_ke {fyi:true}` atau `kabari`): tanpa balasan, tidak memicu turn. Hanya diketik bila ada pesan non-fyi lain yang memang diketik (digabung), atau muncul di pengingat / `pesan_list`. `balas` ke fyi ditolak dengan petunjuk.
- `siaran {ke:[role...]|'semua', teks, fyi?, kartu?}`: satu baris `dm` per penerima, diikat `group` (`grp`) yang sama; penerima yang kena batas pasangan dilewati dan dilaporkan di `dilewati`.
- Batch: beberapa pesan menunggu untuk satu penerima diketik sebagai SATU prompt berawalan `📨 N pesan masuk:`.
- Toleransi: isi kosong ditolak dengan petunjuk penulisan; `balas` dua kali ke pesan yang sama mengembalikan balasan pertama (`sudah_dibalas:true`, bukan error); `balas` ke id salah menyertakan daftar id yang menunggu.
- `Dm` kini juga membawa `group` (id siaran atau null) dan `kind` bisa `'fyi'`. Web: `web/js/dm.js` memberi label "FYI" dan " · siaran" pada gelembung.
- Event `{t:'dm', office, from, to, kind, status, item:Dm}`: dikirim saat pesan dibuat (`status:'menunggu'`) dan tiap status berubah. Web: `web/js/dm.js` (kartu "Obrolan agen" di sisi kantor, panel, tab "Pesan" di drawer agen, balon `stage.dmBalloon`).

## Tunggu kerja, autopilot, dan anggaran role

Tiga mekanisme untuk menghentikan agen yang menunggu dengan sleep/Monitor/ScheduleWakeup (tiap turn menyewa ulang konteks yang mahal).

**Tool `tunggu_kerja`** `{kejadian?:['kartu_masuk'|'kartu_untukku'|'pesan'|'commit_baru'|'review_diminta'], sampai?:ISO, maks_menit?:number (bawaan 180, maks 720), repo?:[idRuangan]}`. Agen memanggilnya lalu mengakhiri gilirannya ("menunggu"). Harness (`server/tunggu.js`) mencatat tunggu dan membangunkan sesi dengan SATU prompt ringkas (`[Kantor · bangun dari tunggu] kartu untukmu k123 "…"`) begitu kejadian terjadi dan sesi idle, atau `[Kantor · waktu tunggu habis]` bila batas lewat. Tanpa turn selama menunggu. Hanya untuk sesi tmux kantor (kantor harus bisa mengetik ke sesinya).
- `kartu_untukku`: kartu Backlog/Siap yang ditugaskan ke role ini (baru dibuat, diganti pemiliknya, atau dipindah ke Backlog/Siap), tidak terblokir, bukan perbuatannya sendiri. `kartu_masuk`: kartu baru di Backlog/Siap tanpa pemilik atau milik role ini. `review_diminta`: kartu pindah ke Review (bukan milik role ini). `pesan`: DM masuk (teksnya diketik `dm.js` seperti biasa, tidak ada prompt bangun kedua). `commit_baru`: HEAD repo ruangan berubah (polling `git log -1` tiap 30 detik per repo yang ditunggu).
- Kejadian yang datang dalam 1,5 detik digabung jadi satu prompt. Prompt apa pun yang masuk ke sesi yang sudah idle (DM, ketikan pemilik, tawaran autopilot) juga mengakhiri tunggu. Role yang anggarannya habis tidak dibangunkan.
- Sesi (`serialize`) mendapat `tunggu: {events, until, label}|null`, `label` = `"menunggu: kartu_untukku"`. Tampilkan sebagai ganti "Idle" saat `status==='idle'` dan `tunggu` ada. `sessions_list` memuat `menunggu`. Tunggu disimpan di tabel `kv` (`tunggu.<sid>`) dan dipulihkan saat daemon restart. Entri log kantor `kind:'tunggu'`.

**Autopilot per kantor** (`server/autopilot.js`, disimpan di `meta.autopilot`): `GET /api/offices/:id/autopilot` -> `{config, log:[{who,text,at}]}`; `PUT` menerima sebagian config dan mengembalikan `{config}` (event `changed what:'autopilot'`). Config: `pullWork` (bawaan **false**), `idleMinutes` (3), `maxPerHour` (4 tawaran per role), `cooldownMinutes` (60, kartu yang sama tidak ditawarkan lagi), `skipLabels` (label yang tidak pernah ditawarkan; bawaan menunggu/klien/pemilik/blokir), `budgetPeriod` (`hari`|`shift`, apa yang dihitung anggaran role), `managerRound: {enabled:false, staleMinutes:45, cooldownMinutes:30}`.
- `pullWork` (cek tiap 60 detik): sesi tmux kantor yang idle >= `idleMinutes`, tanpa DM menunggu dan tanpa kartu Dikerjakan, ditawari SATU kartu Backlog/Siap yang cocok (milik role itu dulu, lalu tanpa pemilik yang `repo` = ruangan role atau berlabel nama/ruangan role; tidak terblokir, dependensinya selesai, bukan epic). Tawaran berupa prompt; agen yang mengambil lewat `card_update`. Log kantor `kind:'autopilot'`.
- `managerRound`: tidak ada ronde otomatis lain di kode; bila `enabled`, manager yang idle diberi satu prompt hanya jika ada kartu Siap/Review tak terblokir yang tidak bergerak lebih dari `staleMinutes`.

**Anggaran role**: `PATCH /api/offices/:id/roles/:rid {budget:number|null}` (kolom `budget_usd`; kosong/0 = tanpa batas; field angka di form role web, `rf-budget`). Role Claude: dolar per hari (setara tarif API); role Codex: jumlah token (input+output) per hari, karena biayanya 0. Dengan `budgetPeriod:'shift'` yang dihitung hanya sesi yang sedang jalan. Dihitung dari tabel `usage` (diperbarui scanner tiap 90-120 detik).
- `GET /api/offices/:id/anggaran` -> `{period, roles:[{role, name, limit, unit:'usd'|'token', period, used, percent, level:'ok'|'peringatan'|'habis'}]}` (hanya role yang punya batas).
- 80% (`peringatan`): setiap hasil tool kantor yang dipanggil role itu membawa teks tambahan `[Kantor · anggaran 82%] …`. 100% (`habis`): sesinya diketik pesan "simpan pekerjaan dan berhenti", sesi ditandai `anggaran:'habis'` (`'peringatan'` di 80%), log kantor `kind:'budget'`, dan Ghina dapat notifikasi (event `question`, judul "<Nama>: anggaran habis"; matikan dengan `ghinaNotify.budget:false`). Sekali per hari (atau per shift); shift yang dimulai sesudahnya diberi pesan yang sama. Event realtime `{t:'budget', office, role, level, used, limit, unit}` pada tiap perubahan level.

## Mesin: Claude Code atau OpenAI Codex

Detail dan riset di `docs/CODEX.md`. Ringkasnya untuk klien:
- Role: `engine` (`claude`|`codex`) dan `effort`; untuk role Codex, `model` adalah slug Codex (kosong = bawaan Codex). `POST/PATCH /api/offices/:id/roles` menerima ketiganya.
- Sesi (`serialize`): `engine` dan `effort`. Tampilkan badge kecil "Codex" di kartu agen, header sesi, daftar, dan penanda di atas karakter di denah (jangan ubah sprite).
- Mulai shift: `POST /api/offices/:id/roles/:rid/start` menerima `engine`, `model`, `effort`, `permissionMode`. Pilihan model/effort dari `GET /api/codex/models` (kosong = isian bebas dengan `default`).
- Mode izin Codex: `default` (Tanya dulu), `auto` (Approve for me), `readOnly`, `bypassPermissions` (Full Access). Ganti saat jalan: `POST /api/sessions/:sid/mode {mode}`; model/effort: `POST /api/sessions/:sid/codex/settings {model?, effort?, mode?}` (sesi harus idle, 409 bila sibuk). `model/open|select|cancel` khusus Claude.
- Selebihnya (chat, kirim teks, Hentikan, compact, kotak masuk izin, notifikasi) sama persis untuk kedua mesin.

## Performa PC (sysmon)

Satu sampler bersama di daemon (`server/sysmon.js`). Ia sampling tiap `sysmon.intervalSec` (5 dtk) hanya selama ada klien yang meminta dalam `activeSec` (60 dtk) terakhir; kalau tidak, ia turun ke `idleSec` (60 dtk) dan tidak menyiarkan apa-apa. Setiap `GET /api/sysmon*` atau pesan WS `{t:'sysmon-sub'}` di `/ws` menghitung sebagai "sedang dilihat".

Tiap probe punya kadensnya sendiri (exec dengan timeout, tidak pernah tumpang-tindih, tanpa sudo). Saat dilihat: CPU/jaringan/disk I/O/GPU tiap tick (5 dtk), memori 10 dtk, proses 10 dtk, baterai 30 dtk, df/termal/koneksi/route 60 dtk, `top` (jumlah thread) & `who` 5 menit. Saat idle (60 dtk) hanya CPU, memori, df, baterai, termal (cukup untuk peringatan); probe laju dilewati.

- `GET /api/sysmon?min=10&series=cpu,ram` → `{enabled, host, os, arch, model, chip, uptimeSec, bootAt, users[], at, intervalSec, active, tickMs, cost:{ticks, avgTickMs, execMs, daemonCpuPct}, cpu:{total, user, sys, idle, cores[], count, levels:[{name, cores, kind:'P'|'E'}], freqMHz}, load:[1,5,15], counts:{procs, running, threads}|null, mem:{total, used, free, pct, app, wired, compressed, cached, unused, pressure:'normal'|'waspada'|'kritis', freePct, swap:{total,used,free}, rates:{pageins, pageouts, swapins, swapouts}/dtk}, disks:[{mount, dev, name, total, used, free, pct}], diskio:{read, write (byte/dtk), rIops, wIops, readTotal, writeTotal}, net:{rx, tx (byte/dtk), rxTotal, txTotal, active, ifaces:{en0:{ip, rx, tx, rxTotal, txTotal}}, conns:{established, listen}, wifi:{ssid|null (macOS menyamarkan), security}|null}, battery:{pct, ac, charging, full, state:'penuh'|'mengisi'|'terhubung'|'baterai', remainingMin, cycles, designCycles, health (% kapasitas desain), condition, capacityMah, designMah, tempC, watts (negatif = dipakai), voltage, adapter:{watts, name}|null}|null, thermal:{state, speedLimit}|null, gpu:{util, renderer, tiler, mem, alloc, name, cores}|null, tempC (suhu baterai)|null, fan:null, agents:{cpu, rss, n, kinds:{claude|codex|node|tmux:{cpu,rss,n}}}, health:{score 0–100, status:'baik'|'waspada'|'buruk', reasons:[{text, pts, level}]}, alerts, events (20 terakhir), limits, history}`.
- `top` (di snapshot, `/procs`, dan event live) = pemakan terbesar per sumber daya, dikelompokkan per aplikasi, 5 teratas: `{cpu, ram, net, gpu, power: [{name, value, n, rx?, tx?}]}`. Satuan `value`: cpu = % (100 = 1 core), ram = byte, net = byte/dtk (`rx`/`tx` terpisah, `nettop` tiap 10 dtk), gpu = % waktu GPU (`ioreg` AppUsage, 10 dtk), power = "energy impact" `top` (tiap 5 mnt, karena 2 sampel top ≈ 0,8 dtk CPU). Kunci bisa belum ada sampai sampel kedua. Disk I/O per proses tidak ada (butuh sudo: `fs_usage`/`iotop`).
- `GET /api/sysmon/history?min=60&series=cpu,cores,gpu&points=300` → `{t[], step, min, <seri>[]}` array sejajar (nilai `null` = tidak ada sampel). `min` ≤ 60 dibaca dari ring mentah (5 dtk, 1 jam); > 60 (sampai 1440) dari ring 24 jam rata-rata 1 menit. `points` meratakan per ember. Seri: `cpu user sys ram swap(MB) comp(MB) rx tx dr dw (byte/dtk) gpu batt agents (%CPU, 100 = 1 core) load score`, `c0…cN` per core, atau `cores` untuk semuanya. Default `cpu,ram,rx,tx,load`.
- `GET /api/sysmon/procs?all=1` → `{at, count, counts, byCpu, byRam:[{pid,ppid,cpu,rss,name,agent?}], groups:[{name, cpu, rss, n, agent, procs:[{pid,cpu,rss,name}] (≤12)}], agents}` (cache 5 dtk; tanpa `all` hanya 60 grup teratas + semua grup agen).
- `GET /api/sysmon/events?limit=100` → `{events:[{at, kind, level:'ok'|'info'|'warn'|'bad', text}]}` (terbaru dulu, maks 200): lewat/kembali dari batas, peringatan terkirim, tekanan memori, termal, charger, status kesehatan, baterai lemah.
- Event `{t:'sysmon', at, cpu, split, cores, load, mem:{pct,used,total,app,wired,compressed,cached,pressure,swapUsed,rates}, net:{rx,tx}, disk:{read,write,rIops,wIops}, gpu:{util,mem}, batt:{pct,charging,ac,watts}, agents:{cpu,rss,n}, health:{score,status}, alerts}` tiap tick selama aktif.
- Peringatan: nilai di atas `sysmon.alerts.{cpu,ram,disk,swapPct,tempC}` terus-menerus selama `sustainSec` → satu push Ghina (`kind:'sysmon'`, event `question`, cooldown `cooldownMin`), matikan dengan `ghinaNotify.sysmon: false`. Suhu CPU dan kipas butuh sudo/SMC → `fan:null`; `tempC` hanya suhu baterai.

## Pratinjau

Agen mengirim hasil visual untuk diputuskan pemilik (`pratinjau_kirim`, lihat `docs/MCP.md`). Kode: `server/pratinjau.js`, `web/js/pratinjau.js` (tab `#/o/<id>/pratinjau[/<pid>]`), `web/css/pratinjau.css`; Ghina `lib/presentation/features/kantor/pratinjau/`. Tes: `test/pratinjau.test.js`.

Item:

```json
{ "id": "p1a2b3c4d5", "office": "shop", "fromRole": "r…", "fromName": "Bayu", "sid": "…",
  "title": "Desain checkout", "note": "catatan agen", "mode": "set|pilihan|bundle", "card": "k…|null",
  "version": 2, "parentId": "p…|null", "rootId": "p…",
  "jenis": "persetujuan|info|pilihan",
  "status": "baru|dilihat|dikomentari|sebagian|disetujui|revisi|dipilih", "picked": "f2|null", "ownerNote": "catatan pemilik|null", "wiki": "slug|null",
  "createdAt": "…", "decidedAt": "…|null", "size": 123456,
  "seenAt": "…|null", "pinned": false, "archived": false, "snoozedUntil": "…|null", "snoozed": false,
  "reactions": { "🔥": "<waktu>" }, "comments": [{ "id": "k…", "text": "…", "file": "f1|null", "t": 12.5, "at": "…" }],
  "base": "/pv/shop/p…/<key>/",            // hanya mode bundle: akar situs
  "files": [{ "id": "f1", "name": "hero.png", "rel": "hero.png", "mime": "image/png", "size": 1234,
              "kind": "html|image|pdf|video|doc|other", "url": "/pv/shop/p…/<key>/hero.png",
              "thumb": "/pvt/shop/p…/<key>/f1.jpg|null", "thumbState": "siap|menyiapkan|gagal",
              "putar": "null|menyiapkan|siap|gagal", "putarUrl": "/pvt/shop/p…/<key>/f1.mp4|null", "status": "menunggu|oke|revisi", "note": "…|null" }],
  "versions": [{ "id": "p…", "version": 1, "status": "revisi", "createdAt": "…" }] }
```

- `jenis` dipilih agen (bawaan `info`; mode pilihan → `pilihan`). Tombol per jenis: persetujuan → Setujui · Revisi · Komentar; info → 👀 Sudah lihat · Komentar; pilihan → ⭐ Pilih · Komentar. Aksi netral di semua item: 💬 Komentar (per item/berkas, video bertanda waktu `t`), 👀 Sudah lihat, 📌 Simpan, ⏸ Nanti dulu, 🗂 Arsipkan, reaksi 👍 ❤️ 🔥 🤔.
- Status: revisi menyeluruh menang; lalu sudah dipilih = `dipilih`; dari berkas: semua `oke` = `disetujui`, semua dinilai dan ada `revisi` = `revisi`, sebagian = `sebagian`; lalu ada komentar = `dikomentari`, sudah dilihat = `dilihat`, selain itu `baru`. Migrasi: item lama tanpa `jenis` = `persetujuan`, `menunggu` → `baru`, pilihan yang sudah dipilih → `dipilih`.
- **Bangun / tidak**: Komentar, Setujui, Revisi, Pilih, dan penilaian per berkas dikirim ke agen sebagai DM (membangunkan sesi). Sudah lihat, reaksi, Simpan, Nanti dulu, Arsip TIDAK mengirim apa pun; agen melihatnya di `pratinjau_status`. DM komentar video menyertakan `@m:ss`.
- **Kartu**: hanya Setujui dan Revisi yang menggerakkan kartu terkait (aturan di bagian Board). Pilih hanya menambah komentar di kartu; komentar/lihat/reaksi tidak menyentuh kartu.
- **Media latar** (antre satu per satu, `nice`, tidak pernah menahan pengiriman; `config.pratinjau.autoMedia:false` mematikannya): gambar kecil semua jenis (video: frame ffmpeg di ~1 dtk/10%; gambar: ffmpeg lalu `sips`; HTML/bundle (halaman entri)/PDF/dokumen: QuickLook `qlmanage -t` lalu `sips`; gagal semua → `thumbState:'gagal'`, klien memakai ikon). Video `.mov` atau yang bukan H.264/AAC (ffprobe) dibuatkan rendisi "putar" H.264/AAC mp4 (≤1080p, `+faststart`); klien memutar `putarUrl` bila ada, menampilkan "menyiapkan video…" selama `putar:'menyiapkan'`. Berkas asli tetap.
- Berkas disalin ke `~/.kantor-claude/offices/<id>/pratinjau/<pid>/files/` saat dikirim (snapshot tetap). Mode bundle: seluruh folder (atau isi .zip; satu folder puncak dipakai sebagai akar) disalin tanpa symlink, `.git`, `node_modules`; `files` = halaman `.html` (index.html dulu, maks 30).
- **Penyajian**: `GET|HEAD /pv/<office>/<pid>/<key>/<path>` dan `/pvt/<office>/<pid>/<key>/<fid>.jpg` (gambar kecil <= 480 px; gambar/video juga dibuat saat diminta, jenis lain setelah tugas latar selesai; `thumb: null` = pakai ikon) dan `/pvt/…/<fid>.mp4` (rendisi putar). `<key>` = HMAC token kantor, jadi URL sudah membawa izinnya: tanpa cookie/Bearer (halaman dalam sandbox punya origin opaque dan tidak mengirim cookie). Host tetap dicek. Semua respons: `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups` (tanpa `allow-same-origin`), `Referrer-Policy: no-referrer`, `Range` didukung. Folder → `index.html`. Web menampilkan HTML di `<iframe sandbox="allow-scripts allow-forms allow-modals">`; Ghina di WebView dengan JS, navigasi dibatasi ke `/pv/<office>/<pid>/`.
- API (auth biasa):
  - `GET /api/offices/:id/pratinjau?status=baru|perlu|semua|disimpan|arsip&limit=60` → `{items, counts:{baru, perlu, semua, disimpan, arsip, menunggu}}`. `baru` = status baru; `perlu` = jenis bukan info dan belum diputuskan; keduanya tanpa yang diarsip atau masih ditunda (`snoozedUntil` di masa depan). `semua` = tanpa arsip; `disimpan` = pinned; `arsip`. Nama status (mis. `disetujui`) juga diterima; `menunggu` = `perlu` (klien lama). Filter pengirim opsional: `&sid=` dan/atau `&role=`; `counts` tetap seluruh kantor. Lencana tab = `counts.perlu`.
  - `GET /api/offices/:id/pratinjau/usage` → `{bytes, items, files}`: total penyimpanan pratinjau kantor (cache, dihitung ulang setelah kirim/tugas media). Lihat pembersihan di bawah.
  - Pembersihan (`config.pratinjau.cleanupDays`, bawaan 30, 0 = mati; tugas harian + 5 menit setelah start): hapus `files/` dan `putar/` item selesai (disetujui/dipilih/diarsip, atau info yang dilihat/dikomentari) yang lebih tua dari N hari sejak keputusan/aktivitas terakhir. Tidak pernah: baru/revisi/sebagian, 📌 disimpan, ditunda, sudah jadi wiki. Gambar kecil tetap; item tetap dengan `filesPurged:true, purgedAt` (klien menampilkan "berkas sudah dibersihkan"). Dicatat di log kantor. `POST /api/pratinjau/cleanup {dryRun?, days?, office?}` → `{days, dryRun, bytes, items:[{office,id,title,bytes}]}` (`off:true` bila mati). `GET|PUT /api/pratinjau/storage {cleanupDays}` → `{cleanupDays, offices:[{id,name,bytes,items,files}]}` (Pengaturan web "Penyimpanan pratinjau").
  - `GET /api/offices/:id/pratinjau/:pid` → item.
  - `POST …/:pid/setujui {catatan?}`, `POST …/:pid/revisi {catatan}` (wajib), `POST …/:pid/pilih {file, catatan?}` (mode pilihan), `POST …/:pid/files/:fid {status:'oke'|'revisi', catatan?}` → item.
  - `POST …/:pid/komentar {teks, file?, t?}`, `POST …/:pid/lihat`, `POST …/:pid/reaksi {emoji}` (toggle), `POST …/:pid/tanda {pinned?, archived?, snoozedUntil?: iso|null}` → item.
  - `POST …/:pid/wiki {judul?}` → `{slug, title}`: halaman wiki dengan berkas disalin ke media kantor (sintaks embed media biasa); bundle jadi daftar tautan `/pv/…`.
- Keputusan sampai ke role pengirim sebagai DM `kind:'pesan'` dari `pemilik` (nama "Pemilik"; membangunkan sesi idle). Penilaian per berkas dikumpulkan jadi satu pesan: dikirim begitu semua berkas dinilai, atau `config.pratinjau.batchSec` (20 dtk) setelah penilaian terakhir. Sesi tanpa role: teksnya diketik ke sesi pengirim bila masih hidup.
- Event live `{t:'pratinjau', office, item}` saat dibuat dan setiap berubah (upsert berdasarkan `item.id`).
- Chat sesi (web `chat.js`, Ghina chat) menampilkan pratinjau dari sesi itu (`?sid=`) sebagai gelembung menurut `createdAt`, dengan tombol aksi per jenis; ketuk membuka penampil layar penuh. Penampil video: tombol "Komentar di m:ss", penanda komentar di bilah progres (ketuk = lompat), Bingkai IG 4:5 / Reels 9:16 (video berputar tanpa suara, ketuk untuk suara), Bandingkan berkas/versi dengan putar/jeda/geser serentak.
- Push Ghina: `event:'pratinjau'`, `title:"<Nama> mengirim pratinjau"`, `body:"<judul> — <n> berkas"`, `office`, `id`, `path:"#/o/<office>/pratinjau/<id>"`. Aktif kecuali `ghinaNotify.pratinjau === false`.

## Gaya kode

Ikuti gaya `main.js`/`util.js`: fungsi kecil, template string, `esc()` untuk SEMUA teks dari server, tanpa komentar berlebihan. Tidak ada `alert/confirm/prompt` — pakai `modal`/`confirmDo`. Tangani error dengan `toast(err.message, 'bad')`. Layout harus tetap rapi di lebar 400px.

Tool MCP untuk merombak kantor (role, ruangan, denah, template, perabot) ada di [`docs/MCP.md`](MCP.md). Perubahannya memancarkan event `changed` dengan `what: 'plan'` atau `'furniture'`, sama dengan editor web.
