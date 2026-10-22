import { officeDb, run, one, nowIso } from './db.js';

const SKINS = ['#F1C9A5', '#D9A47C', '#B97E57', '#8D5A3B', '#E8B98F'];
const HAIRS = ['#2B1D14', '#5A3A22', '#1E1E24', '#7A4B2A', '#C9A15A', '#3D2B4F'];
const COLORS = ['#2F5D9E', '#2C8452', '#A9620F', '#7A3E9D', '#BC3B34', '#1C7379', '#55606E'];
const MANAGERS = ['Bu Ratna', 'Pak Hendra', 'Bu Sari', 'Pak Bima', 'Bu Laras', 'Pak Danu'];

// default looks, aligned with MANAGERS / the generalist names below (Bu = feminine)
const MGR_LOOKS = [{ hairStyle: 'bun', outfit: 'jas', acc: 'anting' }, { hairStyle: 'short', outfit: 'jas', tie: true }, { hairStyle: 'hijab', outfit: 'jas', hijab: '#DCE6F5' }, { hairStyle: 'short', outfit: 'jas', tie: true, acc: 'kacamata' }, { hairStyle: 'bob', outfit: 'jas', acc: 'kacamata' }, { hairStyle: 'short', outfit: 'jas', tie: true }];
const GEN_LOOKS = [{ hairStyle: 'ponytail', outfit: 'rok' }, { hairStyle: 'short' }, { hairStyle: 'pigtails', outfit: 'dress', acc: 'anting' }, { hairStyle: 'short', outfit: 'hoodie' }, { hairStyle: 'curly', outfit: 'rok', acc: 'kacamata' }, { hairStyle: 'short', acc: 'topi' }];
const OUTFITS = ['kemeja', 'rok', 'dress', 'hoodie', 'jas'], ACCS = ['', 'kacamata', 'anting', 'topi'];

const h = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export function insertRole(db, r, ord) {
  run(db, `INSERT INTO roles (id, name, title, model, room, color, hair, skin, hair_style, tie, is_mgr, persona, skills, notes, created_at, ord, outfit, acc, hijab)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.id, r.name, r.title, r.model, r.room, r.color, r.hair, r.skin, r.hairStyle || 'short', r.tie ? 1 : 0, r.isMgr ? 1 : 0,
    r.persona || '', JSON.stringify(r.skills || []), r.notes || '', nowIso(), ord, r.outfit || 'kemeja', r.acc || '', r.hijab || '#E8EEF8');
}

const RAIL_ROLES = [
  { id: 'kondektur', name: 'Pak Kondektur', title: 'Manager', model: 'opus', room: 'manager', color: '#2F5D9E', hair: '#2B1D14', skin: '#D9A47C', outfit: 'jas', tie: true, isMgr: true,
    persona: 'Tenang dan teliti, tidak suka buru-buru. Bekerja dari folder induk dan bisa membaca semua repo. Memecah pekerjaan jadi kartu di board, menunjuk role yang tepat, dan mereview hasil. Selalu mengingatkan bahwa DB lokal adalah prod.',
    skills: ['delegasi', 'review', 'checklist-rilis', 'kontrak-api'] },
  { id: 'dina', name: 'Dina', title: 'Flutter Dev', model: 'sonnet', room: 'mobile', color: '#2C8452', hair: '#5A3A22', skin: '#F1C9A5', hairStyle: 'hijab', hijab: '#DCE6F5', outfit: 'rok',
    persona: 'Rapi dan cepat. Commit langsung ke main (bukan feature branch), selalu bump versi di tiga tempat (pubspec, build.gradle, app_constants), dan mengikuti template clean architecture di lib/features/_template.',
    skills: ['flutter', 'clean-architecture', 'bump-versi', 'rilis-play'] },
  { id: 'bayu', name: 'Bayu', title: 'Laravel Dev', model: 'sonnet', room: 'web', color: '#A9620F', hair: '#1E1E24', skin: '#B97E57',
    persona: 'Pragmatis, menulis catatan jelas di kartu. Tidak pernah menjalankan phpunit. Ingat bahwa DB lokal adalah prod dan scheduler jalan tiap 5 menit, jadi semua penulisan ke DB harus dikonfirmasi dulu.',
    skills: ['laravel', 'payment-flow', 'deploy-web'] },
  { id: 'rara', name: 'Rara', title: 'Go Backend', model: 'sonnet', room: 'ltc', color: '#1C7379', hair: '#1E1E24', skin: '#D9A47C', hairStyle: 'ponytail', acc: 'kacamata',
    persona: 'Pendiam, sangat teliti soal GPS dan geometri rel. Menulis tes dulu sebelum kode.', skills: ['go', 'osm-geometry', 'live-gps'] },
  { id: 'seno', name: 'Seno', title: 'QA', model: 'haiku', room: 'qa', color: '#7A3E9D', hair: '#7A4B2A', skin: '#F1C9A5',
    persona: 'Skeptis. Menganggap semua fitur rusak sampai terbukti sebaliknya. Menjalankan tes, membaca diff, dan selalu cek log 404 setelah deploy. Menulis temuan sebagai komentar di kartu.', skills: ['flutter-test', 'code-review', 'cek-404'] },
  { id: 'raka', name: 'Raka', title: 'DevOps', model: 'sonnet', room: 'server', color: '#55606E', hair: '#2B1D14', skin: '#8D5A3B',
    persona: 'Berhati-hati. Selalu minta izin sebelum menyentuh prod. Untuk deploy PPKA: upload aset dulu, index.html paling akhir, lalu cek log 404.', skills: ['ssh', 'rsync-deploy', 'backup', 'nginx'] },
  { id: 'arif', name: 'Arif', title: 'Game Dev PPKA', model: 'sonnet', room: 'ppka', color: '#2F5D9E', hair: '#C9A15A', skin: '#E8B98F',
    persona: 'Suka detail persinyalan. Tidak pernah deploy sendiri, selalu lewat Raka.', skills: ['game-ui', 'persinyalan'] },
];

const RAIL_WIKI = `# Aturan Kantor 168Railway

Aturan yang wajib diikuti semua role. Diambil dari pengalaman sebelumnya.

## Database dan data
- **DB lokal = PROD.** Scheduler \`simulation:generate\` jalan tiap 5 menit dari DB; menulis ke DB berarti langsung tayang. Konfirmasi dulu sebelum menulis.
- Jangan jalankan \`phpunit\`.

## Mobile (Flutter)
- Commit langsung ke \`main\`, bukan feature branch.
- Bump versi di **tiga tempat**: \`pubspec.yaml\`, \`build.gradle\` (hardcode), dan \`app_constants\`.
- Ikuti clean architecture feature-first; template ada di \`lib/features/_template\`.

## Deploy PPKA
1. Upload semua aset (CSS/JS) dulu.
2. Upload \`index.html\` paling akhir.
3. Cek semua aset terbuka dan log 404 bersih.

## Live tracking
- \`android-lite\` bukan acuan UI. Acuan ada di \`android-live\`.
`;

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const slugId = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Room id a team member asked for: a room id, a folder path, or the first code room. */
export function roomFor(plan, want) {
  const code = plan.rooms.find(r => r.kind === 'kode')?.id || 'manager';
  if (!want) return code;
  return (plan.rooms.find(r => r.id === want) || plan.rooms.find(r => r.path === want))?.id || code;
}

/** A team member from the new-office wizard, cleaned into a role row. */
function teamRole(r, i, plan, taken) {
  let id = slugId(r.name) || `role${i}`;
  while (taken.has(id)) id += '2';
  taken.add(id);
  return { id, name: String(r.name).trim().slice(0, 40), title: String(r.title || 'Generalis').slice(0, 40), model: MODELS.includes(r.model) ? r.model : 'sonnet',
    room: r.isMgr ? 'manager' : roomFor(plan, r.room), color: r.color || COLORS[i % COLORS.length], hair: r.hair || HAIRS[i % HAIRS.length], skin: r.skin || SKINS[i % SKINS.length],
    hairStyle: r.hairStyle || 'short', outfit: OUTFITS.includes(r.outfit) ? r.outfit : 'kemeja', acc: ACCS.includes(r.acc) ? r.acc : '', hijab: /^#[0-9a-f]{6}$/i.test(r.hijab) ? r.hijab : '#E8EEF8', tie: r.tie !== undefined ? !!r.tie : !!r.isMgr, isMgr: !!r.isMgr, persona: String(r.persona || '').slice(0, 2000), skills: (r.skills || []).slice(0, 12).map(String) };
}

export function seedOffice(id, model, team = null) {
  const db = officeDb(id);
  if (one(db, 'SELECT 1 FROM roles LIMIT 1')) return;
  const rooms = model.plan.rooms;
  const isRail = rooms.some(r => r.id === 'openplan') && rooms.some(r => r.id === 'ltc');
  const t = nowIso();
  if (isRail) {
    RAIL_ROLES.forEach((r, i) => insertRole(db, r, i));
    for (const n of ['DB lokal = PROD. simulation:generate jalan tiap 5 menit dan langsung tayang.', 'Jangan jalankan phpunit.'])
      run(db, 'INSERT INTO news (text, at, author) VALUES (?, ?, ?)', n, t, 'Sistem');
    run(db, 'INSERT INTO wiki (slug, title, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'aturan-kantor', 'Aturan Kantor', RAIL_WIKI, 'Sistem', t, t);
    run(db, 'INSERT INTO wiki_revs (slug, title, body, author, at, msg) VALUES (?, ?, ?, ?, ?, ?)', 'aturan-kantor', 'Aturan Kantor', RAIL_WIKI, 'Sistem', t, 'Halaman awal');
  } else if (team?.length) {
    const taken = new Set();
    // the manager first, so it gets the first spot in the strip
    [...team].sort((a, b) => !!b.isMgr - !!a.isMgr).forEach((r, i) => insertRole(db, teamRole(r, i, model.plan, taken), i));
  } else {
    const k = h(id);
    const code = rooms.find(r => r.kind === 'kode') || rooms.find(r => r.kind !== 'lobby');
    insertRole(db, { id: 'manager', name: MANAGERS[k % MANAGERS.length], title: 'Manager', model: 'opus', room: 'manager', color: COLORS[k % COLORS.length], hair: HAIRS[k % HAIRS.length], skin: SKINS[k % SKINS.length], tie: false, ...MGR_LOOKS[k % 6], isMgr: true,
      persona: 'Teliti dan tenang. Memecah permintaan jadi kartu di board, menunjuk role yang tepat, dan mereview hasilnya sebelum dianggap selesai.', skills: ['delegasi', 'review'] }, 0);
    insertRole(db, { id: 'generalis', name: ['Tari', 'Dimas', 'Wulan', 'Arya', 'Lintang', 'Kiko'][k % 6], title: 'Generalis', model: 'sonnet', room: code.id, color: COLORS[(k + 3) % COLORS.length], hair: HAIRS[(k + 2) % HAIRS.length], skin: SKINS[(k + 1) % SKINS.length], ...GEN_LOOKS[k % 6],
      persona: 'Serba bisa dan cepat belajar. Membaca CLAUDE.md dan wiki kantor sebelum mulai.', skills: [] }, 1);
  }
  const repos = rooms.filter(r => r.kind === 'kode' || r.kind === 'zone' || r.kind === 'game').map(r => `- **${r.name}**${r.path ? ` — \`${r.path}/\`` : ''}${r.stack ? ` (${r.stack})` : ''}`).join('\n');
  const home = `# ${model.name}\n\nSelamat datang di wiki kantor. Halaman ini bisa dibaca dan diubah oleh kamu maupun para role (lewat MCP kantor).\n\n## Ruangan\n${repos || '- (belum ada)'}\n\n## Halaman penting\n- [[Aturan Kantor]]\n- [[Runbook Deploy]]\n`;
  run(db, 'INSERT OR IGNORE INTO wiki (slug, title, body, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'beranda', 'Beranda', home, 'Sistem', t, t);
  run(db, 'INSERT INTO wiki_revs (slug, title, body, author, at, msg) VALUES (?, ?, ?, ?, ?, ?)', 'beranda', 'Beranda', home, 'Sistem', t, 'Halaman awal');
}
