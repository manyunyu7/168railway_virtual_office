import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { config, saveConfig, loadConfig, SERVER_JSON, ROOT_DIR, CLAUDE_DIR } from './config.js';
import { globalDb, officeDb, all, one, run, closeAll } from './db.js';
import { listOffices, officeModel, registerOffice, candidateFolders, invalidate, addRoom, updateRoom, scanRoot, browseFolder, previewRoom, roomForCwd } from './offices.js';
import { bus, handleHook, decide, openInbox, liveFor, live, serialize, whoOf } from './live.js';
import * as st from './store.js';
import { startShift, sessionAction, adoptSession, setPermMode, paneMode, adoptRunning, adoptManual, ensureShell, tmux, bins, hasTmux, capture, globalHooksInstalled, hookSettings } from './tmux.js';
import { payroll, scanUsage, setBudget, monthCost, currentMonth } from './payroll.js';
import { listMeetings, getMeeting, startMeeting, cancelMeeting, interject, actionToCard, resumeMeeting, markInterrupted } from './meetings.js';
import { TOOLS, callTool, resolveIdentity } from './agent.js';
import { readTranscript } from './transcript.js';
import { scanProcesses } from './procscan.js';
import { wizardFolders, wizardPreview, wizardCreate } from './wizard.js';
import { listDir, findFiles, readText, sendRaw, upload, makeDir } from './files.js';

const cfg = loadConfig();
const WEB = path.join(ROOT_DIR, 'web');
const VENDOR = { '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css', '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

/* ---------------- auth ---------------- */
const allowedHosts = () => new Set(['127.0.0.1', 'localhost', ...cfg.extraHosts].flatMap(h => [h, `${h}:${cfg.port}`]));
function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const c = /(?:^|;\s*)kc_token=([^;]+)/.exec(req.headers.cookie || '');
  return c ? decodeURIComponent(c[1]) : null;
}
function authed(req) {
  if (!allowedHosts().has(req.headers.host)) return false;
  return tokenOf(req) === cfg.token;
}

/* ---------------- tiny router ---------------- */
const routes = [];
const route = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
};
async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 5e6) throw new Error('Body terlalu besar'); }
  return s ? JSON.parse(s) : {};
}
function send(res, code, data) {
  const s = JSON.stringify(data ?? null);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
const O = id => { if (id !== '_kompleks' && !one(globalDb(), 'SELECT 1 FROM offices WHERE id = ?', id)) throw Object.assign(new Error('Kantor tidak ditemukan'), { code: 404 }); return id; };

/* ---------------- routes ---------------- */
route('POST', '/api/hook', async (req, res) => send(res, 200, await handleHook(await body(req))));

route('GET', '/api/state', () => {
  const offices = listOffices().map(o => {
    const sessions = liveFor(o.id);
    let roles = 0, cards = { open: 0, blocked: 0, done: 0 };
    try {
      const db = officeDb(o.id);
      roles = one(db, 'SELECT COUNT(*) n FROM roles WHERE archived = 0').n;
      cards = one(db, "SELECT SUM(col < 4) open, SUM(blocked <> '' AND col < 4) blocked, SUM(col = 4) done FROM cards WHERE archived = 0");
    } catch {}
    let roleRows = [];
    try { roleRows = st.listRoles(o.id); } catch {}
    const look = s => { const r = roleRows.find(x => x.id === s.role); return r ? { name: r.name + (s.slot ? ` #${s.slot + 1}` : ''), color: r.color, hair: r.hair, skin: r.skin, hairStyle: r.hairStyle, tie: r.tie, title: r.title } : null; };
    return { id: o.id, name: o.name, root: o.root, fav: !!o.fav, style: o.style || officeModel(o.id)?.style,
      sessions: sessions.map(s => ({ sid: s.sid, role: s.role, status: s.status, title: s.title, kind: s.kind, room: s.room, tool: s.tool, waiting: s.waiting, look: look(s), lastSeen: s.lastSeen, permMode: s.permMode || null, host: s.host || null, tty: s.tty || null })),
      roles, cards, monthCost: monthCost(o.id), lastSeen: one(globalDb(), 'SELECT MAX(last_seen) t FROM sessions WHERE office = ?', o.id)?.t || o.created_at };
  });
  // sessions outside every office (e.g. claude started in ~/Developer itself)
  const loose = [...live.values()].filter(s => !s.office && s.status !== 'ended').map(s => ({ sid: s.sid, status: s.status, title: s.title, cwd: s.cwd, tool: s.tool, waiting: s.waiting, lastSeen: s.lastSeen, tty: s.tty || null, host: s.host || null }));
  return { loose, offices, repoDir: ROOT_DIR, inbox: openInbox(), hooks: globalHooksInstalled(), tmux: !!bins().tmux, claude: !!bins().claude, settings: { approvals: cfg.approvals, roots: cfg.roots, extraHosts: cfg.extraHosts, defaultPermissionMode: cfg.defaultPermissionMode || '' } };
});
route('GET', '/api/candidates', () => candidateFolders());
route('GET', '/api/wizard/folders', () => wizardFolders());
route('POST', '/api/wizard/preview', async req => wizardPreview(await body(req)));
route('POST', '/api/wizard/create', async req => { const r = wizardCreate(await body(req)); bus.emit('msg', { t: 'changed', office: '*', what: 'offices' }); return r; });
route('POST', '/api/offices', async req => { const b = await body(req); if (!b.root || !fs.existsSync(b.root)) throw new Error('Folder tidak ada'); return { id: registerOffice(b.root) }; });
route('POST', '/api/offices/:id/fav', async (req, res, p) => { const b = await body(req); run(globalDb(), 'UPDATE offices SET fav = ? WHERE id = ?', b.fav ? 1 : 0, O(p.id)); bus.emit('msg', { t: 'changed', office: '*', what: 'offices' }); return { ok: true }; });
route('POST', '/api/offices/:id/hide', async (req, res, p) => { run(globalDb(), 'UPDATE offices SET hidden = 1 WHERE id = ?', O(p.id)); bus.emit('msg', { t: 'changed', office: '*', what: 'offices' }); return { ok: true }; });
route('POST', '/api/offices/:id/rescan', (req, res, p) => { invalidate(O(p.id)); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return { ok: true }; });

route('GET', '/api/offices/:id', (req, res, p) => {
  const m = officeModel(O(p.id));
  return { id: m.id, name: m.name, root: m.root, style: m.style, plan: m.plan, roles: st.listRoles(p.id), sessions: liveFor(p.id), news: st.listNews(p.id), log: st.listLog(p.id, 60),
    wall: st.listNotes(p.id).filter(n => n.wall).slice(0, 6), cards: st.listCards(p.id).map(c => ({ id: c.id, title: c.title, col: c.col, who: c.who, repo: c.repo, blocked: c.blocked })) };
});

/* rooms */
route('GET', '/api/offices/:id/folders', (req, res, p) => {
  const m = officeModel(O(p.id));
  const used = new Set(m.plan.rooms.flatMap(r => [r.path, ...(r.aliases || []), ...(r.worktrees || [])]).filter(Boolean));
  const s = scanRoot(m.root);
  return [...s.repos, ...s.folders].map(f => ({ dir: f.dir, stack: f.stack, used: used.has(f.dir) }));
});
/* file manager */
route('GET', '/api/offices/:id/files', (req, res, p, q) => q.get('q') ? { results: findFiles(O(p.id), q.get('path') || '', q.get('q')) } : listDir(O(p.id), q.get('path') || '', { all: q.get('all') === '1' }));
route('GET', '/api/offices/:id/files/read', (req, res, p, q) => readText(O(p.id), q.get('path') || ''));
route('GET', '/api/offices/:id/files/raw', (req, res, p, q) => { sendRaw(O(p.id), q.get('path') || '', res, q.get('dl') === '1'); });
route('POST', '/api/offices/:id/files/upload', async (req, res, p, q) => { const r = await upload(O(p.id), q.get('path') || '', q.get('name') || '', req); bus.emit('msg', { t: 'files', office: p.id, path: q.get('path') || '' }); return r; });
route('POST', '/api/offices/:id/files/mkdir', async (req, res, p) => { const b = await body(req); const r = makeDir(O(p.id), b.path || '', b.name); bus.emit('msg', { t: 'files', office: p.id, path: b.path || '' }); return r; });
route('GET', '/api/offices/:id/browse', (req, res, p, q) => browseFolder(O(p.id), q.get('dir') || ''));
route('POST', '/api/offices/:id/rooms/preview', async (req, res, p) => {
  const { model, room } = previewRoom(O(p.id), await body(req));
  const cur = officeModel(p.id);
  // live sessions whose folder would now belong to the new room
  const moved = liveFor(p.id).filter(s => s.cwd && room.path && roomForCwd(model, s.cwd).room === '__pv')
    .map(s => ({ sid: s.sid, role: s.role, title: s.title, from: cur.plan.rooms.find(r => r.id === s.room)?.name || s.room || null }));
  return { plan: model.plan, room, moved };
});
route('POST', '/api/offices/:id/rooms', async (req, res, p) => { const rid = addRoom(O(p.id), await body(req)); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return { id: rid }; });
route('PATCH', '/api/offices/:id/rooms/:rid', async (req, res, p) => { updateRoom(O(p.id), p.rid, await body(req)); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return { ok: true }; });

/* board */
route('GET', '/api/offices/:id/board', (req, res, p) => ({ cols: st.COLS, cards: st.listCards(O(p.id)) }));
route('GET', '/api/offices/:id/cards/:cid', (req, res, p) => st.getCard(O(p.id), p.cid));
route('POST', '/api/offices/:id/cards', async (req, res, p) => st.createCard(O(p.id), await body(req), 'Kamu'));
route('PATCH', '/api/offices/:id/cards/:cid', async (req, res, p) => { const b = await body(req); if (b.who) b.whoName = st.getRole(p.id, b.who)?.name; return st.updateCard(O(p.id), p.cid, b, 'Kamu'); });
route('DELETE', '/api/offices/:id/cards/:cid', (req, res, p) => { st.archiveCard(O(p.id), p.cid, 'Kamu'); return { ok: true }; });
route('POST', '/api/offices/:id/cards/:cid/check', async (req, res, p) => st.checkItem(O(p.id), p.cid, await body(req), 'Kamu'));
route('POST', '/api/offices/:id/cards/:cid/comment', async (req, res, p) => {
  const b = await body(req);
  const c = st.commentCard(O(p.id), p.cid, b.text, 'Kamu');
  // forward the comment to the assignee's running session, if any
  if (b.notify && c.who) {
    const s = [...live.values()].find(x => x.office === p.id && x.role === c.who && x.status !== 'ended' && (x.tmux || x.tty));
    if (s) sessionAction(s.sid, 'text', `(Komentar baru di kartu ${c.id} "${c.title}") ${b.text}`).catch(() => {});
  }
  return c;
});
route('POST', '/api/offices/:id/cards/:cid/split', async (req, res, p) => {
  const c = st.getCard(O(p.id), p.cid);
  const b = await body(req);
  const parts = (b.parts?.length ? b.parts : c.checklist.filter(x => !x.done).map(x => x.text)).slice(0, 8);
  if (!parts.length) throw new Error('Tidak ada bagian untuk dipecah. Isi checklist dulu.');
  for (const t of parts) st.createCard(p.id, { title: t, who: c.who, repo: c.repo, prio: c.prio, epicId: c.id }, 'Kamu');
  return st.getCard(p.id, c.id);
});

/* roles + sessions */
route('GET', '/api/offices/:id/roles', (req, res, p) => st.listRoles(O(p.id), { archived: true }));
route('POST', '/api/offices/:id/roles', async (req, res, p) => { const r = st.createRole(O(p.id), await body(req)); invalidate(p.id); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return r; });
route('PATCH', '/api/offices/:id/roles/:rid', async (req, res, p) => { const r = st.updateRole(O(p.id), p.rid, await body(req)); invalidate(p.id); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return r; });
route('POST', '/api/offices/:id/roles/:rid/start', async (req, res, p) => {
  const b = await body(req);
  const r = startShift(O(p.id), p.rid, { task: b.task, cardId: b.cardId, worktree: !!b.worktree, resumeSid: b.resumeSid, permissionMode: b.permissionMode });
  if (b.cardId) st.updateCard(p.id, b.cardId, { col: 2 }, 'Kamu');
  return r;
});
route('POST', '/api/sessions/:sid/action', async (req, res, p) => { const b = await body(req); return { ok: true, ...(await sessionAction(p.sid, b.action, b.text)) }; });
// sessions whose terminal was closed recently: they can be picked up again in the office
route('GET', '/api/sessions/recent-ended', () => {
  const rows = all(globalDb(), `SELECT s.sid, s.office, s.role, s.room, s.title, s.first_prompt, s.cwd, s.ended_at, s.last_seen, s.transcript, o.name office_name
    FROM sessions s JOIN offices o ON o.id = s.office
    WHERE s.ended_at IS NOT NULL AND s.ended_at > ? AND COALESCE(s.source, '') <> 'rapat' ORDER BY s.ended_at DESC LIMIT 30`, new Date(Date.now() - 3 * 864e5).toISOString());
  return rows.filter(r => !live.has(r.sid) && r.transcript && fs.existsSync(r.transcript)).slice(0, 8).map(({ transcript, ...r }) => r);
});
route('POST', '/api/sessions/:sid/mode', async (req, res, p) => { const b = await body(req); const r = await setPermMode(p.sid, b.mode); const s = live.get(p.sid); if (s) bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); return r; });
route('POST', '/api/sessions/:sid/adopt', async (req, res, p) => { const b = await body(req); return adoptSession(p.sid, b.role || null, b.permissionMode || null, b.newRole || null); });
route('GET', '/api/sessions/:sid/transcript', (req, res, p, q) => {
  const s = live.get(p.sid);
  const file = s?.transcript || one(globalDb(), 'SELECT transcript FROM sessions WHERE sid = ?', p.sid)?.transcript;
  return readTranscript(file, Number(q.get('n')) || 120);
});
route('GET', '/api/sessions/:sid/peek', (req, res, p) => { const s = live.get(p.sid); return { text: s?.tmux && hasTmux(s.tmux) ? capture(s.tmux, 120) : '' }; });
route('GET', '/api/offices/:id/archive', (req, res, p) => {
  O(p.id);
  const rows = all(globalDb(), `SELECT s.sid, s.role, s.room, s.title, s.first_prompt, s.started_at, s.ended_at, s.last_seen, s.source, s.tmux,
      (SELECT SUM(cost) FROM usage u WHERE u.sid = s.sid) cost, (SELECT SUM(output) FROM usage u WHERE u.sid = s.sid) output
    FROM sessions s WHERE s.office = ? ORDER BY s.last_seen DESC LIMIT 150`, p.id);
  const active = new Set(liveFor(p.id).map(s => s.sid));
  return rows.map(r => ({ ...r, active: active.has(r.sid) }));
});

/* inbox */
route('GET', '/api/inbox', () => openInbox());
route('POST', '/api/inbox/:iid', async (req, res, p) => { const b = await body(req); decide(p.iid, b.behavior === 'allow' ? 'allow' : 'deny', b.message); return { ok: true }; });

/* notes */
route('GET', '/api/offices/:id/notes', (req, res, p, q) => ({ notes: st.listNotes(O(p.id), { q: q.get('q') || '', tag: q.get('tag') || '', view: q.get('view') || 'aktif' }), tags: st.noteTags(p.id) }));
route('POST', '/api/offices/:id/notes', async (req, res, p) => st.saveNote(O(p.id), await body(req), 'Kamu'));
route('DELETE', '/api/offices/:id/notes/:nid', (req, res, p) => { st.purgeNote(O(p.id), p.nid); return { ok: true }; });
route('POST', '/api/offices/:id/notes/:nid/to-card', async (req, res, p) => {
  const n = st.getNote(O(p.id), p.nid);
  const b = await body(req);
  const items = [...n.body.matchAll(/^\s*[-*] \[( |x)\] (.+)$/gim)].map(m => ({ done: m[1] !== ' ', text: m[2].trim() }));
  if (b.mode === 'each') {
    const open = items.filter(i => !i.done);
    if (!open.length) throw new Error('Tidak ada checklist yang belum dicentang di catatan ini');
    const made = open.map(i => st.createCard(p.id, { title: i.text, desc: `Dari catatan: ${n.title || 'tanpa judul'}`, who: b.who || null, repo: b.repo || '' }, 'Kamu').id);
    return { cards: made };
  }
  const body2 = n.body.replace(/^\s*[-*] \[( |x)\] .+$/gim, '').trim();
  const c = st.createCard(p.id, { title: n.title || n.body.split('\n')[0].slice(0, 100) || 'Dari catatan', desc: body2, who: b.who || null, repo: b.repo || '', checklist: items.filter(i => !i.done).map(i => i.text) }, 'Kamu');
  return { cards: [c.id] };
});
route('POST', '/api/offices/:id/notes/:nid/send-role', async (req, res, p) => {
  const n = st.getNote(O(p.id), p.nid);
  const b = await body(req);
  const r = st.getRole(p.id, b.role);
  if (!r) throw new Error('Role tidak ditemukan');
  st.writeRoleNotes(p.id, r.id, `\n## Dari catatan "${n.title || 'tanpa judul'}" (${new Date().toLocaleDateString('id-ID')})\n${n.body}`, 'append', 'Kamu');
  const s = [...live.values()].find(x => x.office === p.id && x.role === r.id && x.status !== 'ended' && (x.tmux || x.tty));
  if (s && b.live) sessionAction(s.sid, 'text', `Catatan dari pemilik kantor: ${n.title ? n.title + ' — ' : ''}${n.body.replace(/\s+/g, ' ').slice(0, 1500)}`).catch(() => {});
  return { ok: true, live: !!s };
});

/* wiki */
route('GET', '/api/offices/:id/wiki', (req, res, p) => st.listWiki(O(p.id)));
route('GET', '/api/offices/:id/wiki/page', (req, res, p, q) => st.getWiki(O(p.id), q.get('ref') || 'beranda'));
route('POST', '/api/offices/:id/wiki', async (req, res, p) => st.saveWiki(O(p.id), await body(req), 'Kamu'));
route('DELETE', '/api/offices/:id/wiki/:slug', (req, res, p) => { st.deleteWiki(O(p.id), p.slug); return { ok: true }; });
route('GET', '/api/offices/:id/wiki-search', (req, res, p, q) => st.searchWiki(O(p.id), q.get('q')));
route('GET', '/api/offices/:id/wiki-revs/:slug', (req, res, p) => st.wikiRevs(O(p.id), p.slug));
route('GET', '/api/offices/:id/wiki-rev/:rid', (req, res, p) => st.wikiRev(O(p.id), Number(p.rid)));
route('GET', '/api/offices/:id/wiki-sources', (req, res, p) => p.id === '_kompleks' ? [] : st.wikiSources(O(p.id)));
route('GET', '/api/offices/:id/wiki-source', (req, res, p, q) => ({ text: st.readSource(O(p.id), q.get('file')) }));

/* meetings */
route('GET', '/api/offices/:id/meetings', (req, res, p) => listMeetings(O(p.id)));
route('GET', '/api/offices/:id/meetings/:mid', (req, res, p) => getMeeting(O(p.id), p.mid));
route('POST', '/api/offices/:id/meetings', async (req, res, p) => startMeeting(O(p.id), await body(req)));
route('POST', '/api/offices/:id/meetings/:mid/resume', (req, res, p) => resumeMeeting(O(p.id), p.mid));
route('POST', '/api/offices/:id/meetings-cancel', (req, res, p) => { cancelMeeting(O(p.id)); return { ok: true }; });
route('POST', '/api/offices/:id/meetings/:mid/say', async (req, res, p) => { interject(O(p.id), p.mid, (await body(req)).text || ''); return { ok: true }; });
route('POST', '/api/offices/:id/meetings/:mid/action', async (req, res, p) => actionToCard(O(p.id), p.mid, (await body(req)).index));

/* payroll */
route('GET', '/api/payroll', (req, res, p, q) => payroll(q.get('office') || null, q.get('month') || currentMonth()));
route('POST', '/api/payroll/rescan', () => { scanUsage(); return { ok: true }; });
route('POST', '/api/offices/:id/budget', async (req, res, p) => { setBudget(O(p.id), Number((await body(req)).usd) || 0); return { ok: true }; });

/* news */
route('POST', '/api/offices/:id/news', async (req, res, p) => { st.addNews(O(p.id), (await body(req)).text, 'Kamu'); return st.listNews(p.id); });
route('DELETE', '/api/offices/:id/news/:nid', (req, res, p) => { st.delNews(O(p.id), Number(p.nid)); return st.listNews(p.id); });

/* settings + hooks */
route('POST', '/api/settings', async req => {
  const b = await body(req);
  if (b.defaultPermissionMode !== undefined) cfg.defaultPermissionMode = ['', 'default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'].includes(b.defaultPermissionMode) ? b.defaultPermissionMode : '';
  if (b.approvals) cfg.approvals = { holdKantorSec: Math.max(0, Math.min(580, Number(b.approvals.holdKantorSec) || 0)), holdManualSec: Math.max(0, Math.min(580, Number(b.approvals.holdManualSec) || 0)) };
  saveConfig(cfg);
  return { ok: true };
});
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
route('POST', '/api/hooks/install', () => {
  const raw = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf8') : '{}';
  const s = JSON.parse(raw || '{}');
  fs.writeFileSync(`${SETTINGS_FILE}.kantor-backup-${Date.now()}`, raw);
  s.hooks ||= {};
  for (const [ev, entries] of Object.entries(hookSettings().hooks)) {
    s.hooks[ev] = (s.hooks[ev] || []).filter(e => !JSON.stringify(e).includes('kantor-hook.cjs'));
    s.hooks[ev].push(...entries);
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return { ok: true, hooks: true };
});
route('POST', '/api/hooks/uninstall', () => {
  const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  const s = JSON.parse(raw);
  fs.writeFileSync(`${SETTINGS_FILE}.kantor-backup-${Date.now()}`, raw);
  for (const ev of Object.keys(s.hooks || {})) { s.hooks[ev] = s.hooks[ev].filter(e => !JSON.stringify(e).includes('kantor-hook.cjs')); if (!s.hooks[ev].length) delete s.hooks[ev]; }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return { ok: true, hooks: false };
});

/* agent (MCP) */
route('GET', '/api/agent/tools', () => ({ tools: TOOLS }));
route('POST', '/api/agent/call', async req => { const b = await body(req); return callTool(resolveIdentity(b), b.tool, b.args || {}); });

/* ---------------- server ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' && url.searchParams.get('token')) {
    if (url.searchParams.get('token') !== cfg.token || !allowedHosts().has(req.headers.host)) { res.writeHead(403); return res.end('Token salah'); }
    const next = url.searchParams.get('next') || '';
    res.writeHead(302, { 'Set-Cookie': `kc_token=${encodeURIComponent(cfg.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, Location: '/' + (next.startsWith('#/') ? next : '') });
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) {
    if (!authed(req)) return send(res, 401, { error: 'Butuh token. Buka alamat dari perintah: kantor open' });
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
    if (!r) return send(res, 404, { error: 'Tidak ditemukan' });
    const m = r.re.exec(url.pathname);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      const out = await r.fn(req, res, params, url.searchParams);
      if (!res.headersSent) send(res, 200, out);
    } catch (e) {
      if (!res.headersSent) send(res, e.code === 404 ? 404 : 400, { error: e.message });
    }
    return;
  }
  // static
  if (!allowedHosts().has(req.headers.host)) { res.writeHead(403); return res.end(); }
  if (tokenOf(req) !== cfg.token) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>Kantor Claude</title><body style="font:16px system-ui;padding:40px;max-width:560px">Kantor Claude butuh token. Jalankan <code>npm run open</code> atau <code>node bin/kantor.js open</code> di folder kantor-claude untuk membuka alamat yang benar.</body>');
  }
  let file = VENDOR[url.pathname] ? path.join(ROOT_DIR, 'node_modules', VENDOR[url.pathname]) : path.join(WEB, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(WEB) && !VENDOR[url.pathname]) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const wssEvents = new WebSocketServer({ noServer: true });
const wssTerm = new WebSocketServer({ noServer: true });
const makeServer = () => http.createServer(handle).on('upgrade', onUpgrade);
const server = makeServer();
function onUpgrade(req, sock, head) {
  const url = new URL(req.url, 'http://x');
  if (!authed(req)) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return sock.destroy(); }
  if (url.pathname === '/ws') wssEvents.handleUpgrade(req, sock, head, ws => wssEvents.emit('connection', ws, req));
  else if (url.pathname === '/ws/term') wssTerm.handleUpgrade(req, sock, head, ws => wssTerm.emit('connection', ws, req, url));
  else sock.destroy();
}

wssEvents.on('connection', ws => { ws.send(JSON.stringify({ t: 'hello', inbox: openInbox() })); });
bus.on('msg', m => { const s = JSON.stringify(m); for (const c of wssEvents.clients) if (c.readyState === 1) c.send(s); });

wssTerm.on('connection', (ws, req, url) => {
  let name;
  try {
    const kind = url.searchParams.get('kind');
    if (kind === 'session') {
      const s = live.get(url.searchParams.get('sid'));
      name = s?.tmux;
      if (!name || !hasTmux(name)) throw new Error('Sesi ini tidak berjalan di tmux kantor.');
    } else if (kind === 'shell') name = ensureShell(url.searchParams.get('office'), url.searchParams.get('room'));
    else throw new Error('Jenis terminal tidak dikenal');
  } catch (e) { ws.send(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`); return ws.close(); }
  const cols = Number(url.searchParams.get('cols')) || 100, rows = Number(url.searchParams.get('rows')) || 30;
  const p = pty.spawn(bins().tmux, ['attach-session', '-t', name], { name: 'xterm-256color', cols, rows, cwd: process.env.HOME, env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' } });
  p.onData(d => { if (ws.readyState === 1) ws.send(d); });
  p.onExit(() => { try { ws.send('\r\n\x1b[90m[terminal ditutup]\x1b[0m\r\n'); ws.close(); } catch {} });
  ws.on('message', (data, isBinary) => {
    const s = data.toString();
    if (!isBinary && s.startsWith('\x00{')) { try { const m = JSON.parse(s.slice(1)); if (m.cols && m.rows) p.resize(Math.max(20, m.cols), Math.max(5, m.rows)); } catch {} return; }
    p.write(s);
  });
  ws.on('close', () => { try { p.kill(); } catch {} });
});

function listen() {
  const hosts = [cfg.host, ...cfg.extraHosts.filter(h => h && h !== cfg.host)];
  const [first, ...rest] = hosts;
  server.listen(cfg.port, first, () => {
    fs.writeFileSync(SERVER_JSON, JSON.stringify({ port: cfg.port, token: cfg.token, pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    console.log(`Kantor Claude jalan di http://${first}:${cfg.port}/?token=${cfg.token}`);
    for (const h of rest) makeServer().listen(cfg.port, h, () => console.log(`  juga di http://${h}:${cfg.port}`)).on('error', e => console.error(`Tidak bisa listen di ${h}: ${e.message}`));
  });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${cfg.port} sudah dipakai. Mungkin Kantor Claude sudah jalan.` : e.message); process.exit(1); });
}

// KANTOR_DEMO=1: a showroom daemon (screenshots, demos) that never touches real sessions or transcripts
const DEMO = process.env.KANTOR_DEMO === '1';
if (!DEMO) { adoptRunning(); adoptManual(); }
listen();
for (const o of listOffices()) try { markInterrupted(o.id); } catch {}
if (!DEMO) { setTimeout(() => scanProcesses(), 1500); setInterval(() => scanProcesses(), 20e3).unref(); }
// keep the permission mode of office panes current (it changes with Shift+Tab, which sends no hook)
setInterval(() => {
  for (const s of live.values()) {
    if (!s.tmux || s.status === 'ended') continue;
    const m = paneMode(s.tmux);
    if (m && m !== s.permMode) { s.permMode = m; bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); }
  }
}, 4000).unref();
if (!DEMO) { setTimeout(() => scanUsage(), 3000); setInterval(() => scanUsage(), 90e3).unref(); }
const stop = () => { try { if (JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8')).pid === process.pid) fs.unlinkSync(SERVER_JSON); } catch {} closeAll(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
