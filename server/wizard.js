// "Kantor baru" wizard: preview an office before it exists, then create the folders, team and first steps in one go.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { globalDb, officeDb, all, one, run, nowIso } from './db.js';
import { scanRoot, basePlan, registerOffice, officeModel, invalidate, scanRemoteRoot, remoteOffices, makeRemotePlaceholder, markRemoteRooms, cleanRemotePath, machineLabel } from './offices.js';
import * as mx from './machines.js';
import { roomFor } from './seed.js';
import { createCard, saveWiki } from './store.js';
import { startShift } from './tmux.js';
import { generateFrom, applyTemplate } from './templates.js';
import { who } from './actor.js';

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
function virtualScan(spec, remote = false) {
  const subs = (spec.subs || []).map(slugDir).filter(Boolean);
  // folder di mesin lain: jangan biarkan basePlan melihat ke disk Mac ini (path yang sama bisa kebetulan ada di sini)
  const far = remote ? { dirs: subs, rootStack: '', rootMd: false } : {};
  if (spec.layout === 'multi') return { rootIsGit: false, repos: subs.map(dir => ({ dir, stack: '', md: false })), worktrees: [], folders: [], ...far };
  return { rootIsGit: !!spec.gitInit, repos: [], worktrees: [], folders: subs.map(dir => ({ dir, stack: '', md: false })), ...far };
}

/* ---------------- project di mesin lain (docs/MULTI-PC.md) ---------------- */
const isRemoteSpec = spec => !!spec.machine && spec.machine !== mx.LOCAL;
/** Mesin tujuan harus terdaftar, aktif, dan tidak sedang offline. */
function onlineMachine(id) {
  const m = mx.getMachine(id);
  if (!m) throw new Error('Mesin tidak ditemukan. Tambahkan dulu di Pengaturan → Mesin.');
  if (m.disabled) throw new Error(`Mesin ${m.name} sedang dinonaktifkan. Aktifkan dulu di Pengaturan → Mesin.`);
  if (mx.isOffline(id)) throw new Error(`Mesin ${m.name} sedang offline. Pastikan Mac itu menyala dan terhubung (Tailscale), lalu coba lagi.`);
  return m;
}
function absRemote(p, what) {
  const raw = String(p || '').trim();
  if (/[\0\n\r\t]/.test(raw)) throw new Error(`${what} berisi karakter yang tidak valid`);
  const v = cleanRemotePath(raw);
  if (!v) throw new Error(`Pilih ${what.toLowerCase()} dulu`);
  if (!v.startsWith('/')) throw new Error(`${what} harus path absolut, mis. /Users/kamu/Developer/project`);
  if (v === '/') throw new Error('Folder akar (/) tidak bisa jadi kantor');
  return v;
}
// pindaian remote untuk pratinjau disimpan sebentar: pratinjau dipanggil ulang setiap kali tim atau template berubah
const scanCache = new Map();
function remoteScan(machine, root, fresh = false) {
  const k = `${machine}\0${root}`, hit = scanCache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 20000) return hit.scan;
  const scan = scanRemoteRoot(machine, root);
  scanCache.set(k, { at: Date.now(), scan });
  if (scanCache.size > 50) scanCache.delete(scanCache.keys().next().value);
  return scan;
}
function resolveRemote(spec, { fresh = false } = {}) {
  const machine = String(spec.machine);
  onlineMachine(machine);
  const label = machineLabel(machine);
  if (spec.mode === 'existing') {
    const root = absRemote(spec.root, 'Folder project');
    const home = mx.machineHome(machine);
    if (home && cleanRemotePath(home) === root) throw new Error('Folder home tidak bisa jadi kantor. Pilih folder project di dalamnya.');
    if (remoteOffices().some(o => o.machine === machine && o.root === root)) throw new Error('Folder ini sudah jadi kantor');
    const scan = remoteScan(machine, root, fresh);
    if (!scan.exists) throw new Error(`Folder ${root} tidak ada di mesin ${label}`);
    const { exists, ...rest } = scan;
    return { machine, root, name: path.posix.basename(root), scan: rest, exists: true };
  }
  const base = absRemote(spec.base, 'Lokasi');
  const dir = slugDir(spec.folder || spec.name);
  if (!dir) throw new Error('Nama project wajib diisi');
  const root = path.posix.join(base, dir);
  let out;
  try { out = mx.shSync(machine, `if test -d ${mx.q(base)}; then echo B; fi; if test -e ${mx.q(root)}; then echo E; fi; true`, { timeout: 10000 }); }
  catch (e) { throw new Error(`Mesin ${label} tidak terjangkau: ${String(e.stderr || e.message || '').trim().slice(0, 160)}`); }
  if (!/\bB\b/.test(out)) throw new Error(`Lokasi ${base} tidak ada di mesin ${label}`);
  return { machine, root, name: String(spec.name || dir).trim() || dir, scan: virtualScan(spec, true), exists: /\bE\b/.test(out), dir };
}
/** Buat folder project baru di mesin itu: satu panggilan ssh (mkdir, git init, .gitkeep), lalu CLAUDE.md. */
function createRemoteFolders(v, spec, subs) {
  const label = machineLabel(v.machine);
  const git = spec.gitInit ? (mx.ensureProbed(v.machine).git || 'git') : null;
  const gi = d => `${mx.q(git)} -C ${mx.q(d)} init -q`;
  const lines = [`if test -e ${mx.q(v.root)}; then echo EXISTS; exit 0; fi`, `mkdir -p ${mx.q(v.root)}`];
  for (const s of subs) {
    const d = path.posix.join(v.root, s);
    lines.push(`mkdir -p ${mx.q(d)}`, spec.layout === 'multi' && git ? gi(d) : `: > ${mx.q(path.posix.join(d, '.gitkeep'))}`);
  }
  if (spec.layout !== 'multi' && git) lines.push(gi(v.root));
  lines.push('echo DONE');
  let out;
  try { out = mx.shSync(v.machine, `/bin/sh -ec ${mx.q(lines.join('\n'))}`, { timeout: 30000 }); }
  catch (e) {
    if (e.status === 255 || mx.isOffline(v.machine)) throw new Error(`Mesin ${label} tidak terjangkau: ${String(e.stderr || e.message || '').trim().slice(0, 160)}`);
    throw new Error(`Gagal membuat folder di ${label}: ${String(e.stderr || e.message || '').trim().slice(0, 200)}`);
  }
  if (/EXISTS/.test(out)) throw new Error(`Folder ${v.root} sudah ada di mesin ${label}`);
  if (!/DONE/.test(out)) throw new Error(`Gagal membuat folder di ${label}`);
  if (spec.layout === 'multi' && spec.claudeMd) for (const s of subs) mx.writeFile(v.machine, path.posix.join(v.root, s, 'CLAUDE.md'), claudeMd(`${v.name} · ${s}`, '', []), 0o644);
}

function resolveSpec(spec, opts) {
  if (isRemoteSpec(spec)) return resolveRemote(spec, opts);
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
  if (spec.mode !== 'existing' && v.exists) warnings.push(`Folder ${v.root} sudah ada${v.machine ? ` di mesin ${machineLabel(v.machine)}` : ''}. Pilih "Folder yang sudah ada" atau ganti nama.`);
  if (v.machine) markRemoteRooms(withDesks, v);
  return { root: v.root, name: v.name, plan: withDesks, team, ...(v.machine ? { machine: v.machine, machineName: machineLabel(v.machine) } : {}),
    rooms: withDesks.rooms.filter(r => ['kode', 'zone', 'game'].includes(r.kind)).map(r => ({ id: r.id, name: r.name, path: r.path, stack: r.stack || '', ...(r.machine ? { machine: r.machine, remotePath: r.remotePath } : {}) })), warnings };
}

const claudeMd = (name, desc, subs) => `# ${name}\n\n${desc ? desc.trim() + '\n\n' : ''}## Struktur\n${subs.length ? subs.map(s => `- \`${s}/\``).join('\n') : '- (satu folder)'}\n\n## Aturan kerja\n- Tulis temuan dan keputusan di kartu board kantor.\n- Tanyakan dulu sebelum menghapus file atau menjalankan perintah yang mengubah data.\n`;

/** Create everything the wizard collected. Returns the new office id. */
export function wizardCreate(spec) {
  const v = resolveSpec(spec, { fresh: true });
  const subs = (spec.subs || []).map(slugDir).filter(Boolean);
  const created = [];
  const team = (spec.team || []).filter(r => r?.name?.trim());
  let id;
  if (v.machine) {
    // project di mesin lain: folder dibuat atau dibaca di sana; hub hanya memegang placeholder kosong (jangan pernah registerOffice(path remote))
    if (spec.mode !== 'existing') {
      if (v.exists) throw new Error(`Folder ${v.root} sudah ada di mesin ${machineLabel(v.machine)}`);
      createRemoteFolders(v, spec, subs);
      created.push(v.root);
    }
    let scan = v.scan;
    if (spec.mode !== 'existing') { const s = remoteScan(v.machine, v.root, true); if (s.exists) { const { exists, ...rest } = s; scan = rest; } }
    if (spec.claudeMd && !scan.rootMd) { mx.writeFile(v.machine, path.posix.join(v.root, 'CLAUDE.md'), claudeMd(v.name, spec.description, subs), 0o644); scan = { ...scan, rootMd: true }; }
    const holder = makeRemotePlaceholder(path.posix.basename(v.root));
    try { id = registerOffice(holder, { team: team.length ? team : null, remote: { machine: v.machine, root: v.root, scan } }); }
    catch (e) { try { fs.rmdirSync(holder); } catch {} throw e; }
    const name = (spec.mode === 'existing' ? '' : String(spec.name || '').trim()) || path.posix.basename(v.root);
    run(globalDb(), 'UPDATE offices SET name = ? WHERE id = ?', name, id);
    // ruangan berfolder juga dicatat sebagai override meta 'rooms' (path null, machine, remotePath), bentuk yang sama dengan
    // ruangan hasil scan yang dipindah ke mesin lain, supaya pembaca meta (mis. lencana mesin di kantor-mesin.js) mengenalinya
    const ov = {};
    for (const r of officeModel(id).plan.rooms) if (r.machine === v.machine && r.remotePath) ov[r.id] = { path: null, machine: r.machine, remotePath: r.remotePath, stack: r.stack || '' };
    if (Object.keys(ov).length) run(officeDb(id), "INSERT INTO meta (key, value) VALUES ('rooms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(ov));
  } else id = createLocal(v, spec, subs, created, team);
  return finishCreate(id, v, spec, created);
}

function createLocal(v, spec, subs, created, team) {
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

  const id = registerOffice(v.root, { team: team.length ? team : null });
  if (spec.name && spec.name.trim() !== path.basename(v.root)) run(globalDb(), 'UPDATE offices SET name = ? WHERE id = ?', spec.name.trim(), id);
  return id;
}

function finishCreate(id, v, spec, created) {
  invalidate(id);

  const db = officeDb(id), t = nowIso();
  if (spec.description?.trim()) {
    const home = one(db, "SELECT body FROM wiki WHERE slug = 'beranda'")?.body || `# ${v.name}\n`;
    saveWiki(id, { slug: 'beranda', title: 'Beranda', body: home.replace(/\n/, `\n\n## Tentang project\n${spec.description.trim()}\n`), msg: 'Deskripsi dari wizard' }, who());
  }
  run(db, 'INSERT INTO news (text, at, author) VALUES (?, ?, ?)', spec.mode === 'existing' ? 'Kantor dibuka untuk project ini.' : 'Project baru dimulai. Selamat datang!', t, 'Sistem');
  const mgr = one(db, 'SELECT id FROM roles WHERE is_mgr = 1 AND archived = 0 ORDER BY ord LIMIT 1');
  let card = null;
  if (spec.firstCard) {
    card = createCard(id, { title: spec.mode === 'existing' ? 'Kenali project dan rapikan board' : 'Rancang struktur awal project', who: mgr?.id || null, prio: 'P1', col: 'Siap',
      desc: [spec.description?.trim(), 'Baca CLAUDE.md dan isi folder, lalu pecah pekerjaan awal jadi kartu untuk tiap role.'].filter(Boolean).join('\n\n'),
      checklist: spec.mode === 'existing' ? ['Baca CLAUDE.md dan README', 'Catat stack dan cara menjalankan di wiki', 'Buat kartu untuk pekerjaan yang terlihat'] : ['Tentukan stack dan struktur folder', 'Tulis cara menjalankan di wiki', 'Buat kartu pekerjaan pertama untuk tiap role'] }, who());
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
