// Tools exposed to Claude sessions through the `kantor` MCP server.
import { officeForCwd, officeModel, addRoom } from './offices.js';
import { bus } from './live.js';
import * as st from './store.js';
import { live, whoOf, serialize } from './live.js';
import { startShift, setPermMode } from './tmux.js';
import { config } from './config.js';
import { globalDb, one } from './db.js';

// from strictest to loosest; a manager can hand out its own mode or a stricter one
const MODE_RANK = { plan: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };
const MODE_NAMES = Object.keys(MODE_RANK);

export const TOOLS = [
  { name: 'board_list', description: 'Daftar kartu di board kantor (tanpa yang diarsipkan). Bisa difilter kolom, role, atau repo.',
    inputSchema: { type: 'object', properties: { col: { type: 'string', description: 'Backlog | Siap | Dikerjakan | Review | Selesai' }, who: { type: 'string', description: 'id role' }, repo: { type: 'string' }, mine: { type: 'boolean', description: 'hanya kartu milikku' } } } },
  { name: 'card_get', description: 'Detail satu kartu: deskripsi, checklist, komentar, riwayat.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'card_create', description: 'Buat kartu baru di board.', inputSchema: { type: 'object', properties: {
    title: { type: 'string' }, desc: { type: 'string' }, who: { type: 'string', description: 'id role yang ditugaskan' }, repo: { type: 'string', description: 'id ruangan/repo' },
    prio: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, col: { type: 'string' }, checklist: { type: 'array', items: { type: 'string' } }, epic_id: { type: 'string', description: 'id kartu epic induk' } }, required: ['title'] } },
  { name: 'card_update', description: 'Ubah kartu: pindah kolom, ganti penugasan, prioritas, deskripsi, tenggat, atau tandai terblokir (blocked: alasan; kosongkan untuk melepas).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, col: { type: 'string' }, who: { type: 'string' }, prio: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, due: { type: 'string' }, blocked: { type: 'string' } }, required: ['id'] } },
  { name: 'card_check', description: 'Centang/batalkan item checklist (cocokkan dengan teks atau index mulai 0), atau tambah item baru bila teks belum ada.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, index: { type: 'integer' }, done: { type: 'boolean' } }, required: ['id'] } },
  { name: 'card_comment', description: 'Tulis komentar di kartu (temuan, pertanyaan, hasil).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'wiki_search', description: 'Cari halaman wiki kantor.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'wiki_read', description: 'Baca halaman wiki berdasarkan judul atau slug. Tanpa argumen: daftar semua halaman.', inputSchema: { type: 'object', properties: { page: { type: 'string' } } } },
  { name: 'wiki_write', description: 'Buat atau ganti seluruh isi halaman wiki (markdown, link antarhalaman pakai [[Judul]]). Setiap simpan tercatat sebagai revisi.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string', description: 'ringkasan perubahan' } }, required: ['title', 'body'] } },
  { name: 'notes_list', description: 'Daftar catatan umum kantor (notes). Bisa dicari.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, tag: { type: 'string' } } } },
  { name: 'note_write', description: 'Buat catatan baru, atau ubah catatan yang ada bila id diberikan.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
  { name: 'role_notes_read', description: 'Baca buku catatan pribadimu (atau role lain bila role diisi).', inputSchema: { type: 'object', properties: { role: { type: 'string' } } } },
  { name: 'role_notes_write', description: 'Tulis buku catatan pribadimu. mode=append menambah di akhir, replace mengganti semuanya. Dibaca otomatis di awal shift berikutnya.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } }, required: ['text'] } },
  { name: 'announce', description: 'Tempel pengumuman singkat di papan pengumuman kantor.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'roles_list', description: 'Daftar role di kantor beserta ruangan dan status shift-nya.', inputSchema: { type: 'object', properties: {} } },
  { name: 'room_create', description: 'Khusus manager: tambah ruangan baru di kantor (mis. untuk subproject baru). path = folder relatif terhadap folder kantor; create=true membuat foldernya.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['kode', 'game', 'meeting', 'lib', 'qa', 'server', 'pantry'] }, path: { type: 'string' }, create: { type: 'boolean' } }, required: ['name'] } },
  { name: 'shift_start', description: 'Khusus manager: mulai shift role lain di tmux, opsional langsung dengan tugas atau kartu (tugas langsung masuk sebagai pesan pertama). permission_mode menentukan mode izin shift itu; tanpa itu dipakai mode bawaan kantor. Kamu tidak bisa memberi mode yang lebih longgar dari modemu sendiri.',
    inputSchema: { type: 'object', properties: { role: { type: 'string' }, task: { type: 'string' }, card_id: { type: 'string' }, permission_mode: { type: 'string', enum: MODE_NAMES } }, required: ['role'] } },
  { name: 'shift_mode', description: 'Khusus manager: ganti mode izin shift role yang sedang jalan (sama dengan menekan Shift+Tab di terminalnya). Tidak bisa lebih longgar dari modemu sendiri.',
    inputSchema: { type: 'object', properties: { role: { type: 'string' }, permission_mode: { type: 'string', enum: MODE_NAMES } }, required: ['role', 'permission_mode'] } },
];

const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

export function resolveIdentity({ office, role, sid, cwd }) {
  const o = office || (cwd ? officeForCwd(cwd) : null);
  if (!o) throw new Error('Folder ini bukan bagian dari kantor mana pun.');
  const s = sid ? live.get(sid) : null;
  const roleId = role || s?.role || null;
  const r = roleId ? st.getRole(o, roleId) : null;
  const by = r?.name || (s ? whoOf(s) : 'Sesi manual');
  return { office: o, role: r, by, sid };
}

// the caller's live session; after /clear its id changed, so look it up through its tmux pane
function callerSession(sid) {
  if (!sid) return null;
  const s = live.get(sid);
  if (s) return s;
  const row = one(globalDb(), 'SELECT tmux FROM sessions WHERE sid = ?', sid);
  return row?.tmux ? [...live.values()].find(x => x.tmux === row.tmux && x.status !== 'ended') : null;
}
function allowMode(ident, mode) {
  if (!mode || mode === 'ikut') return;
  if (!(mode in MODE_RANK)) throw new Error(`Mode tidak dikenal: ${mode}. Pilihan: ${MODE_NAMES.join(', ')}.`);
  const mine = callerSession(ident.sid)?.permMode || 'default';
  if (MODE_RANK[mode] > (MODE_RANK[mine] ?? 1)) throw new Error(`Mode ${mode} lebih longgar dari modemu sendiri (${mine}). Minta pengguna yang memilihnya dari kantor.`);
}

export async function callTool(ident, name, a = {}) {
  const { office, role, by } = ident;
  const brief = c => ({ id: c.id, judul: c.title, kolom: c.colName, untuk: c.who, repo: c.repo, prioritas: c.prio, checklist: `${c.checks.done}/${c.checks.total}`, terblokir: c.blocked || undefined, epic: c.epic || undefined, epic_induk: c.epicId || undefined });
  switch (name) {
    case 'board_list': {
      let cards = st.listCards(office);
      if (a.col) { const i = st.colIndex(a.col); cards = cards.filter(c => c.col === i); }
      if (a.who) cards = cards.filter(c => c.who === a.who);
      if (a.mine && role) cards = cards.filter(c => c.who === role.id);
      if (a.repo) cards = cards.filter(c => c.repo === a.repo);
      return text({ kolom: st.COLS, kartu: cards.map(brief) });
    }
    case 'card_get': { const c = st.getCard(office, a.id); return text({ ...c, kolom: c.colName }); }
    case 'card_create': { const c = st.createCard(office, { ...a, epicId: a.epic_id }, by); return text(`Kartu ${c.id} dibuat di ${c.colName}.`); }
    case 'card_update': {
      const whoName = a.who ? st.getRole(office, a.who)?.name : undefined;
      if (a.who && !whoName) throw new Error(`Role ${a.who} tidak ada. Pakai roles_list untuk melihat id role.`);
      const c = st.updateCard(office, a.id, { ...a, whoName }, by);
      return text(`Kartu ${c.id} sekarang di ${c.colName}${c.who ? `, untuk ${c.who}` : ''}${c.blocked ? `, terblokir: ${c.blocked}` : ''}.`);
    }
    case 'card_check': { const c = st.checkItem(office, a.id, { text: a.text, index: a.index, done: a.done }, by); return text(c.checklist.map((x, i) => `${i}. [${x.done ? 'x' : ' '}] ${x.text}`).join('\n')); }
    case 'card_comment': { st.commentCard(office, a.id, a.text, by); return text('Komentar ditambahkan.'); }
    case 'wiki_search': return text(st.searchWiki(office, a.q));
    case 'wiki_read': {
      if (!a.page) return text(st.listWiki(office).map(p => `${p.title} (${p.slug})`).join('\n') || '(wiki kosong)');
      const p = st.getWiki(office, a.page);
      return text(p ? `# ${p.title}\n\n${p.body}` : `Halaman "${a.page}" belum ada.`);
    }
    case 'wiki_write': { const p = st.saveWiki(office, { title: a.title, body: a.body, msg: a.summary, prevSlug: st.getWiki(office, a.title)?.slug }, by); return text(`Wiki "${p.title}" disimpan (revisi ke-${p.revs}).`); }
    case 'notes_list': return text(st.listNotes(office, { q: a.q, tag: a.tag }).map(n => ({ id: n.id, judul: n.title, tags: n.tags, isi: n.body.slice(0, 400) })));
    case 'note_write': { const n = st.saveNote(office, { id: a.id, title: a.title, body: a.body, tags: a.tags }, by); return text(`Catatan ${n.id} disimpan.`); }
    case 'role_notes_read': { const r = a.role ? st.getRole(office, a.role) : role; if (!r) throw new Error('Sesi ini tidak terikat ke role.'); return text(r.notes || '(kosong)'); }
    case 'role_notes_write': { if (!role) throw new Error('Sesi ini tidak terikat ke role, jadi tidak punya buku catatan.'); st.writeRoleNotes(office, role.id, a.text, a.mode || 'append', by); return text('Buku catatan diperbarui.'); }
    case 'announce': { st.addNews(office, a.text, by); return text('Pengumuman ditempel.'); }
    case 'roles_list': {
      const active = new Set([...live.values()].filter(s => s.office === office && s.status !== 'ended').map(s => s.role));
      const m = officeModel(office);
      return text(st.listRoles(office).map(r => ({ id: r.id, nama: r.name, jabatan: r.title, ruangan: m.plan.rooms.find(x => x.id === r.room)?.name || r.room, model: r.model, sedang_shift: active.has(r.id), atasan: r.reportsTo || undefined, mode_izin: [...live.values()].find(x => x.office === office && x.role === r.id && x.status !== 'ended')?.permMode || undefined })));
    }
    case 'room_create': {
      if (!role?.isMgr) throw new Error('Hanya manager yang boleh menambah ruangan.');
      const id = addRoom(office, { name: a.name, kind: a.kind || 'kode', path: a.path || '', create: !!a.create });
      bus.emit('msg', { t: 'changed', office, what: 'plan' });
      return text(`Ruangan ${a.name} (${id}) ditambahkan ke denah.`);
    }
    case 'shift_start': {
      if (!role?.isMgr) throw new Error('Hanya manager yang boleh memulai shift role lain.');
      const mode = a.permission_mode || config().defaultPermissionMode || '';
      allowMode(ident, mode);
      const r = startShift(office, a.role, { task: a.task, cardId: a.card_id, permissionMode: a.permission_mode || null });
      return text(`Shift ${a.role} dimulai (tmux ${r.tmux}${mode ? `, mode izin ${mode}` : ''}).`);
    }
    case 'shift_mode': {
      if (!role?.isMgr) throw new Error('Hanya manager yang boleh mengganti mode izin role lain.');
      allowMode(ident, a.permission_mode);
      const target = [...live.values()].find(s => s.office === office && s.role === a.role && s.tmux && s.status !== 'ended');
      if (!target) throw new Error(`${a.role} sedang tidak shift di terminal kantor.`);
      const r = await setPermMode(target.sid, a.permission_mode);
      bus.emit('msg', { t: 'session', office, session: serialize(target) });
      return text(`Mode izin ${a.role} sekarang ${r.mode}.`);
    }
  }
  throw new Error(`Tool tidak dikenal: ${name}`);
}
