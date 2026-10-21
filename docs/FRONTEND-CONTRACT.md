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

## Drawer (`web/js/panel.js`)

`showDrawer(html, { wide, key, close })` → elemen drawer; `closeDrawer()`; `drawerState()` → `{open, key}`; `drawerEl()`. Struktur isi yang dipakai CSS: `.dr-head` (+ `.dr-ava`, `.dr-id`, `.dr-name`, `.dr-title`, tombol `.icon-btn` dengan `data-act="close-drawer"`), `.dr-tabs` (button `aria-selected`), `.dr-body` (+ `.dr-sec h3`, `dl.facts`).

## Event realtime (`onLive` / fungsi `live(msg)`)

- `{t:'session', office, session}` — status sesi berubah. `session = {sid, office, room, role, kind:'kantor'|'manual'|'rapat', worktree, cwd, status:'starting'|'working'|'idle'|'waiting'|'ended', tool:{name,label,at}|null, title, model, startedAt, lastSeen, tmux, waiting:{id,tool,summary}|null, slot, compacting, subs:[{id,type,desc,status:'working'|'done',tool,started}]}`. `main.js` sudah memperbarui `ctx.office.sessions` sebelum memanggil `live`.
- `{t:'session-gone', office, sid}`
- `{t:'log', office, entry:{who,text,at,kind}}`
- `{t:'inbox', item}`, `{t:'inbox-update', id, status}`
- `{t:'changed', office, what:'board'|'notes'|'wiki'|'meetings'|'roles'|'plan'|'news'|'payroll', card?, note?, slug?, meeting?}` — `office:'*'` berarti semua. Modul me-refetch datanya sendiri.
- `{t:'meeting-msg', office, meetingId, msg:{id,who,text,at,cost,kind:'bicara'|'kamu'|'sistem'}}`

## API (semua JSON, cookie auth otomatis; error → `{error}` dengan status 4xx, `api()` melempar Error berisi pesannya)

Kantor
- `GET /api/state` → `{offices:[{id,name,root,style,sessions:[{sid,role,status,title}],roles,cards:{open,blocked,done},monthCost}], inbox:[…], hooks:bool, tmux:bool, claude:bool, settings:{approvals:{holdKantorSec,holdManualSec}, roots, extraHosts}}`
- `GET /api/offices/:id` → `{id,name,root,style,plan:{w,h,rooms:[{id,name,kind,path,stack,md,worktrees,aliases,zoneOf,note}],…}, roles:[Role], sessions:[Session], news:[{id,text,at,author}], log:[{who,text,at,kind}], wall:[Note], cards:[{id,title,col,who,repo,blocked}]}`
- `POST /api/offices/:id/rescan`
- Ruangan: `GET /api/offices/:id/folders` → `[{dir,stack,used}]`; `POST /api/offices/:id/rooms {name, kind:'kode'|'meeting'|'lib'|'qa'|'server'|'pantry'|'beku'|'game'|'manager', path, create:bool, gitInit:bool}` → `{id}`; `PATCH /api/offices/:id/rooms/:rid {name?, note?, frozen?:bool, remove?:bool}` (remove hanya untuk ruangan tambahan).

Role = `{id,name,title,model:'opus'|'sonnet'|'haiku'|'fable',room,color,hair,skin,hairStyle:'short'|'long'|'bun',tie,isMgr,persona,skills:[],notes,budget,archived}`
- `GET /api/offices/:id/roles` (termasuk yang diarsipkan), `POST /api/offices/:id/roles {name,title,model,room,color,hair,skin,hairStyle,tie,persona,skills}`, `PATCH /api/offices/:id/roles/:rid {…sebagian; archived:bool; notes; budget}`
- `POST /api/offices/:id/roles/:rid/start {task?, cardId?, worktree?:bool, permissionMode?:'default'|'acceptEdits'|'auto'|'plan', resumeSid?}` → `{sid,tmux,slot}`. Role boleh punya beberapa sesi paralel (slot 0,1,2…). `worktree:true` membuat git worktree terpisah untuk slot > 0.

Sesi
- `POST /api/sessions/:sid/action {action:'esc'|'compact'|'clear'|'exit'|'kill'|'text', text?}` (hanya sesi tmux kantor)
- `GET /api/sessions/:sid/peek` → `{text}` (isi layar tmux)
- Terminal: WebSocket `/ws/term?kind=session&sid=…&cols=&rows=` atau `/ws/term?kind=shell&office=…&room=…&cols=&rows=`. Server mengirim teks terminal mentah; klien mengirim ketikan mentah; resize dikirim sebagai string `'\x00' + JSON.stringify({cols, rows})`. xterm.js tersedia global: `window.Terminal`, `window.FitAddon.FitAddon`.
- `GET /api/offices/:id/archive` → `[{sid,role,room,title,first_prompt,started_at,ended_at,last_seen,source,tmux,cost,output,active}]`

Kotak masuk: `GET /api/inbox`, `POST /api/inbox/:iid {behavior:'allow'|'deny', message?}`

Board (kolom 0..4 = Backlog, Siap, Dikerjakan, Review, Selesai)
- `GET /api/offices/:id/board` → `{cols:[…], cards:[{id,title,desc,col,colName,who,repo,prio:'P0'..'P3',due,blocked,epic,epicId,files,createdAt,updatedAt,movedBy,movedAt,ord,checks:{total,done},comments:n}]}`
- `GET /api/offices/:id/cards/:cid` → kartu + `checklist:[{id,text,done}], comments:[{id,who,text,at}], history:[{who,text,at}], links:[{kind,value,at}], children:[{id,title,col,colName,repo,who}]`
- `POST /api/offices/:id/cards {title,desc,col,who,repo,prio,due,checklist:[str],epicId}`; `PATCH /api/offices/:id/cards/:cid {title,desc,col,who,repo,prio,due,blocked,epicId,ord}`; `DELETE /api/offices/:id/cards/:cid`
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
- `GET /api/offices/:id/meetings/:mid` → `{…, agenda, rounds, summary, decisions:[str], actions:[{title,who,prio,detail,card}], wiki_slug, error, messages:[{id,who,text,at,cost,kind}], running}`
- `POST /api/offices/:id/meetings {topic, agenda, participants:[roleId] (min 2), rounds:1-4, chair}`; `POST /api/offices/:id/meetings-cancel`; `POST …/meetings/:mid/say {text}` (menyela saat berjalan); `POST …/meetings/:mid/action {index: n | 'all'}` (tindak lanjut → kartu)
- Rapat memakai `claude -p` per giliran; biaya nyata, jadi form harus menyebut perkiraan jumlah giliran (peserta × ronde + 1 notulen).

Payroll (biaya = estimasi setara harga API dari transcript, bukan tagihan langganan)
- `GET /api/payroll?office=&month=YYYY-MM` (tanpa office = semua kantor) → `{month, months:[…], total:{cost,input,output,cache_w,cache_r,msgs,sessions}, byRole:[{role,cost,output,input,sessions}], byModel:[{model,label,cost,output}], byDay:[{day,cost}] (30 hari terakhir), bySession:[{sid,role,cost,output,first,last,title,first_prompt,room,source}], byOffice:[{office,cost,sessions}], budget:number|null, scan:{running,files,done,lastRun,error}}`
- `POST /api/offices/:id/budget {usd}`; `POST /api/payroll/rescan`

Pengaturan
- `POST /api/settings {approvals:{holdKantorSec, holdManualSec}}`
- `POST /api/hooks/install`, `POST /api/hooks/uninstall` (mengubah `~/.claude/settings.json`, cadangan otomatis)

## Gaya kode

Ikuti gaya `main.js`/`util.js`: fungsi kecil, template string, `esc()` untuk SEMUA teks dari server, tanpa komentar berlebihan. Tidak ada `alert/confirm/prompt` — pakai `modal`/`confirmDo`. Tangani error dengan `toast(err.message, 'bad')`. Layout harus tetap rapi di lebar 400px.
