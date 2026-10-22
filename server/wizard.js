// "Kantor baru" wizard: preview an office before it exists, then create the folders, team and first steps in one go.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { globalDb, officeDb, all, one, run, nowIso } from './db.js';
import { scanRoot, basePlan, registerOffice, officeModel, invalidate } from './offices.js';
import { roomFor } from './seed.js';
import { createCard, saveWiki } from './store.js';
import { startShift } from './tmux.js';
import { generateFrom, applyTemplate } from './templates.js';

const slugDir = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Folders under the configured roots that are not offices yet, with a short description of what is inside. */
export function wizardFolders() {
  const known = new Set(all(globalDb(), 'SELECT root FROM offices').map(r => r.root));
  const out = [];
  for (const base of config().roots) {
    let names = [];
    try { names = fs.readdirSync(base); } catch {}
    for (const n of names.sort((a, b) => a.localeCompare(b))) {
      const p = path.join(base, n);
      if (n.startsWith('.') || known.has(p)) continue;
      try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
      const scan = scanRoot(p);
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
      out.push({ root: p, name: n, base, git: scan.rootIsGit, repos: scan.repos.length, folders: scan.folders.length,
        stack: scan.repos[0]?.stack || detect(p), md: fs.existsSync(path.join(p, 'CLAUDE.md')), mtime });
    }
  }
  return { roots: config().roots, folders: out };
}
function detect(dir) { const plan = basePlan(dir, { rootIsGit: true, repos: [], folders: [], worktrees: [] }); return plan.rooms.find(r => r.kind === 'kode')?.stack || ''; }

// the folder layout of a project that does not exist yet, shaped like scanRoot() output
function virtualScan(spec) {
  const subs = (spec.subs || []).map(slugDir).filter(Boolean);
  if (spec.layout === 'multi') return { rootIsGit: false, repos: subs.map(dir => ({ dir, stack: '', md: false })), worktrees: [], folders: [] };
  return { rootIsGit: !!spec.gitInit, repos: [], worktrees: [], folders: subs.map(dir => ({ dir, stack: '', md: false })) };
}

function resolveSpec(spec) {
  if (spec.mode === 'existing') {
    const root = path.resolve(String(spec.root || ''));
    if (!config().roots.some(b => root.startsWith(path.resolve(b) + path.sep))) throw new Error('Folder harus berada di salah satu folder induk di Pengaturan');
    if (!fs.existsSync(root)) throw new Error('Folder tidak ada');
    if (one(globalDb(), 'SELECT 1 FROM offices WHERE root = ?', root)) throw new Error('Folder ini sudah jadi kantor');
    return { root, name: path.basename(root), scan: scanRoot(root), exists: true };
  }
  const base = path.resolve(String(spec.base || config().roots[0] || ''));
  if (!config().roots.some(b => path.resolve(b) === base)) throw new Error('Lokasi harus salah satu folder induk di Pengaturan');
  const dir = slugDir(spec.folder || spec.name);
  if (!dir) throw new Error('Nama project wajib diisi');
  const root = path.join(base, dir);
  return { root, name: String(spec.name || dir).trim() || dir, scan: virtualScan(spec), exists: fs.existsSync(root), dir };
}

/** What the office would look like: floor plan, rooms, and where the team would sit. */
export function wizardPreview(spec) {
  const v = resolveSpec(spec);
  const plan = basePlan(v.root, v.scan, []);
  const team = (spec.team || []).map((r, i) => ({ ...r, id: r.id || `r${i}`, room: r.isMgr ? 'manager' : roomFor(plan, r.room) }));
  let withDesks = basePlan(v.root, v.scan, team);
  const warnings = [];
  // the chosen office template, laid over the generated rooms exactly as it will be applied after creation
  if (spec.template) {
    try { const g = generateFrom({ rooms: withDesks.rooms, roles: team.map(t => ({ id: t.id, room: t.room })), extra: [], hidden: [] }, spec.template, spec.seed || 1); withDesks = { ...g.plan, furniture: g.furniture }; }
    catch (e) { warnings.push(`Template tidak bisa dipakai: ${e.message}`); }
  }
  if (spec.mode !== 'existing' && v.exists) warnings.push(`Folder ${v.root} sudah ada. Pilih "Folder yang sudah ada" atau ganti nama.`);
  return { root: v.root, name: v.name, plan: withDesks, team,
    rooms: withDesks.rooms.filter(r => ['kode', 'zone', 'game'].includes(r.kind)).map(r => ({ id: r.id, name: r.name, path: r.path, stack: r.stack || '' })), warnings };
}

const claudeMd = (name, desc, subs) => `# ${name}\n\n${desc ? desc.trim() + '\n\n' : ''}## Struktur\n${subs.length ? subs.map(s => `- \`${s}/\``).join('\n') : '- (satu folder)'}\n\n## Aturan kerja\n- Tulis temuan dan keputusan di kartu board kantor.\n- Tanyakan dulu sebelum menghapus file atau menjalankan perintah yang mengubah data.\n`;

/** Create everything the wizard collected. Returns the new office id. */
export function wizardCreate(spec) {
  const v = resolveSpec(spec);
  const subs = (spec.subs || []).map(slugDir).filter(Boolean);
  const created = [];
  if (spec.mode !== 'existing') {
    if (v.exists) throw new Error(`Folder ${v.root} sudah ada`);
    fs.mkdirSync(v.root, { recursive: true });
    created.push(v.root);
    for (const s of subs) {
      const d = path.join(v.root, s);
      fs.mkdirSync(d, { recursive: true });
      if (spec.layout === 'multi' && spec.gitInit) execFileSync('git', ['init', '-q'], { cwd: d });
      else fs.writeFileSync(path.join(d, '.gitkeep'), '');
      if (spec.layout === 'multi' && spec.claudeMd) fs.writeFileSync(path.join(d, 'CLAUDE.md'), claudeMd(`${v.name} · ${s}`, '', []));
    }
    if (spec.layout !== 'multi' && spec.gitInit) execFileSync('git', ['init', '-q'], { cwd: v.root });
  }
  if (spec.claudeMd && !fs.existsSync(path.join(v.root, 'CLAUDE.md'))) fs.writeFileSync(path.join(v.root, 'CLAUDE.md'), claudeMd(v.name, spec.description, subs));

  const team = (spec.team || []).filter(r => r?.name?.trim());
  const id = registerOffice(v.root, { team: team.length ? team : null });
  if (spec.name && spec.name.trim() !== path.basename(v.root)) run(globalDb(), 'UPDATE offices SET name = ? WHERE id = ?', spec.name.trim(), id);
  invalidate(id);

  const db = officeDb(id), t = nowIso();
  if (spec.description?.trim()) {
    const home = one(db, "SELECT body FROM wiki WHERE slug = 'beranda'")?.body || `# ${v.name}\n`;
    saveWiki(id, { slug: 'beranda', title: 'Beranda', body: home.replace(/\n/, `\n\n## Tentang project\n${spec.description.trim()}\n`), msg: 'Deskripsi dari wizard' }, 'Kamu');
  }
  run(db, 'INSERT INTO news (text, at, author) VALUES (?, ?, ?)', spec.mode === 'existing' ? 'Kantor dibuka untuk project ini.' : 'Project baru dimulai. Selamat datang!', t, 'Sistem');
  const mgr = one(db, 'SELECT id FROM roles WHERE is_mgr = 1 AND archived = 0 ORDER BY ord LIMIT 1');
  let card = null;
  if (spec.firstCard) {
    card = createCard(id, { title: spec.mode === 'existing' ? 'Kenali project dan rapikan board' : 'Rancang struktur awal project', who: mgr?.id || null, prio: 'P1', col: 'Siap',
      desc: [spec.description?.trim(), 'Baca CLAUDE.md dan isi folder, lalu pecah pekerjaan awal jadi kartu untuk tiap role.'].filter(Boolean).join('\n\n'),
      checklist: spec.mode === 'existing' ? ['Baca CLAUDE.md dan README', 'Catat stack dan cara menjalankan di wiki', 'Buat kartu untuk pekerjaan yang terlihat'] : ['Tentukan stack dan struktur folder', 'Tulis cara menjalankan di wiki', 'Buat kartu pekerjaan pertama untuk tiap role'] }, 'Kamu');
  }
  let template = null;
  if (spec.template) {
    try { template = applyTemplate(id, spec.template, spec.seed || 1).template; }
    catch (e) { console.warn('[wizard] template', spec.template, e.message); }
  }
  let shift = null;
  if (spec.startManager && mgr) {
    const brief = spec.brief?.trim() || (card ? `Kerjakan kartu ${card.id}: ${card.title}` : 'Kenali project ini dan susun rencana kerja di board.');
    shift = startShift(id, mgr.id, { task: brief, cardId: card?.id || null, permissionMode: spec.permissionMode || null });
  }
  return { id, created, card: card?.id || null, shift: shift?.sid || null, template };
}
