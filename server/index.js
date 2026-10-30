import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import { config, saveConfig, loadConfig, SERVER_JSON, ROOT_DIR, CLAUDE_DIR } from './config.js';
import { globalDb, officeDb, all, one, run, closeAll } from './db.js';
import { listOffices, officeModel, registerOffice, candidateFolders, invalidate, addRoom, updateRoom, scanRoot, browseFolder, previewRoom, roomForCwd, saveLayout, resetLayout, layoutProblems, getFurniture, saveFurniture } from './offices.js';
import { catalog as furnitureCatalog } from './furniture.js';
import { prayerTimes } from './prayer.js';
import { bus, handleHook, decide, answerAsk, openInbox, liveFor, live, serialize, whoOf } from './live.js';
import * as st from './store.js';
import * as bd from './boards.js';
import { startShift, sessionAction, adoptSession, setSessionBoss, setPermMode, paneMode, paneModeAsync, adoptRunning, adoptManual, reapGoneTmux, ensureShell, tmux, bins, hasTmux, capture, globalHooksInstalled, hookSettings } from './tmux.js';
import * as sysmon from './sysmon.js';
import { scanCodexUsage } from './codexusage.js';
import { limits as usageLimits, recordClaudeLimits, summary as usageSummary, pollCodexLimits } from './usage.js';
import { payroll, scanUsage, setBudget, monthCost, currentMonth } from './payroll.js';
import { officeMetrics, complexMetrics, reportMarkdown } from './metrics.js';
import { listMeetings, getMeeting, startMeeting, cancelMeeting, interject, actionToCard, resumeMeeting, continueMeeting, markInterrupted } from './meetings.js';
import { TOOLS, callTool, resolveIdentity } from './agent.js';
import { readTranscript } from './transcript.js';
import { scanProcesses } from './procscan.js';
import { wizardFolders, wizardPreview, wizardCreate } from './wizard.js';
import { templateList, templateState, previewTemplate, applyTemplate, restoreTemplate } from './templates.js';
import { listMusic, sendMusic, uploadMusic, listPlaylists, createPlaylist, updatePlaylist, deletePlaylist } from './music.js';
import { listDir, findFiles, readText, sendRaw, upload, makeDir } from './files.js';
import { saveUpload, sendMedia, listMedia, getMedia } from './media.js';
import { listShows, markShow, openLocal, serveShow } from './shows.js';
import * as pv from './pratinjau.js';
import * as pr from './procs.js';
import { startNotify } from './notify.js';
import * as att from './attachments.js';
import { officeGit, gitDiff, gitCommit } from './gitinfo.js';
import { openForSession, selectForSession, cancelForSession } from './modelpick.js';
import { agyModels } from './antigravity.js';
import { codexModels, codexBin, CODEX_MODES } from './codex.js';
import { setCodexModel, setCodexMode } from './codexpick.js';
import { listOutbox, cancelOutgoing, startOutbox } from './outbox.js';
import * as dm from './dm.js';
import { startTunggu } from './tunggu.js';
import * as autopilot from './autopilot.js';
import * as budget from './budget.js';
import { getOwner, putOwner, getLook, setLook, startOwnerSweep } from './owner.js';
import { getMinions, putMinions, usir as usirMinion } from './minions.js';
import { startHookContext } from './hookctx.js';
import { listRules, setRule } from './aturan.js';
import { listLocks } from './locks.js';
import { startTailWatch } from './tailwatch.js';
import { validateTabOrder } from './tab-order.js';
import { withActor, actor, who, LOCAL, SYSTEM } from './actor.js';
import * as audit from './audit.js';
import * as akun from './akun.js';
import { loginHtml, inviteHtml, PAGE_CSP } from './akun-pages.js';

const cfg = loadConfig();
const WEB = path.join(ROOT_DIR, 'web');
const VENDOR = { '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': '@xterm/xterm/css/xterm.css', '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js', '/vendor/addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

/* ---------------- auth ---------------- */
// Two modes. Single user (default): one token from config.json, as a Bearer header or the kc_token cookie.
// Akun (cfg.akun.enabled, a shared server): members sign in at /masuk and carry the kc_sesi cookie;
// the config token is then only accepted from loopback, for hooks and MCP on the same machine.
const akunOn = () => !!cfg.akun?.enabled;
const allowedHosts = () => new Set([
  ...['127.0.0.1', 'localhost', ...cfg.extraHosts].flatMap(h => [h, `${h}:${cfg.port}`]),
  ...(cfg.tls ? [cfg.tls.host, ...(cfg.tls.names || [])].flatMap(h => [h, `${h}:${cfg.tls.port || 443}`]) : []),
  ...(akunOn() ? cfg.akun.names || [] : []),
]);
const cookieOf = (req, name) => { const c = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || ''); return c ? decodeURIComponent(c[1]) : null; };
function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return cookieOf(req, 'kc_token');
}
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// a request relayed by a reverse proxy also arrives from loopback, so forwarded headers disqualify it
const fromLoopback = req => LOOPBACK.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];
function clientIp(req) {
  if (cfg.akun?.trustProxy) {
    const real = req.headers['x-real-ip'];
    if (real) return String(real);
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || null;
}
const isSecure = req => !!req.socket.encrypted || (!!cfg.akun?.trustProxy && String(req.headers['x-forwarded-proto'] || '') === 'https');
/** Who sent this request (an actor for actor.js), or null. */
function identify(req) {
  if (!allowedHosts().has(req.headers.host)) return null;
  const ip = clientIp(req);
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    // akun mode: a member's app token (Ghina) acts as that member, from anywhere
    if (akunOn() && h.startsWith('Bearer ' + akun.TOKEN_PREFIX)) { const m = akun.memberForToken(h.slice(7)); return m ? { kind: 'member', ...m, via: 'token', ip } : null; }
    if (h.slice(7) !== cfg.token) return null;
    if (!akunOn()) return { ...LOCAL, ip };
    return fromLoopback(req) ? { ...SYSTEM, ip } : null;
  }
  if (!akunOn()) return cookieOf(req, 'kc_token') === cfg.token ? { ...LOCAL, ip } : null;
  const m = akun.memberForCookie(cookieOf(req, 'kc_sesi'));
  return m ? { kind: 'member', ...m, ip } : null;
}
const authed = req => !!identify(req);
/** Browsers send Origin on every POST and WebSocket; it has to be this office (blocks cross-site requests riding a cookie). */
function originOk(req) {
  const o = req.headers.origin, site = String(req.headers['sec-fetch-site'] || '');
  // a page with a strict referrer policy posts with "Origin: null"; the browser still says where it came from
  if (o === 'null') return site === 'same-origin';
  if (!o) return !['cross-site', 'same-site'].includes(site);
  try { return allowedHosts().has(new URL(o).host); } catch { return false; }
}
// in akun mode: what only the daemon's own clients may call, and what only admins may change
const SYSTEM_ONLY = [/^POST \/api\/hook$/, /^(GET|POST) \/api\/agent\//, /^POST \/api\/usage\/limits\/claude$/];
const ADMIN_ONLY = [
  /^\w+ \/api\/akun\/anggota/, /^GET \/api\/audit\/verify$/,
  /^POST \/api\/wizard\//, /^GET \/api\/(wizard\/folders|candidates)$/, /^POST \/api\/offices$/, /^POST \/api\/offices\/[^/]+\/(hide|open-local|budget)$/,
  /^GET \/api\/offices\/[^/]+\/browse$/, /^(POST|PATCH) \/api\/offices\/[^/]+\/rooms(\/[^/]+)?$/,
  /^POST \/api\/settings$/, /^POST \/api\/hooks\//, /^PUT \/api\/offices\/[^/]+\/(aturan|autopilot)$/, /^(PUT|POST) \/api\/pratinjau\/(storage|cleanup)$/,
];
function policy(a, sig) {
  if (!akunOn()) return null;
  if (SYSTEM_ONLY.some(re => re.test(sig))) return a.kind === 'system' ? null : 'Hanya untuk hooks dan MCP di server ini.';
  if (a.kind === 'member' && a.role !== 'admin' && ADMIN_ONLY.some(re => re.test(sig))) return 'Hanya admin yang boleh melakukan ini.';
  return null;
}
/** Framing is limited to the office itself (the app is native, nothing else embeds it); merged into any CSP a handler sets. */
function guardFraming(res) {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  const wh = res.writeHead;
  res.writeHead = function (code, a, b) {
    const h = typeof a === 'object' && a ? a : b;
    if (h) for (const k of Object.keys(h)) if (k.toLowerCase() === 'content-security-policy') h[k] = `${h[k]}; frame-ancestors 'self'`;
    return wh.call(this, code, a, b);
  };
}
/* ---------------- tiny router ---------------- */
const routes = [];
const route = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, re, keys, fn });
};
async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 5e6) throw new Error('Body terlalu besar'); }
  const v = s ? JSON.parse(s) : {};
  req._body = v;
  return v;
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
      cards = one(db, "SELECT COALESCE(SUM(kind <> 'selesai'), 0) open, COALESCE(SUM(blocked <> '' AND kind <> 'selesai'), 0) blocked, COALESCE(SUM(kind = 'selesai'), 0) done FROM cards WHERE archived = 0");
    } catch {}
    let roleRows = [];
    try { roleRows = st.listRoles(o.id); } catch {}
    const look = s => { const r = roleRows.find(x => x.id === s.role); return r ? { name: r.name + (s.slot ? ` #${s.slot + 1}` : ''), color: r.color, hair: r.hair, skin: r.skin, hairStyle: r.hairStyle, outfit: r.outfit, acc: r.acc, hijab: r.hijab, tie: r.tie, title: r.title } : null; };
    return { id: o.id, name: o.name, root: o.root, fav: !!o.fav, style: o.style || officeModel(o.id)?.style,
      sessions: sessions.map(s => ({ sid: s.sid, role: s.role, status: s.status, title: s.title, kind: s.kind, room: s.room, tool: s.tool, waiting: s.waiting, look: look(s), lastSeen: s.lastSeen, permMode: s.permMode || null, boss: s.boss || null, host: s.host || null, tty: s.tty || null, model: s.model || null, engine: s.engine || null, bgAgents: s.bgAgents || 0, slot: s.slot || 0 })),
      roles, cards, monthCost: monthCost(o.id), lastSeen: one(globalDb(), 'SELECT MAX(last_seen) t FROM sessions WHERE office = ?', o.id)?.t || o.created_at };
  });
  // sessions outside every office (e.g. claude started in ~/Developer itself)
  const loose = [...live.values()].filter(s => !s.office && s.status !== 'ended').map(s => ({ sid: s.sid, status: s.status, title: s.title, cwd: s.cwd, tool: s.tool, waiting: s.waiting, lastSeen: s.lastSeen, tty: s.tty || null, host: s.host || null }));
  return { me: meView(), akun: akunOn(), loose, offices, repoDir: ROOT_DIR, inbox: openInbox(), hooks: globalHooksInstalled(), tmux: !!bins().tmux, claude: !!bins().claude, settings: { approvals: cfg.approvals, roots: cfg.roots, extraHosts: cfg.extraHosts, defaultPermissionMode: cfg.defaultPermissionMode || '', musicDir: cfg.musicDir, sysmon: sysmon.conf().enabled, ghinaNotify: { enabled: cfg.ghinaNotify?.enabled !== false, ready: !!(cfg.ghinaNotify?.url && cfg.ghinaNotify?.token), events: cfg.ghinaNotify?.events || [] } } };
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
    minions: (() => { try { return getMinions(m.id); } catch { return null; } })(), wall: st.listNotes(p.id).filter(n => n.wall).slice(0, 6), cards: st.listCards(p.id).map(c => ({ id: c.id, title: c.title, col: c.col, stage: c.stage, done: c.done, board: c.board, who: c.who, repo: c.repo, blocked: c.blocked })) };
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
/* things agents opened for you (floating viewer) */
route('GET', '/api/shows', (req, res, p, q) => listShows({ open: q.get('open') === '1' }));
route('POST', '/api/shows/:sid', async (req, res, p) => markShow(p.sid, await body(req)));
route('POST', '/api/offices/:id/open-local', async (req, res, p) => { const b = await body(req); return openLocal(O(p.id), b.path || '', b.app); });
/* layout editor */
route('GET', '/api/offices/:id/layout', (req, res, p) => { const m = officeModel(O(p.id)); return { plan: m.plan, custom: !!m.custom }; });
route('PUT', '/api/offices/:id/layout', async (req, res, p) => { const plan = saveLayout(O(p.id), await body(req)); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return { plan, custom: true }; });
route('DELETE', '/api/offices/:id/layout', (req, res, p) => { const plan = resetLayout(O(p.id)); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return { plan, custom: false }; });
route('POST', '/api/offices/:id/layout/check', async (req, res, p) => ({ problems: layoutProblems(await body(req)) }));
/* office templates (suasana kantor): gallery, preview without saving, apply with a backup, restore */
route('GET', '/api/templates', () => templateList());
route('GET', '/api/offices/:id/template', (req, res, p) => templateState(O(p.id)));
route('POST', '/api/offices/:id/template/preview', async (req, res, p) => { const b = await body(req); return previewTemplate(O(p.id), b.template, b.seed); });
route('POST', '/api/offices/:id/template/apply', async (req, res, p) => { const b = await body(req); const r = applyTemplate(O(p.id), b.template, b.seed); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return { ...r, custom: true }; });
route('POST', '/api/offices/:id/template/restore', (req, res, p) => { const r = restoreTemplate(O(p.id)); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return r; });
/* furniture: shared catalog + behaviors, and what each office has placed */
route('GET', '/api/furniture', () => furnitureCatalog());
route('GET', '/api/prayer-times', (req, res, p, q) => {
  const loc = config().location;
  const date = q.get('date') || new Intl.DateTimeFormat('en-CA', { timeZone: loc.tz || 'Asia/Jakarta' }).format(new Date());
  const t = prayerTimes(date, loc);
  return { date, location: { name: loc.name, lat: loc.lat, lng: loc.lng, tz: loc.tz }, method: 'kemenag', subuh: t.subuh, dzuhur: t.dzuhur, ashar: t.ashar, maghrib: t.maghrib, isya: t.isya, terbit: t.terbit };
});
route('GET', '/api/offices/:id/furniture', (req, res, p) => ({ items: getFurniture(O(p.id)) }));
route('PUT', '/api/offices/:id/furniture', async (req, res, p) => { const items = saveFurniture(O(p.id), (await body(req)).items); bus.emit('msg', { t: 'changed', office: p.id, what: 'furniture' }); return { items }; });
/* the owner as a character on the floor (position per office, look shared by all offices) */
route('GET', '/api/offices/:id/owner', (req, res, p) => getOwner(O(p.id)));
route('PUT', '/api/offices/:id/owner', async (req, res, p) => putOwner(O(p.id), await body(req)));
/* Magang: NPC kosmetik (0 token); config per kantor, simulasi di klien */
route('GET', '/api/offices/:id/aturan', (req, res, p, q) => listRules(O(p.id), { riwayat: q.get('riwayat') === '1' }));
route('PUT', '/api/offices/:id/aturan', async (req, res, p) => { const b = await body(req); return setRule(O(p.id), { kategori: b.kategori, isi: b.isi, alasan: b.alasan, by: who(), versiDasar: b.versi_dasar }); });
route('GET', '/api/offices/:id/kunci', (req, res, p) => ({ kunci: listLocks(O(p.id)) }));
route('GET', '/api/offices/:id/minions', (req, res, p) => getMinions(O(p.id)));
route('PUT', '/api/offices/:id/minions', async (req, res, p) => putMinions(O(p.id), await body(req)));
route('POST', '/api/offices/:id/minions/:mid/usir', (req, res, p) => usirMinion(O(p.id), p.mid));
route('GET', '/api/owner/look', () => getLook());
route('PUT', '/api/owner/look', async req => setLook(await body(req)));
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
/* git per ruangan */
route('GET', '/api/offices/:id/git', async (req, res, p, q) => ({ rooms: p.id === '_kompleks' ? {} : await officeGit(O(p.id), { fresh: q.get('fresh') === '1' }) }));
route('GET', '/api/offices/:id/git/:roomId/diff', (req, res, p, q) => gitDiff(O(p.id), p.roomId, q.get('file') || ''));
route('POST', '/api/offices/:id/git/:roomId/commit', async (req, res, p) => gitCommit(O(p.id), p.roomId, await body(req)));

/* board */
// ?board=<id|nama> satu papan, ?board=all semua papan; tanpa board = papan Utama (perilaku lama). cols = nama kolom papan itu (kompatibel).
route('GET', '/api/offices/:id/board', (req, res, p, q) => {
  const ref = q.get('board') || '', isAll = ref === 'all' || ref === '*';
  const b = isAll ? null : bd.resolveBoard(O(p.id), ref);
  return { board: b, boards: bd.listBoards(p.id), cols: (b || bd.getBoard(p.id, bd.DEFAULT_BOARD)).columns.map(c => c.name), columns: (b || bd.getBoard(p.id, bd.DEFAULT_BOARD)).columns,
    cards: st.listCards(p.id, { board: isAll ? 'all' : b.id }), labels: st.listLabels(p.id), ...(q.get('moves') ? { moves: st.cardMoves(p.id) } : {}) };
});
route('GET', '/api/offices/:id/boards', (req, res, p) => ({ boards: bd.listBoards(O(p.id)), kinds: bd.KINDS, kindLabels: bd.KIND_LABEL, templates: Object.values(bd.TEMPLATES) }));
route('POST', '/api/offices/:id/boards', async (req, res, p) => bd.createBoard(O(p.id), await body(req)));
route('POST', '/api/offices/:id/boards-order', async (req, res, p) => bd.orderBoards(O(p.id), (await body(req)).ids));
route('PATCH', '/api/offices/:id/boards/:bid', async (req, res, p) => bd.updateBoard(O(p.id), p.bid, await body(req)));
route('DELETE', '/api/offices/:id/boards/:bid', (req, res, p, q) => bd.deleteBoard(O(p.id), p.bid, { moveTo: q.get('moveTo') || undefined }));
route('GET', '/api/offices/:id/labels', (req, res, p) => st.listLabels(O(p.id)));
route('POST', '/api/offices/:id/labels', async (req, res, p) => st.saveLabel(O(p.id), await body(req)));
route('DELETE', '/api/offices/:id/labels/:lid', (req, res, p) => { st.deleteLabel(O(p.id), p.lid); return { ok: true }; });
route('POST', '/api/offices/:id/cards/:cid/attach', async (req, res, p) => st.attachToCard(O(p.id), p.cid, (await body(req)).media, who()));
route('DELETE', '/api/offices/:id/cards/:cid/attach/:mid', (req, res, p) => st.attachToCard(O(p.id), p.cid, p.mid, who(), false));
/* pratinjau: previews agents send for the owner to decide on (files themselves are served under /pv, see handle) */
route('GET', '/api/offices/:id/pratinjau', (req, res, p, q) => pv.listItems(O(p.id), { status: q.get('status') || 'semua', limit: q.get('limit'), sid: q.get('sid'), role: q.get('role') }));
route('GET', '/api/offices/:id/pratinjau/usage', (req, res, p) => pv.usage(O(p.id)));
route('POST', '/api/pratinjau/cleanup', async req => { const b = await body(req); if (b.office) O(b.office); return pv.cleanup({ dryRun: !!b.dryRun, days: b.days, office: b.office || null }); });
route('GET', '/api/pratinjau/storage', () => pv.storageSettings());
route('PUT', '/api/pratinjau/storage', async req => pv.storageSettings(await body(req)));
route('GET', '/api/offices/:id/pratinjau/:pid', (req, res, p) => pv.getItem(O(p.id), p.pid));
route('POST', '/api/offices/:id/pratinjau/:pid/komentar', async (req, res, p) => pv.comment(O(p.id), p.pid, await body(req)));
route('POST', '/api/offices/:id/pratinjau/:pid/lihat', (req, res, p) => pv.markSeen(O(p.id), p.pid));
route('POST', '/api/offices/:id/pratinjau/:pid/reaksi', async (req, res, p) => pv.react(O(p.id), p.pid, await body(req)));
route('POST', '/api/offices/:id/pratinjau/:pid/tanda', async (req, res, p) => pv.setFlags(O(p.id), p.pid, await body(req)));
route('POST', '/api/offices/:id/pratinjau/:pid/setujui', async (req, res, p) => pv.approveAll(O(p.id), p.pid, await body(req)));
route('POST', '/api/offices/:id/pratinjau/:pid/revisi', async (req, res, p) => pv.requestRevision(O(p.id), p.pid, await body(req)));
route('POST', '/api/offices/:id/pratinjau/:pid/pilih', async (req, res, p) => pv.pick(O(p.id), p.pid, await body(req)));
route('POST', '/api/offices/:id/pratinjau/:pid/files/:fid', async (req, res, p) => pv.decideFile(O(p.id), p.pid, p.fid, await body(req)));
route('POST', '/api/offices/:id/pratinjau/:pid/wiki', async (req, res, p) => pv.toWiki(O(p.id), p.pid, await body(req)));

/* media: images and attachments for wiki and cards, stored as files */
route('GET', '/api/offices/:id/media', (req, res, p) => listMedia(O(p.id)));
route('POST', '/api/offices/:id/media', async (req, res, p, q) => saveUpload(O(p.id), q.get('name') || 'file', req, who()));
route('GET', '/api/offices/:id/media/:mid', (req, res, p, q) => { sendMedia(O(p.id), p.mid, res, q.get('dl') === '1', req.headers.range); });
route('GET', '/api/offices/:id/cards/:cid', (req, res, p) => st.getCard(O(p.id), p.cid));
route('POST', '/api/offices/:id/cards', async (req, res, p) => st.createCard(O(p.id), await body(req), who()));
route('PATCH', '/api/offices/:id/cards/:cid', async (req, res, p) => { const b = await body(req); if (b.who) b.whoName = st.getRole(p.id, b.who)?.name; return st.updateCard(O(p.id), p.cid, b, who()); });
route('DELETE', '/api/offices/:id/cards/:cid', (req, res, p) => { st.archiveCard(O(p.id), p.cid, who()); return { ok: true }; });
route('POST', '/api/offices/:id/cards/:cid/checks-order', async (req, res, p) => st.orderChecks(O(p.id), p.cid, (await body(req)).order));
route('POST', '/api/offices/:id/cards/:cid/check', async (req, res, p) => st.checkItem(O(p.id), p.cid, await body(req), who()));
route('POST', '/api/offices/:id/cards/:cid/comment', async (req, res, p) => {
  const b = await body(req);
  const c = st.commentCard(O(p.id), p.cid, b.text, who());
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
  for (const t of parts) st.createCard(p.id, { title: t, who: c.who, repo: c.repo, prio: c.prio, epicId: c.id }, who());
  return st.getCard(p.id, c.id);
});

/* roles + sessions */
route('GET', '/api/offices/:id/roles', (req, res, p) => st.listRoles(O(p.id), { archived: true }));
route('POST', '/api/offices/:id/roles', async (req, res, p) => { const r = st.createRole(O(p.id), await body(req)); invalidate(p.id); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return r; });
route('POST', '/api/offices/:id/roles-order', async (req, res, p) => { const r = st.orderRoles(O(p.id), (await body(req)).order); bus.emit('msg', { t: 'changed', office: p.id, what: 'roles-order', order: r.map(x => x.id) }); return r; });
route('PATCH', '/api/offices/:id/roles/:rid', async (req, res, p) => { const r = st.updateRole(O(p.id), p.rid, await body(req)); invalidate(p.id); bus.emit('msg', { t: 'changed', office: p.id, what: 'plan' }); return r; });
route('POST', '/api/offices/:id/roles/:rid/start', async (req, res, p) => {
  const b = await body(req);
  const r = startShift(O(p.id), p.rid, { task: b.task, cardId: b.cardId, worktree: !!b.worktree, resumeSid: b.resumeSid, permissionMode: b.permissionMode, engine: b.engine, model: b.model, effort: b.effort });
  if (b.task) audit.markTyping(r.tmux, actor());
  if (b.cardId) { const c = st.getCard(p.id, b.cardId); if (c.colKind !== 'dikerjakan') st.updateCard(p.id, b.cardId, { col: 'dikerjakan' }, who()); }
  return r;
});
route('POST', '/api/sessions/:sid/action', async (req, res, p) => { const b = await body(req); if (['text', 'compact', 'clear'].includes(b.action)) audit.markTyping(live.get(p.sid)?.tmux, actor()); return { ok: true, ...(await sessionAction(p.sid, b.action, b.text)) }; });
// sessions whose terminal was closed recently: they can be picked up again in the office
route('GET', '/api/sessions/recent-ended', () => {
  const rows = all(globalDb(), `SELECT s.sid, s.office, s.role, s.room, s.title, s.first_prompt, s.cwd, s.ended_at, s.last_seen, s.transcript, o.name office_name
    FROM sessions s JOIN offices o ON o.id = s.office
    WHERE s.ended_at IS NOT NULL AND s.ended_at > ? AND COALESCE(s.source, '') <> 'rapat' ORDER BY s.ended_at DESC LIMIT 30`, new Date(Date.now() - 3 * 864e5).toISOString());
  return rows.filter(r => !live.has(r.sid) && r.transcript && fs.existsSync(r.transcript)).slice(0, 8).map(({ transcript, ...r }) => r);
});
/* attachments in the agent chat: resumable uploads in, files from the agent out (docs/ATTACHMENTS.md) */
route('POST', '/api/sessions/:sid/uploads', async (req, res, p) => { const r = att.createUpload(p.sid, await body(req)); send(res, 201, r); });
route('HEAD', '/api/uploads/:id', (req, res, p) => { const r = att.uploadInfo(p.id); res.setHeader('Upload-Offset', r.offset); res.setHeader('Upload-Length', r.size); return r; });
route('GET', '/api/uploads/:id', (req, res, p) => att.uploadInfo(p.id));
route('PUT', '/api/uploads/:id', async (req, res, p) => { const r = await att.appendUpload(p.id, req); res.setHeader('Upload-Offset', r.offset); return r; });
route('GET', '/api/sessions/:sid/attachments', (req, res, p, q) => att.listAttachments(p.sid, { limit: q.get('limit'), after: q.get('after') || '' }));
route('GET', '/api/sessions/:sid/outbox', (req, res, p) => listOutbox(p.sid));
route('DELETE', '/api/sessions/:sid/outbox/:id', (req, res, p) => cancelOutgoing(p.sid, p.id));
route('GET', '/api/attachments/:id/raw', (req, res, p, q) => { att.sendRaw(p.id, req, res, q.get('dl') === '1'); });
route('HEAD', '/api/attachments/:id/raw', (req, res, p) => { att.sendRaw(p.id, req, res); });
route('GET', '/api/attachments/:id/thumb', (req, res, p) => att.sendThumb(p.id, req, res));
// images named by transcript items {k:'image'} (Codex image generation / image views, pasted images): only image files under the session's folders, ~/.codex/generated_images or temp
route('GET', '/api/sessions/:sid/image', (req, res, p, q) => att.sendSessionImage(p.sid, q.get('path'), q.get('thumb') === '1', req, res));
route('POST', '/api/sessions/:sid/mode', async (req, res, p) => { const b = await body(req); const r = await setPermMode(p.sid, b.mode); const s = live.get(p.sid); if (s) bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); return r; });
route('POST', '/api/sessions/:sid/model/open', (req, res, p) => openForSession(p.sid));
route('POST', '/api/sessions/:sid/model/select', async (req, res, p) => selectForSession(p.sid, (await body(req)).index));
route('POST', '/api/sessions/:sid/model/cancel', (req, res, p) => cancelForSession(p.sid));
// OpenAI Codex as the second engine (docs/CODEX.md): what can be picked, and changing it mid-shift through Codex's own menus
route('GET', '/api/antigravity/models', async () => agyModels());
route('GET', '/api/codex/models', async () => ({ available: !!codexBin(), ...(await codexModels()), modes: CODEX_MODES }));
route('POST', '/api/sessions/:sid/codex/settings', async (req, res, p) => {
  const b = await body(req);
  const out = { ok: true };
  if (b.model || b.effort) Object.assign(out, await setCodexModel(p.sid, { model: b.model, effort: b.effort }));
  if (b.mode) Object.assign(out, await setCodexMode(p.sid, b.mode));
  return out;
});
route('POST', '/api/sessions/:sid/adopt', async (req, res, p) => { const b = await body(req); return adoptSession(p.sid, b.role || null, b.permissionMode || null, b.newRole || null, b.boss || null); });
route('POST', '/api/sessions/:sid/boss', async (req, res, p) => setSessionBoss(p.sid, (await body(req)).boss || null));
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
route('POST', '/api/inbox/:iid/answer', async (req, res, p) => { const b = await body(req); answerAsk(p.iid, b.answers); return { ok: true }; });
route('POST', '/api/inbox/:iid', async (req, res, p) => { const b = await body(req); decide(p.iid, b.behavior === 'allow' ? 'allow' : 'deny', b.message); return { ok: true }; });

/* notes */
route('GET', '/api/offices/:id/notes', (req, res, p, q) => ({ notes: st.listNotes(O(p.id), { q: q.get('q') || '', tag: q.get('tag') || '', view: q.get('view') || 'aktif' }), tags: st.noteTags(p.id) }));
route('POST', '/api/offices/:id/notes', async (req, res, p) => st.saveNote(O(p.id), await body(req), who()));
route('DELETE', '/api/offices/:id/notes/:nid', (req, res, p) => { st.purgeNote(O(p.id), p.nid); return { ok: true }; });
route('POST', '/api/offices/:id/notes/:nid/to-card', async (req, res, p) => {
  const n = st.getNote(O(p.id), p.nid);
  const b = await body(req);
  const items = [...n.body.matchAll(/^\s*[-*] \[( |x)\] (.+)$/gim)].map(m => ({ done: m[1] !== ' ', text: m[2].trim() }));
  if (b.mode === 'each') {
    const open = items.filter(i => !i.done);
    if (!open.length) throw new Error('Tidak ada checklist yang belum dicentang di catatan ini');
    const made = open.map(i => st.createCard(p.id, { title: i.text, desc: `Dari catatan: ${n.title || 'tanpa judul'}`, who: b.who || null, repo: b.repo || '' }, who()).id);
    return { cards: made };
  }
  const body2 = n.body.replace(/^\s*[-*] \[( |x)\] .+$/gim, '').trim();
  const c = st.createCard(p.id, { title: n.title || n.body.split('\n')[0].slice(0, 100) || 'Dari catatan', desc: body2, who: b.who || null, repo: b.repo || '', checklist: items.filter(i => !i.done).map(i => i.text) }, who());
  return { cards: [c.id] };
});
route('POST', '/api/offices/:id/notes/:nid/send-role', async (req, res, p) => {
  const n = st.getNote(O(p.id), p.nid);
  const b = await body(req);
  const r = st.getRole(p.id, b.role);
  if (!r) throw new Error('Role tidak ditemukan');
  st.writeRoleNotes(p.id, r.id, `\n## Dari catatan "${n.title || 'tanpa judul'}" (${new Date().toLocaleDateString('id-ID')})\n${n.body}`, 'append', who());
  const s = [...live.values()].find(x => x.office === p.id && x.role === r.id && x.status !== 'ended' && (x.tmux || x.tty));
  if (s && b.live) sessionAction(s.sid, 'text', `Catatan dari pemilik kantor: ${n.title ? n.title + ' — ' : ''}${n.body.replace(/\s+/g, ' ').slice(0, 1500)}`).catch(() => {});
  return { ok: true, live: !!s };
});

/* wiki */
route('GET', '/api/offices/:id/wiki', (req, res, p) => st.listWiki(O(p.id)));
route('GET', '/api/offices/:id/wiki/page', (req, res, p, q) => st.getWiki(O(p.id), q.get('ref') || 'beranda'));
route('POST', '/api/offices/:id/wiki', async (req, res, p) => st.saveWiki(O(p.id), await body(req), who()));
route('POST', '/api/offices/:id/wiki-playbook', async (req, res, p) => { const b = await body(req); return st.setPlaybook(O(p.id), b.slug, b); });
route('GET', '/api/offices/:id/playbooks', (req, res, p, q) => st.listPlaybooks(O(p.id), q.get('role') || null).map(({ body: _, ...x }) => x));
route('GET', '/api/offices/:id/wiki-proposals', (req, res, p) => st.listProposals(O(p.id)));
route('GET', '/api/offices/:id/wiki-proposals/:uid', (req, res, p) => st.getProposal(O(p.id), p.uid));
route('POST', '/api/offices/:id/wiki-proposals/:uid', async (req, res, p) => st.decideProposal(O(p.id), p.uid, !!(await body(req)).accept));
route('POST', '/api/offices/:id/wiki-move', async (req, res, p) => { const b = await body(req); return st.moveWiki(O(p.id), b.slug, { parent: b.parent, ord: b.ord }); });
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
route('POST', '/api/offices/:id/meetings/:mid/continue', async (req, res, p) => { const b = await body(req); return continueMeeting(O(p.id), p.mid, { rounds: b.rounds, note: b.note || '' }); });
route('POST', '/api/offices/:id/meetings-cancel', (req, res, p) => { cancelMeeting(O(p.id)); return { ok: true }; });
route('POST', '/api/offices/:id/meetings/:mid/say', async (req, res, p) => { interject(O(p.id), p.mid, (await body(req)).text || ''); return { ok: true }; });
route('POST', '/api/offices/:id/meetings/:mid/action', async (req, res, p) => actionToCard(O(p.id), p.mid, (await body(req)).index));

/* payroll */
route('GET', '/api/metrics', (req, res, p, q) => complexMetrics(Object.fromEntries(q)));
route('GET', '/api/offices/:id/metrics', (req, res, p, q) => p.id === '_kompleks' ? complexMetrics(Object.fromEntries(q)) : officeMetrics(O(p.id), Object.fromEntries(q)));
route('GET', '/api/offices/:id/metrics/report', async (req, res, p, q) => {
  const m = await officeMetrics(O(p.id), Object.fromEntries(q));
  return { markdown: reportMarkdown(m, one(globalDb(), 'SELECT name FROM offices WHERE id = ?', p.id)?.name || p.id) };
});
route('GET', '/api/payroll', (req, res, p, q) => payroll(q.get('office') || null, q.get('month') || currentMonth()));
/* Performa PC (sysmon): requests keep the sampler at full rate for activeSec */
const sysSeries = q => (q.get('series') || '').split(',').map(x => x.trim()).filter(Boolean);
route('GET', '/api/sysmon', (req, res, p, q) => sysmon.snapshot({ histMin: Math.min(60, Number(q.get('min')) || 10), series: sysSeries(q) }));
route('GET', '/api/sysmon/history', (req, res, p, q) => { sysmon.touch(); return sysmon.history(Math.min(1440, Number(q.get('min')) || 60), { series: sysSeries(q), points: Math.min(2000, Number(q.get('points')) || 0) }); });
route('GET', '/api/sysmon/procs', (req, res, p, q) => sysmon.procs({ all: q.get('all') === '1' }));
route('GET', '/api/sysmon/events', (req, res, p, q) => { sysmon.touch(); return { events: sysmon.eventsList(Math.min(200, Number(q.get('limit')) || 100)) }; });

/* usage: subscription limits + statistics */
route('GET', '/api/usage/limits', () => usageLimits());
route('POST', '/api/usage/limits/claude', async req => ({ ok: true, changed: recordClaudeLimits(await body(req)) }));
route('GET', '/api/usage/summary', (req, res, p, q) => usageSummary({ range: q.get('range') || '7d', office: q.get('office') || null }));
route('POST', '/api/payroll/rescan', () => { scanUsage(); try { scanCodexUsage(); } catch {} return { ok: true }; });
/* autopilot (pullWork, manager round, what a role budget counts) and role budgets */
route('GET', '/api/offices/:id/autopilot', (req, res, p) => ({ config: autopilot.getConf(O(p.id)), log: autopilot.autopilotLog(p.id) }));
route('PUT', '/api/offices/:id/autopilot', async (req, res, p) => ({ config: autopilot.setConf(O(p.id), await body(req)) }));
route('GET', '/api/offices/:id/anggaran', (req, res, p) => ({ period: autopilot.getConf(O(p.id)).budgetPeriod, roles: budget.overview(p.id) }));
route('POST', '/api/offices/:id/budget', async (req, res, p) => { setBudget(O(p.id), Number((await body(req)).usd) || 0); return { ok: true }; });

/* news */
route('POST', '/api/offices/:id/news', async (req, res, p) => { st.addNews(O(p.id), (await body(req)).text, who()); return st.listNews(p.id); });
route('DELETE', '/api/offices/:id/news/:nid', (req, res, p) => { st.delNews(O(p.id), Number(p.nid)); return st.listNews(p.id); });

/* settings + hooks */
route('POST', '/api/settings', async req => {
  const b = await body(req);
  if (b.defaultPermissionMode !== undefined) cfg.defaultPermissionMode = ['', 'default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'].includes(b.defaultPermissionMode) ? b.defaultPermissionMode : '';
  if (b.approvals) cfg.approvals = { holdKantorSec: Math.max(0, Math.min(580, Number(b.approvals.holdKantorSec) || 0)), holdManualSec: Math.max(0, Math.min(580, Number(b.approvals.holdManualSec) || 0)) };
  if (b.musicDir !== undefined) {
    const d = String(b.musicDir).trim();
    if (!d || !path.isAbsolute(d) || !fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error('Folder musik tidak ditemukan');
    cfg.musicDir = d;
  }
  saveConfig(cfg);
  return { ok: true };
});
route('GET', '/api/settings/tabs', () => ({ order: Array.isArray(cfg.tabOrder) ? cfg.tabOrder : null }));
route('PUT', '/api/settings/tabs', async req => { const b = await body(req); cfg.tabOrder = b.order === null ? null : validateTabOrder(b.order); saveConfig(cfg); return { order: cfg.tabOrder }; });
route('GET', '/api/music', () => listMusic());
route('POST', '/api/music/upload', async (req, res, p, q) => uploadMusic(q.get('name') || '', req));
route('GET', '/api/music/playlists', () => listPlaylists());
route('POST', '/api/music/playlists', async req => { const b = await body(req); return createPlaylist(b.name, b.paths || []); });
route('PATCH', '/api/music/playlists/:id', async (req, res, p) => updatePlaylist(p.id, await body(req)));
route('DELETE', '/api/music/playlists/:id', (req, res, p) => deletePlaylist(p.id));
route('GET', '/api/music/file', (req, res, p, q) => { sendMusic(q.get('path') || '', req, res); });
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

/* processes + dock terminals */
route('GET', '/api/offices/:id/procs', (req, res, p, q) => {
  const m = officeModel(O(p.id));
  const procs = pr.listProcs(p.id), sugg = {};
  if (q.get('s') !== '0') for (const r of m.plan.rooms) {
    const have = new Set(procs.filter(x => x.room === r.id).map(x => x.cmd)), list = pr.suggest(pr.roomDir(p.id, r.id)).filter(x => !have.has(x.cmd));
    if (list.length) sugg[r.id] = list;
  }
  return { procs, suggestions: sugg };
});
route('POST', '/api/offices/:id/procs', async (req, res, p) => { const b = await body(req); const v = pr.createProc(O(p.id), b, { auto: !!b.auto }); return b.start ? pr.startProc(p.id, v.id) : v; });
route('PATCH', '/api/offices/:id/procs/:pid', async (req, res, p) => pr.updateProc(O(p.id), p.pid, await body(req)));
route('DELETE', '/api/offices/:id/procs/:pid', (req, res, p) => pr.removeProc(O(p.id), p.pid));
route('POST', '/api/offices/:id/procs/:pid/start', (req, res, p) => pr.startProc(O(p.id), p.pid));
route('POST', '/api/offices/:id/procs/:pid/stop', (req, res, p) => pr.stopProc(O(p.id), p.pid));
route('POST', '/api/offices/:id/procs/:pid/restart', (req, res, p) => pr.restartProc(O(p.id), p.pid));
route('POST', '/api/offices/:id/procs/:pid/approve', async (req, res, p) => { const b = await body(req); const v = pr.approveProc(O(p.id), p.pid); return b.start ? pr.startProc(p.id, p.pid) : v; });
route('GET', '/api/offices/:id/procs/:pid/log', (req, res, p, q) => pr.readLog(O(p.id), p.pid, q.has('offset') ? Number(q.get('offset')) : null));
route('GET', '/api/offices/:id/terms', (req, res, p) => pr.listTerms(O(p.id)));
route('POST', '/api/offices/:id/terms', async (req, res, p) => pr.createTerm(O(p.id), (await body(req)).room));
route('PATCH', '/api/offices/:id/terms/:name', async (req, res, p) => pr.renameTerm(O(p.id), p.name, (await body(req)).title));
route('DELETE', '/api/offices/:id/terms/:name', (req, res, p) => pr.closeTerm(O(p.id), p.name));

/* pesan langsung antaragen */
route('GET', '/api/offices/:id/dm', (req, res, p, q) => dm.threads(O(p.id), { role: q.get('role') || null }));
route('GET', '/api/offices/:id/dm/:a/:b', (req, res, p) => dm.thread(O(p.id), p.a, p.b));

/* agent (MCP) */
route('GET', '/api/agent/tools', () => ({ tools: TOOLS }));
route('POST', '/api/agent/call', async req => {
  const b = await body(req);
  const ident = resolveIdentity(b);
  const out = await callTool(ident, b.tool, b.args || {});
  auditAgent(ident, String(b.tool || ''), b.args || {});
  return out;
});

/* ---------------- akun: members, sign-in pages ---------------- */
function meView() {
  const a = actor();
  return a ? { kind: a.kind, id: a.id || null, name: a.name, username: a.username || null, role: a.role, via: a.via || 'browser' } : null;
}
const memberActor = (m, ip) => ({ kind: 'member', id: m.id, username: m.username, name: m.name, role: m.role, ip });
// from the CLI (loopback) the link points at the public name, not 127.0.0.1
function inviteLink(req, token) {
  const names = cfg.akun?.names || [], host = String(req.headers.host || '');
  const base = names.includes(host) || !names.length ? `${isSecure(req) ? 'https' : 'http'}://${host}` : `https://${names[0]}`;
  return `${base}/undangan?k=${token}`;
}
const sessCookie = (req, value, maxAge) => `kc_sesi=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;
function page(res, status, html, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...extra });
  res.end(html);
}
async function formBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 2e4) throw new Error('Body terlalu besar'); }
  return Object.fromEntries(new URLSearchParams(s));
}
/** /masuk, /keluar, /undangan. Returns true when the request was one of them. */
async function akunPages(req, res, url) {
  const p = url.pathname;
  if (p !== '/masuk' && p !== '/keluar' && p !== '/undangan') return false;
  if (!allowedHosts().has(req.headers.host)) { logDenied(req, 'host'); res.writeHead(403); res.end(); return true; }
  if (!akunOn()) { res.writeHead(302, { Location: '/' }); res.end(); return true; }
  if (req.method === 'POST' && !originOk(req)) { logDenied(req, 'origin'); res.writeHead(403); res.end(); return true; }
  const ip = clientIp(req), ua = String(req.headers['user-agent'] || '');
  const days = Number(cfg.akun.sessionDays) || akun.SESSION_DAYS;
  if (p === '/masuk' && req.method === 'GET') {
    if (identify(req)) { res.writeHead(302, { Location: '/' }); res.end(); return true; }
    page(res, 200, loginHtml()); return true;
  }
  if (p === '/masuk' && req.method === 'POST') {
    const f = await formBody(req);
    try {
      const r = await akun.login({ username: f.username, password: f.password, code: f.code, ip, ua, days });
      audit.record('masuk', { as: memberActor(r.member, ip), text: 'masuk', meta: { ua: ua.slice(0, 120) } });
      res.writeHead(303, { 'Set-Cookie': sessCookie(req, r.cookie, days * 86400), Location: '/', 'Cache-Control': 'no-store' }); res.end();
    } catch (e) {
      audit.record('masuk-gagal', { as: { kind: 'anon', id: null, name: String(f.username || '').slice(0, 40) || '(kosong)', ip }, text: e.code === 429 ? 'ditahan: terlalu banyak percobaan' : 'gagal masuk', meta: { ua: ua.slice(0, 120) } });
      logDenied(req, 'login gagal');
      page(res, e.code === 429 ? 429 : 401, loginHtml({ error: e.message, username: f.username || '' }));
    }
    return true;
  }
  if (p === '/keluar' && req.method === 'POST') {
    const c = cookieOf(req, 'kc_sesi'), m = akun.memberForCookie(c);
    akun.logout(c);
    if (m) audit.record('keluar', { as: memberActor(m, ip), text: 'keluar' });
    res.writeHead(303, { 'Set-Cookie': sessCookie(req, '', 0), Location: '/masuk' }); res.end();
    return true;
  }
  if (p === '/undangan' && req.method === 'GET') {
    const k = url.searchParams.get('k') || '';
    page(res, 200, inviteHtml({ token: k, info: akun.inviteInfo(k) })); return true;
  }
  if (p === '/undangan' && req.method === 'POST') {
    const f = await formBody(req), info = akun.inviteInfo(f.k);
    if (!info) { page(res, 410, inviteHtml({ token: '', info: null })); return true; }
    if (f.password !== f.password2) { page(res, 400, inviteHtml({ token: f.k, info, error: 'Kedua password tidak sama.' })); return true; }
    try {
      const r = await akun.acceptInvite(f.k, { password: f.password, code: f.code, ip, ua });
      audit.record('akun', { as: memberActor(r.member, ip), text: 'mengaktifkan akun dari undangan' });
      res.writeHead(303, { 'Set-Cookie': sessCookie(req, r.cookie, akun.SESSION_DAYS * 86400), Location: '/', 'Cache-Control': 'no-store' }); res.end();
    } catch (e) {
      page(res, e.code === 410 ? 410 : 400, inviteHtml({ token: f.k, info: akun.inviteInfo(f.k), error: e.message }));
    }
    return true;
  }
  res.writeHead(405); res.end();
  return true;
}

const signedIn = () => { const a = actor(); if (a?.kind !== 'member') throw Object.assign(new Error('Hanya untuk anggota yang masuk dengan akun.'), { code: 403 }); return a; };
route('GET', '/api/akun/saya', () => ({ akun: akunOn(), me: meView() }));
route('POST', '/api/akun/password', async req => {
  const m = signedIn(), b = await body(req);
  await akun.changePassword(m.id, { current: b.current, next: b.next, code: b.code, keepCookie: cookieOf(req, 'kc_sesi') });
  return { ok: true };
});
route('GET', '/api/akun/token', () => ({ tokens: akun.listTokens(signedIn().id) }));
route('POST', '/api/akun/token', async req => {
  const m = signedIn();
  // a token cannot mint more tokens: only a browser login (password + 2FA) can
  if (m.via === 'token') throw Object.assign(new Error('Token baru hanya bisa dibuat dari browser.'), { code: 403 });
  const b = await body(req);
  return akun.createToken(m.id, { label: b.label, days: b.days === 0 ? 0 : Number(b.days) || 365 });
});
route('DELETE', '/api/akun/token/:tid', (req, res, p) => { akun.revokeToken(signedIn().id, p.tid); return { ok: true }; });
route('GET', '/api/akun/anggota', () => ({ members: akun.listMembers() }));
route('POST', '/api/akun/anggota', async req => {
  const r = akun.createMember(await body(req), actor()?.name || null);
  return { member: r.member, link: inviteLink(req, r.invite.token), until: r.invite.until };
});
route('PATCH', '/api/akun/anggota/:mid', async (req, res, p) => akun.updateMember(p.mid, await body(req)));
route('POST', '/api/akun/anggota/:mid/reset', (req, res, p) => { const r = akun.resetMember(p.mid); return { member: r.member, link: inviteLink(req, r.invite.token), until: r.invite.until }; });
route('GET', '/api/akun/anggota/:mid/sesi', (req, res, p) => ({ sessions: akun.sessionsOf(p.mid) }));

/* ---------------- audit ---------------- */
// non-admin members only ever see their own rows
function auditFilter(q) {
  const a = actor(), self = a?.kind === 'member' && a.role !== 'admin' ? a.id : null;
  const f = { self };
  for (const k of ['actor', 'kind', 'office', 'sid', 'q', 'from', 'to', 'before', 'limit']) if (q.get(k)) f[k] = q.get(k);
  return f;
}
route('GET', '/api/audit', (req, res, p, q) => audit.query(auditFilter(q)));
route('GET', '/api/audit.csv', (req, res, p, q) => {
  const f = auditFilter(q), rows = [];
  for (let i = 0, before = f.before; i < 200; i++) {
    const r = audit.query({ ...f, before, limit: 1000 });
    rows.push(...r.rows);
    if (!r.more) break;
    before = r.rows[r.rows.length - 1].id;
  }
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="riwayat-kantor-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
  res.end('﻿' + audit.toCsv(rows));
});
route('GET', '/api/audit/verify', () => audit.verify());

const short = (v, n) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const sessName = sid => { const s = live.get(sid); return s ? whoOf(s) : `sesi ${String(sid).slice(0, 8)}`; };
const cardName = (o, cid) => { try { return `"${short(st.getCard(o, cid)?.title || cid, 60)}"`; } catch { return cid; } };
const roleName = (o, rid) => { try { return st.getRole(o, rid)?.name || rid; } catch { return rid; } };
const inboxRow = iid => one(globalDb(), 'SELECT office, sid, role, tool, summary FROM inbox WHERE id = ?', iid);
const memberName = mid => akun.getMember(mid)?.name || mid;
// readable lines for the actions people look for; everything else is logged as "METHOD path"
const DESCRIBE = {
  'POST /api/inbox/:iid': (p, b) => { const it = inboxRow(p.iid); return `${b.behavior === 'allow' ? 'mengizinkan' : 'menolak'} ${it?.tool || 'izin'}${it?.summary ? ` (${short(it.summary, 100)})` : ''} untuk ${it?.sid ? sessName(it.sid) : 'sesi'}`; },
  'POST /api/inbox/:iid/answer': p => { const it = inboxRow(p.iid); return `menjawab pertanyaan ${it?.sid ? sessName(it.sid) : 'agen'}`; },
  'POST /api/sessions/:sid/action': (p, b) => b.action === 'text' ? `mengirim perintah ke ${sessName(p.sid)}: ${short(b.text, 200)}` : `aksi "${b.action}" pada ${sessName(p.sid)}`,
  'POST /api/sessions/:sid/mode': (p, b) => `mengganti mode izin ${sessName(p.sid)} → ${b.mode}`,
  'POST /api/sessions/:sid/adopt': p => `memindahkan ${sessName(p.sid)} ke kantor`,
  'POST /api/sessions/:sid/boss': (p, b) => `mengatur atasan ${sessName(p.sid)} → ${b.boss || 'tidak ada'}`,
  'POST /api/offices/:id/roles/:rid/start': (p, b) => `memulai shift ${roleName(p.id, p.rid)}${b.task ? `: ${short(b.task, 200)}` : ''}${b.permissionMode ? ` (mode ${b.permissionMode})` : ''}`,
  'POST /api/offices/:id/roles': (p, b) => `membuat role ${short(b.name, 40)}`,
  'PATCH /api/offices/:id/roles/:rid': (p, b) => `mengubah role ${roleName(p.id, p.rid)} (${Object.keys(b).join(', ')})`,
  'POST /api/offices/:id/cards': (p, b) => `membuat kartu "${short(b.title, 80)}"`,
  'PATCH /api/offices/:id/cards/:cid': (p, b) => `mengubah kartu ${cardName(p.id, p.cid)} (${Object.keys(b).filter(k => k !== 'whoName').join(', ')})`,
  'DELETE /api/offices/:id/cards/:cid': p => `mengarsipkan kartu ${cardName(p.id, p.cid)}`,
  'POST /api/offices/:id/cards/:cid/comment': (p, b) => `mengomentari kartu ${cardName(p.id, p.cid)}: ${short(b.text, 120)}`,
  'PUT /api/offices/:id/aturan': (p, b) => `mengubah aturan kantor [${b.kategori}]${b.alasan ? `: ${short(b.alasan, 100)}` : ''}`,
  'POST /api/offices/:id/wiki': (p, b) => `menulis wiki "${short(b.title || b.slug, 60)}"`,
  'DELETE /api/offices/:id/wiki/:slug': p => `menghapus wiki ${p.slug}`,
  'POST /api/offices/:id/git/:roomId/commit': (p, b) => `commit di ${p.roomId}: ${short(b.message ?? b.msg ?? b.subject, 100)}`,
  'POST /api/offices/:id/procs/:pid/start': p => `menjalankan proses ${p.pid}`,
  'POST /api/offices/:id/procs/:pid/stop': p => `menghentikan proses ${p.pid}`,
  'POST /api/offices/:id/procs/:pid/restart': p => `memulai ulang proses ${p.pid}`,
  'POST /api/offices/:id/procs/:pid/approve': p => `menyetujui proses ${p.pid}`,
  'POST /api/offices/:id/terms': (p, b) => `membuat terminal baru${b.room ? ` di ${b.room}` : ''}`,
  'POST /api/offices/:id/meetings': (p, b) => `memulai rapat "${short(b.topic, 80)}"`,
  'POST /api/offices/:id/meetings/:mid/say': (p, b) => `menyela rapat: ${short(b.text, 160)}`,
  'POST /api/settings': () => 'mengubah pengaturan kantor',
  'POST /api/akun/anggota': (p, b) => `membuat akun ${short(b.username, 32)} (${b.role || 'anggota'})`,
  'PATCH /api/akun/anggota/:mid': (p, b) => `mengubah akun ${memberName(p.mid)}${b.disabled === true ? ': dinonaktifkan' : b.disabled === false ? ': diaktifkan lagi' : ''}${b.role ? `, peran ${b.role}` : ''}`,
  'POST /api/akun/anggota/:mid/reset': p => `mereset password dan 2FA ${memberName(p.mid)} (undangan baru)`,
  'POST /api/akun/password': () => 'mengganti password sendiri',
  'POST /api/akun/token': (p, b) => `membuat token aplikasi "${short(b.label || 'Aplikasi', 40)}"`,
  'DELETE /api/akun/token/:tid': p => `mencabut token aplikasi ${p.tid}`,
};
// frequent, cosmetic, or already covered elsewhere
const AUDIT_SKIP = [
  /^POST \/api\/hook$/, /^POST \/api\/agent\/call$/, /^POST \/api\/usage\/limits\/claude$/,
  /^PUT \/api\/offices\/[^/]+\/(owner|minions)$/, /^PUT \/api\/owner\/look$/, /\/layout\/check$/, /\/rooms\/preview$/, /^POST \/api\/wizard\/preview$/, /\/template\/preview$/,
  /\/pratinjau\/[^/]+\/lihat$/, /^PUT \/api\/settings\/tabs$/, /\/model\/(open|cancel)$/, /^POST \/api\/shows\//, /^PUT \/api\/uploads\//,
];
function auditRequest(req, url, r, params, status, error) {
  const sig = `${req.method} ${url.pathname}`;
  if (AUDIT_SKIP.some(re => re.test(sig))) return;
  const b = req._body && typeof req._body === 'object' ? req._body : {};
  let text = null;
  try { text = DESCRIBE[`${req.method} ${r.pattern}`]?.(params, b) || null; } catch {}
  const office = params.id && params.id !== '_kompleks' ? params.id : (params.iid ? inboxRow(params.iid)?.office : null) || null;
  const sid = params.sid || (params.iid ? inboxRow(params.iid)?.sid : null) || null;
  const query = Object.fromEntries(url.searchParams);
  audit.record('api', {
    office, sid,
    text: (text || `${req.method} ${url.pathname}`) + (status >= 400 ? ` — gagal: ${short(error || status, 120)}` : ''),
    meta: { method: req.method, path: url.pathname, status, ...(req._body !== undefined ? { body: req._body } : {}), ...(Object.keys(query).length ? { query } : {}) },
  });
}

// agents: everything except reading; messages pass the human origin on to the roles they reach
const READ_TOOL = /(^|_)(list|get|read|search|tree|lihat|status|log|katalog)$|^tunggu|^template_pratinjau$|^tangkap_layar$/;
const PASS_TOOLS = new Set(['pesan_ke', 'kabari', 'tanya', 'siaran', 'card_create', 'card_update', 'meeting_start']);
function rolesFor(office, ke) {
  let roles = []; try { roles = st.listRoles(office); } catch { return []; }
  const want = ke === 'semua' ? roles.map(r => r.id) : (Array.isArray(ke) ? ke : [ke]).filter(Boolean).map(String);
  return want.flatMap(w => w.toLowerCase() === 'manager' ? roles.filter(r => r.isMgr).map(r => r.id) : roles.filter(r => r.id === w || r.name.toLowerCase() === w.toLowerCase()).map(r => r.id));
}
function auditAgent(ident, tool, args) {
  if (!tool || READ_TOOL.test(tool)) return;
  if (PASS_TOOLS.has(tool)) for (const rid of rolesFor(ident.office, args.ke ?? args.who ?? args.peserta)) audit.passOrigin(ident.office, ident.sid, rid);
  const target = args.ke ?? args.who ?? null;
  const said = args.teks ?? args.title ?? args.judul ?? args.text ?? '';
  audit.record('agen', {
    as: { kind: 'agent', id: null, name: ident.by || 'Agen' }, office: ident.office, sid: ident.sid || null,
    text: `${tool}${target ? ` → ${Array.isArray(target) ? target.join(', ') : target}` : ''}${said ? `: ${short(said, 160)}` : ''}`,
    meta: { tool, args }, origin: audit.originOf(ident.sid),
  });
}

// prompts as Claude received them, credited to whoever typed in that pane (audit.markTyping)
bus.on('prompt', ({ sid, prompt }) => {
  if (!prompt || /^\s*</.test(prompt)) return;
  try { audit.recordPrompt(live.get(sid), prompt); } catch (e) { console.error('audit prompt:', e.message); }
});
bus.on('msg', m => { if (m?.t === 'session' && m.session?.status === 'ended') audit.forgetSession(m.session.sid); });

/* ---------------- login page (phones: paste the token instead of typing it into the address) ---------------- */
function loginPage(res, status, wrong) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Masuk · Kantor Claude</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBF4EA;color:#1F1628;font:16px/1.5 system-ui,-apple-system,sans-serif;padding:20px;box-sizing:border-box}
form{box-sizing:border-box;width:100%;max-width:380px;display:grid;gap:12px;background:#FFFCF7;border:1px solid #E8DDCD;border-radius:16px;padding:22px}
h1{margin:0;font-size:22px}p{margin:0;color:#675A6D;font-size:14px}label{font-weight:600;font-size:14px}
input{font:15px ui-monospace,Menlo,monospace;padding:12px;border:1px solid #E8DDCD;border-radius:10px;background:#FBF4EA;color:#1F1628;width:100%;box-sizing:border-box}
button{min-height:48px;border:0;border-radius:12px;background:#F59A3C;color:#3A240F;font:700 16px system-ui,sans-serif}
.err{background:#F9E0DA;color:#8E2F1F;border-radius:10px;padding:10px 12px;font-size:14px}</style>
<form method="get" action="/"><h1>Kantor Claude</h1><p>Tempel token kantor. Cukup sekali per perangkat; setelah itu browser mengingatnya.</p>
${wrong ? '<div class="err" role="alert">Token salah. Periksa huruf besar-kecil dan jangan ada spasi.</div>' : ''}
<label for="token">Token</label><input id="token" name="token" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
<button type="submit">Masuk</button><p>Token ada di <code>~/.kantor-claude/config.json</code> di Mac.</p></form></html>`);
}
const logDenied = (req, why) => console.error(`akses ditolak (${why}): host=${req.headers.host} path=${req.url.split('?')[0]} dari=${req.socket.remoteAddress} ua=${String(req.headers['user-agent'] || '').slice(0, 80)}`);

/* ---------------- server ---------------- */
async function handle(req, res) {
  guardFraming(res);
  const url = new URL(req.url, 'http://x');
  if (await akunPages(req, res, url)) return;
  if (url.pathname === '/' && url.searchParams.get('token')) {
    if (!allowedHosts().has(req.headers.host)) { logDenied(req, 'host'); res.writeHead(403); return res.end(); }
    if (akunOn()) { res.writeHead(302, { Location: '/masuk' }); return res.end(); }
    if (url.searchParams.get('token').trim() !== cfg.token) { logDenied(req, 'token salah'); return loginPage(res, 403, true); }
    const next = url.searchParams.get('next') || '';
    res.writeHead(302, { 'Set-Cookie': `kc_token=${encodeURIComponent(cfg.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${req.socket.encrypted ? '; Secure' : ''}`, Location: '/' + (next.startsWith('#/') ? next : '') });
    return res.end();
  }
  // pratinjau files: signed path instead of the cookie (a sandboxed page has an opaque origin and sends none)
  if (url.pathname.startsWith('/pv/') || url.pathname.startsWith('/pvt/')) {
    if (!allowedHosts().has(req.headers.host)) { logDenied(req, 'host'); res.writeHead(403); return res.end(); }
    try { await pv.serve(req, res, url.pathname); } catch { if (!res.headersSent) { res.writeHead(500); res.end(); } }
    return;
  }
  // a shown HTML file (tunjukkan): same idea, signed per show
  if (url.pathname.startsWith('/sv/')) {
    if (!allowedHosts().has(req.headers.host)) { logDenied(req, 'host'); res.writeHead(403); return res.end(); }
    try { serveShow(req, res, url.pathname); } catch { if (!res.headersSent) { res.writeHead(500); res.end(); } }
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const a = identify(req);
    if (!a) return send(res, 401, { error: akunOn() ? 'Belum masuk. Buka /masuk' : 'Butuh token. Buka alamat dari perintah: kantor open' });
    if (akunOn() && req.method !== 'GET' && !originOk(req)) { logDenied(req, 'origin'); return send(res, 403, { error: 'Asal permintaan ditolak.' }); }
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
    if (!r) return send(res, 404, { error: 'Tidak ditemukan' });
    const denied = policy(a, `${req.method} ${url.pathname}`);
    if (denied) { logDenied(req, 'kebijakan'); return send(res, 403, { error: denied }); }
    const m = r.re.exec(url.pathname);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return withActor(a, async () => {
      let status = 200, error = null;
      try {
        const out = await r.fn(req, res, params, url.searchParams);
        if (!res.headersSent) send(res, 200, out); else status = res.statusCode;
      } catch (e) {
        status = [401, 403, 404, 409, 410, 413, 416, 429].includes(e.code) ? e.code : 400; error = e.message;
        if (!res.headersSent) send(res, status, { error: e.message, ...(e.offset !== undefined ? { offset: e.offset } : {}) });
      }
      if (req.method !== 'GET') auditRequest(req, url, r, params, status, error);
    });
  }
  // static
  if (!allowedHosts().has(req.headers.host)) { logDenied(req, 'host'); res.writeHead(403); return res.end(); }
  if (!identify(req)) {
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
      logDenied(req, 'belum login');
      if (akunOn()) { res.writeHead(302, { Location: '/masuk', 'Cache-Control': 'no-store' }); return res.end(); }
      return loginPage(res, 401, false);
    }
    res.writeHead(401); return res.end();
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
  const a = identify(req);
  if (!a) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return sock.destroy(); }
  if (akunOn() && !originOk(req)) { logDenied(req, 'origin'); sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return sock.destroy(); }
  req._actor = a;
  if (url.pathname === '/ws') wssEvents.handleUpgrade(req, sock, head, ws => wssEvents.emit('connection', ws, req));
  else if (url.pathname === '/ws/term') wssTerm.handleUpgrade(req, sock, head, ws => wssTerm.emit('connection', ws, req, url));
  else sock.destroy();
}

wssEvents.on('connection', ws => {
  ws.send(JSON.stringify({ t: 'hello', inbox: openInbox() }));
  // {t:'sysmon-sub'} every <60s keeps the Performa PC sampler at full rate for this viewer
  ws.on('message', d => { try { if (JSON.parse(String(d)).t === 'sysmon-sub') sysmon.touch(); } catch {} });
});
bus.on('msg', m => { const s = JSON.stringify(m); for (const c of wssEvents.clients) if (c.readyState === 1) c.send(s); });

wssTerm.on('connection', (ws, req, url) => {
  let name, sess = null;
  const kind = url.searchParams.get('kind');
  try {
    if (kind === 'session') {
      const s = sess = live.get(url.searchParams.get('sid'));
      name = s?.tmux;
      if (!name || !hasTmux(name)) throw new Error('Sesi ini tidak berjalan di tmux kantor.');
    } else if (kind === 'shell') name = ensureShell(url.searchParams.get('office'), url.searchParams.get('room'));
    else if (kind === 'dock') { name = url.searchParams.get('name'); if (!pr.dockSessionOk(name)) throw new Error('Terminal ini sudah tidak ada.'); }
    else throw new Error('Jenis terminal tidak dikenal');
  } catch (e) { ws.send(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`); return ws.close(); }
  const cols = Number(url.searchParams.get('cols')) || 100, rows = Number(url.searchParams.get('rows')) || 30;
  const by = req._actor || LOCAL, opened = Date.now();
  const label = kind === 'session' ? `terminal sesi ${sess ? whoOf(sess) : name}` : kind === 'shell' ? `terminal shell ${url.searchParams.get('room') || ''}`.trim() : `terminal ${name}`;
  const where = { as: by, office: sess?.office || url.searchParams.get('office') || null, sid: sess?.sid || null, meta: { kind, tmux: name } };
  audit.record('terminal', { ...where, text: `membuka ${label}` });
  const p = pty.spawn(bins().tmux, ['attach-session', '-t', name], { name: 'xterm-256color', cols, rows, cwd: process.env.HOME, env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' } });
  // Claude's TUI repaints in many tiny writes: send them as one message per tick
  let out = '', flushing = false;
  p.onData(d => { out += d; if (!flushing) { flushing = true; setTimeout(() => { flushing = false; if (ws.readyState === 1 && out) ws.send(out); out = ''; }, 4); } });
  let size = `${cols}x${rows}`;
  let dead = false;
  p.onExit(() => { dead = true; try { ws.send('\r\n\x1b[90m[terminal ditutup]\x1b[0m\r\n'); ws.close(); } catch {} });
  ws.on('message', (data, isBinary) => {
    const s = data.toString();
    if (!isBinary && s.startsWith('\x00{')) { try { const m = JSON.parse(s.slice(1)); if (m.cols && m.rows) { const c = Math.max(20, m.cols), r = Math.max(5, m.rows); if (`${c}x${r}` !== size) { size = `${c}x${r}`; p.resize(c, r); } } } catch {} return; }
    // keystrokes can still arrive after tmux detached; writing then would fail with EIO
    if (!dead) try { p.write(s); audit.markTyping(name, by); } catch {}
  });
  ws.on('close', () => {
    dead = true; try { p.kill(); } catch {}
    const min = Math.round((Date.now() - opened) / 60000);
    audit.record('terminal', { ...where, text: `menutup ${label} (${min < 1 ? '<1' : min} menit)` });
  });
});

function listen() {
  const hosts = [cfg.host, ...cfg.extraHosts.filter(h => h && h !== cfg.host)];
  const [first, ...rest] = hosts;
  server.listen(cfg.port, first, () => {
    fs.writeFileSync(SERVER_JSON, JSON.stringify({ port: cfg.port, token: cfg.token, pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    // the token stays out of the log file; it is in ~/.kantor-claude/config.json
    console.log(`Kantor Claude jalan di http://${first}:${cfg.port}/ (token: lihat config.json)`);
    for (const h of rest) makeServer().listen(cfg.port, h, () => console.log(`  juga di http://${h}:${cfg.port}`)).on('error', e => console.error(`Tidak bisa listen di ${h}: ${e.message}`));
    listenTls();
  });
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${cfg.port} sudah dipakai. Mungkin Kantor Claude sudah jalan.` : e.message); process.exit(1); });
}

/** HTTPS on its own address (a Tailscale IP behind a real domain). The certificate is reloaded when it is renewed. */
function listenTls() {
  const t = cfg.tls;
  if (!t?.cert || !t?.key || !t?.host) return;
  const creds = () => ({ cert: fs.readFileSync(t.cert), key: fs.readFileSync(t.key) });
  let srv;
  try { srv = https.createServer(creds(), handle).on('upgrade', onUpgrade); } catch (e) { return console.error(`HTTPS tidak jalan: ${e.message}`); }
  const port = t.port || 443;
  srv.listen(port, t.host, () => console.log(`  juga di https://${(t.names || [])[0] || t.host}${port === 443 ? '' : ':' + port}`))
    .on('error', e => console.error(`Tidak bisa listen HTTPS di ${t.host}:${port}: ${e.message}`));
  // plain http on the same names only sends people to https
  if (t.httpPort) http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    if (!(t.names || []).includes(host)) { res.writeHead(404); return res.end(); }
    res.writeHead(301, { Location: `https://${host}${req.url || '/'}` }); res.end();
  }).listen(t.httpPort, t.host).on('error', e => console.error(`Tidak bisa listen http di ${t.host}:${t.httpPort}: ${e.message}`));
  fs.watchFile(t.cert, { interval: 60 * 60e3 }, () => { try { srv.setSecureContext(creds()); console.log('Sertifikat HTTPS dimuat ulang'); } catch (e) { console.error(`Sertifikat baru gagal dimuat: ${e.message}`); } });
}

// KANTOR_DEMO=1: a showroom daemon (screenshots, demos) that never touches real sessions or transcripts
const DEMO = process.env.KANTOR_DEMO === '1';
if (!DEMO) { adoptRunning(); adoptManual(); }
listen();
startNotify();
if (!DEMO) sysmon.startSysmon();
att.startAttachments();
startOutbox();
dm.startDm();
if (!DEMO) pv.startCleanup(); // pratinjau: daily cleanup of finished items' files (config.pratinjau.cleanupDays)
startTunggu();
autopilot.startAutopilot();
budget.startBudget(listOffices);
startHookContext();
startOwnerSweep();
try { pr.discoverProcs(); } catch (e) { console.error('proses:', e.message); }
for (const o of listOffices()) try { markInterrupted(o.id); } catch {}
if (!DEMO) { setTimeout(() => scanProcesses(), 1500); setInterval(() => scanProcesses(), 20e3).unref(); }
// own timer: a slow or stuck process scan must not keep dead shift sessions on the board
if (!DEMO) setInterval(() => { try { reapGoneTmux(); } catch (e) { console.error('reap tmux:', e.message); } }, 20e3).unref();
if (!DEMO) startTailWatch(); // pushes { t: 'transcript' } to chat views when a session's transcript grows
// keep the permission mode of office panes current (it changes with Shift+Tab, which sends no hook)
// async and one pane at a time, so the terminal bridge never waits on tmux
let modeBusy = false;
setInterval(async () => {
  if (modeBusy) return;
  modeBusy = true;
  try {
    for (const s of [...live.values()]) {
      if (!s.tmux || s.status === 'ended' || s.engine === 'antigravity') continue;
      const m = await paneModeAsync(s.tmux);
      if (m && m !== s.permMode) { s.permMode = m; bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) }); }
    }
  } finally { modeBusy = false; }
}, 5000).unref();
if (!DEMO) { setTimeout(() => scanUsage(), 3000); setInterval(() => scanUsage(), 90e3).unref(); }
if (!DEMO) setInterval(() => { try { pollCodexLimits(); } catch {} }, 60e3).unref();
if (!DEMO) { const cx = () => { try { scanCodexUsage(); } catch (e) { console.error('usage codex:', e.message); } }; setTimeout(cx, 5000); setInterval(cx, 120e3).unref(); }
const stop = () => { try { if (JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8')).pid === process.pid) fs.unlinkSync(SERVER_JSON); } catch {} closeAll(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
