// The owner as a character on the floor plan ("Masuk kantor"): walk with WASD/arrows, a tap/click target (A*) or the touch joystick,
// use furniture by its affordances, greet and talk to agents. The position goes to the daemon (GET/PUT /api/offices/:id/owner,
// live event {t:'owner'}), so other clients (and Ghina) see the owner too; an owner driven from elsewhere is drawn from those events.
// The stage (office-canvas.js) exposes stage.owner: world, ents, findPath, camera, tap and tick hooks.
import { api, post, patch, toast, modal, closeModal, esc, short, onLive, SWATCHES, SKINS, HAIRS } from './util.js';
import { openSession } from './drawer.js';
import { openDock } from './dock.js';
import { HAIR_STYLES, OUTFITS, ACCS, HIJABS } from './chars.js';
import { usirMinion } from './minions-ui.js';

const ME = 'owner:me', REMOTE = 'owner:remote';
const CLIENT = (() => { try { let v = sessionStorage.getItem('kc.owner.client'); if (!v) sessionStorage.setItem('kc.owner.client', v = 'web-' + Math.random().toString(36).slice(2, 10)); return v; } catch { return 'web-' + Math.random().toString(36).slice(2, 10); } })();
const SEND_MS = 250, BEAT_MS = 30e3, NEAR_AGENT = 2, SPEED = 72;
const DIRS = { w: [0, -1], arrowup: [0, -1], s: [0, 1], arrowdown: [0, 1], a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0] };
let resumeAt = null;   // {office, until}: the owner was here a moment ago (another tab of the office was opened), come back at the same spot

function loadCss() { if (document.querySelector('link[data-owner-css]')) return; const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/owner.css'; l.dataset.ownerCss = '1'; document.head.appendChild(l); }

/* what the owner can do with furniture, by affordance. pose: where to stand and how; open: a panel */
const USE = [
  { aff: 'whiteboard', label: 'Buka Board', open: 'board' },
  { aff: 'meeting', label: 'Buka Rapat', open: 'rapat' },
  { aff: 'meeting', label: 'Duduk', pose: 'sit', need: 'sit' },
  { aff: 'server', label: 'Panel Proses', open: 'proses' },
  { aff: 'wudhu', label: 'Wudhu lalu sholat', pose: 'stand', fx: 'wudhu', then: 'pray' },
  { aff: 'pray', label: 'Sholat', pose: 'pray', fx: 'pray', wudhuFirst: true },
  { aff: 'sleep', label: 'Tidur siang', pose: 'sleep', fx: 'sleep' },
  { aff: 'sofa', label: 'Duduk santai', pose: 'sit', fx: 'sofa' },
  { aff: 'sit', label: 'Duduk', pose: 'sit', fx: 'sit' },
  { aff: 'coffee', label: 'Ambil kopi', pose: 'stand', fx: 'coffee' },
  { aff: 'water', label: 'Ambil air', pose: 'stand', fx: 'water' },
  { aff: 'snack', label: 'Ambil snack', pose: 'stand', fx: 'snack' },
  { aff: 'eat', label: 'Makan', pose: 'any', fx: 'eat' },
  { aff: 'play', label: 'Main', pose: 'any', fx: 'play' },
  { aff: 'game', label: 'Main game', pose: 'any', fx: 'game' },
  { aff: 'music', label: 'Main musik', pose: 'any', fx: 'music' },
  { aff: 'exercise', label: 'Olahraga', pose: 'exercise', fx: 'exercise' },
  { aff: 'read', label: 'Baca', pose: 'read', fx: 'read' },
  { aff: 'phone', label: 'Telepon', pose: 'stand', fx: 'phone' },
  { aff: 'train', label: 'Lihat', pose: 'stand', fx: 'train' },
];
const WIKI_RX = /rak-buku|rak-quran|katalog|rak-dokumen|perpus/;
const NEWS_RX = /pengumuman/;
// built-in (non-catalog) sprites of the generated rooms, by sprite name (office-canvas `_k`)
function builtinUses(k) {
  if (k === 'shelf') return [{ label: 'Buka Wiki', open: 'wiki' }, { label: 'Baca', pose: 'read', fx: 'read' }];
  if (k === 'rack') return [{ label: 'Panel Proses', open: 'proses' }];
  if (k === 'mtable') return [{ label: 'Buka Rapat', open: 'rapat' }, { label: 'Duduk', pose: 'sit', fx: 'meeting' }];
  if (k === 'wbstand') return [{ label: 'Buka Board', open: 'board' }];
  if (/^(sofa|arm|bean)/.test(k)) return [{ label: 'Duduk', pose: 'sit', fx: 'sofa' }];
  if (k === 'counter') return [{ label: 'Ambil kopi', pose: 'stand', fx: 'coffee' }];
  if (k === 'water') return [{ label: 'Ambil air', pose: 'stand', fx: 'water' }];
  if (k === 'fridge' || k === 'vending') return [{ label: 'Ambil snack', pose: 'stand', fx: 'snack' }];
  if (k === 'arcade') return [{ label: 'Main game', pose: 'stand', fx: 'game' }];
  return null;
}
const BUILTIN_NAME = { shelf: 'Rak buku', rack: 'Server rack', mtable: 'Meja rapat', wbstand: 'Whiteboard', counter: 'Pantry', water: 'Dispenser', fridge: 'Kulkas', vending: 'Vending', arcade: 'Arcade' };

export function attachOwner(stage) {
  const O = stage.owner, frame = O.host.parentElement, tools = frame?.querySelector('.kf-tools');
  if (!tools) return null;
  loadCss();
  let main = null, destroyed = false;
  const ready = import('./main.js').then(m => { main = m; });
  const office = () => main?.ctx.office || null;
  const ctx = () => main?.ctx;
  const T = O.T;
  let me = null, remote = null, active = false, follow = true, followAt = 0, kstep = null, use = null, sub = null, focusSid = null;
  let pickKey = null, sent = { at: 0, sig: '' }, beat = 0, nearT = 0, near = null, barSig = '', joy = null, lastWudhu = 0, mgrAskedAt = 0;
  const keys = new Set(), greeted = new Map();

  /* ---------- DOM: entry button, HUD, action bar, joystick ---------- */
  const btn = document.createElement('button');
  btn.className = 'zbtn ow-enter'; btn.textContent = 'Masuk kantor'; btn.title = 'Jalan-jalan di kantor sebagai pemilik (WASD/panah, klik tujuan)';
  const hud = document.createElement('div');
  hud.className = 'ow-hud'; hud.hidden = true;
  hud.innerHTML = `<button class="zbtn" data-ow="look" title="Ubah tampilanmu">Tampilan</button><button class="zbtn" data-ow="follow" aria-pressed="true" title="Kamera mengikuti (F)">Ikuti</button><button class="zbtn" data-ow="leave" title="Keluar kantor lewat lift">Keluar</button>`;
  tools.append(hud, btn);   // at the end: on a phone the tool row scrolls and its end is what shows
  const bar = document.createElement('div');
  bar.className = 'ow-bar'; bar.hidden = true; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Aksi di dekatmu');
  frame.appendChild(bar);
  const hint = document.createElement('div');
  hint.className = 'ow-hint'; hint.hidden = true; hint.textContent = 'WASD/panah untuk jalan · klik lantai untuk menuju · E untuk aksi';
  frame.appendChild(hint);
  const touch = matchMedia('(pointer: coarse)').matches;
  const joyEl = document.createElement('div');
  joyEl.className = 'ow-joy'; joyEl.hidden = true; joyEl.innerHTML = '<span class="ow-knob"></span>';
  frame.appendChild(joyEl);

  btn.addEventListener('click', () => enter());
  hud.addEventListener('click', e => {
    const b = e.target.closest('[data-ow]'); if (!b) return;
    if (b.dataset.ow === 'leave') leave();
    if (b.dataset.ow === 'follow') setFollow(!follow);
    if (b.dataset.ow === 'look') lookEditor();
  });
  bar.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b && !b.disabled) runAction(Number(b.dataset.i)); });

  /* ---------- joystick (touch) ---------- */
  joyEl.addEventListener('pointerdown', e => { e.preventDefault(); joyEl.setPointerCapture(e.pointerId); joy = { id: e.pointerId, dx: 0, dy: 0 }; joyMove(e); });
  joyEl.addEventListener('pointermove', e => { if (joy && e.pointerId === joy.id) joyMove(e); });
  const joyEnd = e => { if (joy && e.pointerId === joy.id) { joy = null; joyEl.querySelector('.ow-knob').style.transform = ''; } };
  joyEl.addEventListener('pointerup', joyEnd); joyEl.addEventListener('pointercancel', joyEnd);
  function joyMove(e) {
    const r = joyEl.getBoundingClientRect(), R = r.width / 2, x = e.clientX - r.left - R, y = e.clientY - r.top - R, d = Math.hypot(x, y), k = d > R * .8 ? R * .8 / d : 1;
    joyEl.querySelector('.ow-knob').style.transform = `translate(${x * k}px, ${y * k}px)`;
    if (d < R * .28) { joy.dx = 0; joy.dy = 0; return; }
    const a = Math.atan2(y, x), oct = Math.round(a / (Math.PI / 4));
    joy.dx = Math.round(Math.cos(oct * Math.PI / 4)); joy.dy = Math.round(Math.sin(oct * Math.PI / 4));
  }

  /* ---------- keyboard ---------- */
  const typing = e => e.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm') || !document.getElementById('modal')?.hidden;
  function onKey(e) {
    if (!active || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    const k = e.key.toLowerCase();
    if (DIRS[k]) { keys.add(k); e.preventDefault(); return; }
    if ((k === 'enter' || k === ' ') && e.target.closest?.('button, a, [role="button"]')) return;
    if (k === 'e' || k === 'enter' || k === ' ') { e.preventDefault(); runAction(0); return; }
    if (/^[1-9]$/.test(k)) { runAction(Number(k) - 1); return; }
    if (k === 'f') { setFollow(!follow); return; }
    if (k === 'q') { const i = actions.findIndex(a => a.key === 'Q'); if (i >= 0) runAction(i); return; }
    if (k === 'escape' && (sub || use)) { e.stopPropagation(); if (sub) { sub = null; renderBar(true); } else standUp(); }
  }
  const onKeyUp = e => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();
  window.addEventListener('keydown', onKey, true); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur);
  const onHide = () => { if (active) send({ present: false }, true); };
  window.addEventListener('pagehide', onHide);

  /* ---------- server sync ---------- */
  const tileX = e => (e.x - 4) / T, tileY = e => (e.y - 7) / T;
  function payload() {
    const tx = Math.round(tileX(me)), ty = Math.round(tileY(me));
    return { x: +tileX(me).toFixed(2), y: +tileY(me).toFixed(2), face: me.dir || 'down', room: O.roomAt(tx, ty), pose: me.pose || null, fx: me.pose ? me.fx || null : null, present: true, client: CLIENT };
  }
  function send(extra, unloading) {
    const o = office(); if (!o) return;
    const body = { ...(me && active ? payload() : {}), ...extra, client: CLIENT };
    sent.at = performance.now();
    if (unloading) { try { fetch(`/api/offices/${encodeURIComponent(o.id)}/owner`, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch {} return; }
    api(`/api/offices/${encodeURIComponent(o.id)}/owner`, { method: 'PUT', body }).catch(() => {});
  }
  function maybeSend(now) {
    if (!me || !active) return;
    const p = payload(), sig = `${p.x},${p.y},${p.face},${p.pose},${p.fx}`;
    if (sig !== sent.sig && now - sent.at >= SEND_MS) { sent.sig = sig; beat = now; send(p); }
    else if (now - beat > BEAT_MS) { beat = now; send(p); }
  }

  /* ---------- enter / leave ---------- */
  async function enter(at) {
    await ready;
    if (active || destroyed || O.editing) return;
    const o = office(); if (!o) return;
    let cur = null;
    try { cur = await api(`/api/offices/${encodeURIComponent(o.id)}/owner`); } catch {}
    if (remote) { remote.fade = true; remote = null; }
    O.engine.unclaim(REMOTE);
    me = O.spawn(ME, { ...(cur?.look || {}), crown: true });
    me.name = 'Kamu'; me.speed = SPEED;
    const el = O.world.elevator;
    if (at && O.walkable(Math.round(at.x), Math.round(at.y))) { me.x = Math.round(at.x) * T + 4; me.y = Math.round(at.y) * T + 7; me.dir = at.face || 'down'; }
    else { O.openElevator(1800); me.q.push({ t: 'go', tx: el.tx, ty: el.ty + 2 }); }
    active = true; kstep = null; use = null; sub = null; focusSid = null;
    btn.hidden = true; hud.hidden = false; hint.hidden = false; setTimeout(() => { hint.hidden = true; }, 6000);
    joyEl.hidden = !touch;
    setFollow(true);
    O.centerOn(me.x, me.y - 8, Math.max(O.zoom, 2.6));
    sent.sig = ''; sent.at = 0;
    send(payload());
  }
  function leave() {
    if (!active || !me) return;
    standUp(true);
    active = false; keys.clear(); kstep = null; sub = null;
    btn.hidden = false; hud.hidden = true; bar.hidden = true; hint.hidden = true; joyEl.hidden = true; barSig = '';
    send({ present: false });
    const e = me; me = null;
    e.q = [{ t: 'go', tx: O.world.elevator.tx, ty: O.world.elevator.ty }, { t: 'call', fn: () => { O.openElevator(1500); e.fade = true; } }];
    e.cur = null; e.path = [];
  }
  function setFollow(v) { follow = v; followAt = performance.now(); hud.querySelector('[data-ow="follow"]').setAttribute('aria-pressed', String(v)); }

  /* ---------- using things ---------- */
  function standUp(quiet) {
    if (!me) return;
    O.engine.unclaim(ME);
    if (me.pose) { me.pose = null; me.fx = null; me.poseInst = null; }
    if (me.baseY != null) { me.y = me.baseY; me.baseY = null; }
    use = null;
    if (!quiet) renderBar(true);
  }
  function cancelWalk() { if (me) { me.q = []; me.cur = null; me.path = []; } }
  function walkTo(tx, ty, then) {
    cancelWalk();
    me.q.push({ t: 'go', tx, ty });
    if (then) me.q.push({ t: 'call', fn: then });
  }
  const dirTo = (fx, fy, tx, ty) => { const dx = tx - fx, dy = ty - fy; return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'); };
  function sitAt(tx, ty, u, extra = {}) {
    me.x = tx * T + 4; me.y = ty * T + 7; me.mode = 'stand';
    if (extra.dy) { me.baseY = me.y; me.y += extra.dy; }
    me.dir = extra.face || me.dir; me.pose = u.pose === 'any' ? 'stand' : u.pose; me.fx = u.fx || null; me.poseAt = performance.now(); me.poseInst = extra.inst || null;
    if (me.pose === 'stand' && ['play', 'game', 'music'].includes(u.fx)) me.pose = 'play';
    use = { label: u.label, what: extra.what || '', fx: u.fx, room: O.roomAt(tx, ty) };
    if (u.fx === 'wudhu') lastWudhu = Date.now();
    renderBar(true);
    if (u.then === 'pray') setTimeout(() => { if (use?.fx === 'wudhu' && active) goPray(); }, 4500);
    if (me.pose === 'sit') meetingCheck();
  }
  // catalog furniture: claim a free spot (the one the agents would use), walk there, take the pose
  function useInst(inst, u) {
    if (u.open) return openPanel(u.open, inst.roomId);
    const [ex, ey] = [Math.round(tileX(me)), Math.round(tileY(me))];
    let best = -1, bd = Infinity, taken = null;
    inst.spots.forEach((sp, i) => {
      if (!sp.ok) return;
      if (u.need && sp.pose !== u.need) return;
      if (sp.occ && sp.occ !== ME && !O.ents.get(sp.occ)?.minion) { taken = sp.occ; return; }   // a Magang gives the spot up
      const d = Math.abs(sp.tx - ex) + Math.abs(sp.ty - ey); if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) { const who = taken && O.ents.get(taken)?.name; return toast(who ? `${inst.def.name} sedang dipakai ${who}` : `${inst.def.name} tidak punya tempat yang bisa dipakai`, 'warn'); }
    if (u.wudhuFirst && Date.now() - lastWudhu > 15 * 60e3 && wudhuInst()) { const w = wudhuInst(); return useInst(w.inst, USE.find(x => x.aff === 'wudhu')); }
    standUp(true);
    O.engine.claim(ME, inst, best);
    const sp = inst.spots[best];
    walkTo(sp.tx, sp.ty, () => { if (!me) return; if (Math.abs(Math.round(tileX(me)) - sp.tx) > 1 || Math.abs(Math.round(tileY(me)) - sp.ty) > 1) { O.engine.unclaim(ME); return toast('Tidak bisa sampai ke sana', 'warn'); } sitAt(sp.tx, sp.ty, { ...u, pose: u.pose === 'any' || u.pose === 'stand' ? (sp.pose === 'stand' ? u.pose : sp.pose) : u.pose }, { face: sp.face, inst, what: inst.def.name }); });
  }
  const wudhuInst = () => { const [ex, ey] = [tileX(me), tileY(me)]; return O.engine.insts.filter(i => i.def.affords?.includes('wudhu') && i.spots.some(s => s.ok && (!s.occ || s.occ === ME))).map(inst => ({ inst, d: Math.hypot(inst.x - ex, inst.y - ey) })).sort((a, b) => a.d - b.d)[0] || null; };
  function goPray() {
    const [ex, ey] = [tileX(me), tileY(me)];
    const c = O.engine.insts.filter(i => i.def.affords?.includes('pray') && i.spots.some(s => s.ok && s.pose === 'pray' && (!s.occ || s.occ === ME))).sort((a, b) => Math.hypot(a.x - ex, a.y - ey) - Math.hypot(b.x - ex, b.y - ey))[0];
    if (!c) return toast('Tidak ada sajadah yang kosong', 'warn');
    useInst(c, { label: 'Sholat', pose: 'pray', fx: 'pray' });
  }
  // built-in sprites: stand/sit on a free tile next to it (below when possible)
  function useBuiltin(b, u) {
    if (u.open) return openPanel(u.open, O.roomAt(b.tx, b.ty));
    const t = sideTile(b);
    if (!t) return toast('Tidak ada tempat di dekatnya', 'warn');
    standUp(true);
    walkTo(t.tx, t.ty, () => { if (me) sitAt(t.tx, t.ty, u, { face: t.face, dy: u.pose === 'sit' && t.face === 'up' && /^(sofa|arm|bean)/.test(b.k) ? -5 : 0, what: b.name }); });
  }
  function sideTile(b) {
    const out = [], [ex, ey] = [tileX(me), tileY(me)];
    for (let x = b.tx; x < b.tx + b.fw; x++) { out.push({ tx: x, ty: b.ty + b.fh, face: 'up' }); out.push({ tx: x, ty: b.ty - 1, face: 'down' }); }
    for (let y = b.ty; y < b.ty + b.fh; y++) { out.push({ tx: b.tx - 1, ty: y, face: 'right' }); out.push({ tx: b.tx + b.fw, ty: y, face: 'left' }); }
    const ok = out.filter(t => O.walkable(t.tx, t.ty)).sort((a, c) => (a.face === 'up' ? 0 : 3) + Math.hypot(a.tx - ex, a.ty - ey) * .5 - ((c.face === 'up' ? 0 : 3) + Math.hypot(c.tx - ex, c.ty - ey) * .5));
    return ok[0] || null;
  }
  async function openPanel(what, roomId) {
    const o = office(); if (!o) return;
    if (what === 'board' || what === 'wiki' || what === 'rapat') { location.hash = `#/o/${encodeURIComponent(o.id)}/${what}`; return; }
    if (what === 'proses') { const r = O.plan.rooms.find(x => x.id === roomId && x.path != null) || O.plan.rooms.find(x => x.path != null); openDock({ office: o.id, room: r?.id }); return; }
    if (what === 'news') return newsPanel();
  }
  function newsPanel() {
    const o = office(); if (!o) return;
    const list = (o.news || []).map(n => `<li>${esc(n.text)}${n.author && n.author !== 'Kamu' ? ` <span class="hint">— ${esc(n.author)}</span>` : ''}</li>`).join('') || '<li class="hint">Belum ada pengumuman</li>';
    modal({ title: 'Papan pengumuman', html: `<ul class="ow-news">${list}</ul><input id="owNews" placeholder="Tempel pengumuman baru" autocomplete="off">`, actions: [
      { label: 'Tempel', kind: 'primary', fn: () => { const v = document.getElementById('owNews').value.trim(); if (!v) return false; post(`/api/offices/${o.id}/news`, { text: v }).then(n => { o.news = n; toast('Ditempel', 'ok'); main?.kantorView?.news?.(); }).catch(err => toast(err.message, 'bad')); } },
      { label: 'Tutup' }] });
  }

  /* ---------- agents ---------- */
  const agentPos = e => e.mode === 'sit' && e.desk ? { x: e.desk.seat.tx * T + 4, y: e.desk.seat.ty * T + 7 } : { x: e.x, y: e.y };
  const agents = () => [...O.ents.values()].filter(e => e.s && !e.sub && !e.owner && !e.leaving && !e.fade && e.alpha > 0 && e.s.status !== 'ended');
  function agentActions(e) {
    const s = e.s, role = s.role ? O.roles.find(r => r.id === s.role) : null;
    if (sub === 'tepuk') return [
      { label: '“lanjut”', run: () => tap(e, 'text', 'lanjut') },
      { label: '“berhenti dulu” (Esc)', run: () => tap(e, 'esc') },
      { label: '‹ Kembali', run: () => { sub = null; renderBar(true); } }];
    if (sub === 'kartu') {
      const cards = (office()?.cards || []).filter(c => !(c.done ?? c.col >= 4) && c.who !== role?.id).slice(0, 7);
      return [...cards.map(c => ({ label: short(c.title, 28), title: c.title, run: () => giveCard(e, role, c) })), ...(cards.length ? [] : [{ label: 'Tidak ada kartu terbuka', disabled: true }]), { label: '‹ Kembali', run: () => { sub = null; renderBar(true); } }];
    }
    return [
      { label: 'Ngobrol', run: () => { if (ctx()) openSession(ctx(), s.sid, 'chat'); } },
      { label: 'Tepuk bahu', run: () => { sub = 'tepuk'; renderBar(true); } },
      { label: 'Kasih kartu', disabled: !role, title: role ? '' : 'Sesi tanpa role tidak bisa diberi kartu', run: () => { sub = 'kartu'; renderBar(true); } },
      { label: 'Lihat layar', run: () => { if (ctx()) openSession(ctx(), s.sid, 'term'); } }];
  }
  async function tap(e, action, text) {
    sub = null; renderBar(true);
    e.say = { text: action === 'esc' ? '!' : '👍', until: performance.now() + 2500 };
    try { await post(`/api/sessions/${encodeURIComponent(e.s.sid)}/action`, text ? { action, text } : { action }); toast(action === 'esc' ? `${e.name} berhenti dulu` : `${e.name}: lanjut`, 'ok'); }
    catch (err) { toast(err.message, 'bad'); }
  }
  async function giveCard(e, role, c) {
    sub = null; renderBar(true);
    const o = office(); if (!o || !role) return;
    try { await patch(`/api/offices/${o.id}/cards/${c.id}`, { who: role.id }); c.who = role.id; e.say = { text: '📋 siap!', until: performance.now() + 3000 }; toast(`“${short(c.title, 40)}” untuk ${role.name}`, 'ok'); }
    catch (err) { toast(err.message, 'bad'); }
  }
  // sitting in the meeting room: the manager offers help
  function meetingCheck() {
    const room = use?.room && O.plan.rooms.find(r => r.id === use.room);
    if (!room || (room.kind !== 'meeting' && room.id !== 'meeting')) return;
    const mgr = agents().find(e => e.mgr);
    if (mgr && Date.now() - mgrAskedAt > 60e3) { mgrAskedAt = Date.now(); mgr.say = { text: 'Ada yang bisa dibantu?', until: performance.now() + 7000 }; }
    use.meeting = true; renderBar(true);
  }
  function askManager() {
    const o = office(), mgr = o?.roles.find(r => r.isMgr); if (!mgr) return;
    modal({ title: `Suruh ${mgr.name}`, html: '<textarea id="owAsk" rows="3" placeholder="mis. rapikan alur pembayaran lalu siapkan rilis"></textarea>', actions: [
      { label: 'Kirim', kind: 'primary', fn: () => {
        const text = document.getElementById('owAsk').value.trim(); if (!text) return false;
        const live = o.sessions.find(s => s.role === mgr.id && s.status !== 'ended' && s.tmux);
        (live ? post(`/api/sessions/${live.sid}/action`, { action: 'text', text }) : post(`/api/offices/${o.id}/roles/${mgr.id}/start`, { task: text }))
          .then(() => toast(live ? `Terkirim ke ${mgr.name}` : `${mgr.name} mulai shift dengan permintaanmu`, 'ok')).catch(err => toast(err.message, 'bad'));
      } }, { label: 'Batal' }] });
  }

  /* ---------- what is near: agent (≤2 tiles), furniture, built-ins ---------- */
  function scan(now) {
    const mx = tileX(me), my = tileY(me), tx = Math.round(mx), ty = Math.round(my);
    let ag = null, ad = Infinity;
    for (const e of agents()) {
      const p = agentPos(e), d = Math.hypot((p.x - 4) / T - mx, (p.y - 7) / T - my);
      if (d <= NEAR_AGENT + .3) {
        // turn to the owner; a wave when they come close
        const face = dirTo(p.x, p.y, me.x, me.y);
        if (e.mode === 'sit' && e.desk) { e.faceUntil = now + 1500; e.faceDir = face; }
        else if (e.mode !== 'walk' && !e.pose) e.dir = face;
        if (!(greeted.get(e.id) > now - 30e3)) { greeted.set(e.id, now); e.say = { text: '👋', until: now + 2600 }; }
        if (d < ad || e.s.sid === focusSid) { if (!(ag && ag.s.sid === focusSid)) { ad = d; ag = e; } }
      }
    }
    const items = [];
    {   // a Magang within reach: send them away
      let mn = null, md = Infinity;
      for (const e of stage.minions?.list() || []) {
        if (e.fade || e.mn.state === 'leave' || e.alpha < 1) continue;
        const d = Math.hypot((e.x - 4) / T - mx, (e.y - 7) / T - my); if (d <= NEAR_AGENT + .3 && d < md) { md = d; mn = e; }
      }
      if (mn) items.push({ key: 'mg' + mn.id, name: `${mn.name} (Magang)`, acts: [{ label: 'Suruh pergi', run: () => usirMinion(stage, office()?.id, mn.id) }] });
    }
    const cands = O.engine.near(tx, ty, 1).map(x => x.inst);
    for (const inst of O.engine.insts) if (inst.wall && !cands.includes(inst)) {   // on the wall: reachable from the first floor rows under it
      const r = O.plan.rooms.find(q => q.id === inst.roomId), row = r ? r.y + O.WH : inst.y + inst.def.h;
      if (tx >= inst.x - 1 && tx <= inst.x + inst.def.w && ty >= row && ty <= row + 1) cands.push(inst);
    }
    for (const inst of cands) {
      const affs = inst.def.affords || [], acts = [];
      if (NEWS_RX.test(inst.def.id)) acts.push({ label: 'Lihat pengumuman', open: 'news' });
      if (affs.includes('read') && WIKI_RX.test(inst.def.id)) acts.push({ label: 'Buka Wiki', open: 'wiki' });
      for (const u of USE) if (affs.includes(u.aff) && !acts.some(a => a.label === u.label) && (!u.pose || inst.spots.some(s => s.ok && (!u.need || s.pose === u.need)))) acts.push(u);
      if (acts.length) items.push({ key: 'f' + inst.uid, name: inst.def.name, acts: acts.slice(0, 4).map(u => ({ ...u, run: () => useInst(inst, u) })) });
    }
    {
      for (const it of O.world.items) {
        if (!it.k) continue;
        const uses = builtinUses(it.k); if (!uses) continue;
        const d = Math.max(Math.max(it.tx - tx, 0, tx - (it.tx + it.fw - 1)), Math.max(it.ty - ty, 0, ty - (it.ty + it.fh - 1)));
        if (d <= 1) { const b = { ...it, name: BUILTIN_NAME[it.k] || (/^sofa/.test(it.k) ? 'Sofa' : /^arm/.test(it.k) ? 'Kursi' : 'Beanbag') }; items.push({ key: `b${it.tx},${it.ty}`, name: b.name, acts: uses.map(u => ({ ...u, run: () => useBuiltin(b, u) })) }); }
      }
    }
    for (const d of O.world.wallDeco) {   // a whiteboard on the wall: stand under it
      if (d.t !== 'wb') continue;
      const x0 = Math.floor(d.x / T), x1 = Math.floor((d.x + (d.w || 40)) / T), row = d.room.y + O.WH;
      if (tx >= x0 - 1 && tx <= x1 && ty >= row && ty <= row + 1) items.push({ key: `w${d.x}`, name: 'Whiteboard', acts: [{ label: 'Buka Board', run: () => openPanel('board') }] });
    }
    // more than one thing in reach: Q (or the last button) switches between them
    const targets = [...(ag ? [{ key: 'a' + ag.id, agent: ag }] : []), ...items].slice(0, 6);
    let i = targets.findIndex(x => x.key === pickKey); if (i < 0) i = 0;
    const cur = targets[i] || null;
    return { agent: cur?.agent || null, item: cur && !cur.agent ? cur : null, count: targets.length, next: targets[(i + 1) % Math.max(1, targets.length)]?.key };
  }

  /* ---------- the action bar ---------- */
  let actions = [];
  function renderBar(force) {
    if (!active || !me) { bar.hidden = true; return; }
    let title = '', list = [];
    if (use) {
      title = `${use.label}${use.what ? ` · ${use.what}` : ''}`;
      list = [{ label: 'Berdiri', run: () => standUp() }];
      if (use.meeting && office()?.roles.some(r => r.isMgr)) list.push({ label: 'Suruh manager', run: askManager });
      if (near?.agent) list.push(...agentActions(near.agent).map(a => ({ ...a, label: a.label })));
    } else if (near?.agent) { title = `${near.agent.name}`; list = agentActions(near.agent); }
    else if (near?.item) { title = near.item.name; list = near.item.acts; }
    if (!use && !sub && near?.count > 1) list = [...list, { label: `Lainnya (${near.count})`, key: 'Q', run: () => { pickKey = near.next; near = scan(performance.now()); renderBar(true); } }];
    const sig = title + '|' + list.map(a => a.label + (a.disabled ? '!' : '')).join('|');
    if (!force && sig === barSig) return;
    barSig = sig; actions = list;
    bar.hidden = !list.length;
    bar.innerHTML = list.length ? `<span class="ow-what">${esc(short(title, 34))}</span>${list.map((a, i) => `<button class="ow-act" data-i="${i}"${a.disabled ? ' disabled' : ''}${a.title ? ` title="${esc(a.title)}"` : ''}>${a.key ? `<kbd>${a.key}</kbd>` : i === 0 ? '<kbd>E</kbd>' : i < 9 ? `<kbd>${i + 1}</kbd>` : ''}${esc(a.label)}</button>`).join('')}` : '';
  }
  function runAction(i) { const a = actions[i]; if (a && !a.disabled) a.run(); }

  /* ---------- per frame ---------- */
  function tick(dt, now) {
    if (destroyed) return;
    if (remote) driveRemote(dt);
    if (!active || !me) return;
    if (!O.ents.has(ME)) O.ents.set(ME, me);   // the stage was rebuilt
    if (O.editing) return;
    if (use && !me.pose) { use = null; renderBar(true); }   // furniture was rearranged under the owner
    // keyboard / joystick: one tile at a time over the walk grid
    let dx = 0, dy = 0;
    for (const k of keys) { dx += DIRS[k][0]; dy += DIRS[k][1]; }
    if (joy) { dx += joy.dx; dy += joy.dy; }
    dx = Math.sign(dx); dy = Math.sign(dy);
    if (kstep) {
      const ddx = kstep.x - me.x, ddy = kstep.y - me.y, d = Math.hypot(ddx, ddy), sp = SPEED * dt;
      if (d <= sp) { me.x = kstep.x; me.y = kstep.y; kstep = null; if (!dx && !dy) me.mode = 'stand'; }
      else { me.x += ddx / d * sp; me.y += ddy / d * sp; me.mode = 'walk'; }
    }
    if (!kstep && (dx || dy)) {
      if (use || me.pose) standUp(true);
      if (me.q.length || me.cur) cancelWalk();
      sub = null; focusSid = null;
      const cx = Math.round(tileX(me)), cy = Math.round(tileY(me));
      let nx = cx + dx, ny = cy + dy;
      if (dx && dy && (!O.walkable(nx, ny) || !O.walkable(cx + dx, cy) || !O.walkable(cx, cy + dy))) { if (O.walkable(cx + dx, cy)) ny = cy; else if (O.walkable(cx, cy + dy)) nx = cx; }
      me.dir = dx && !dy ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : dy > 0 ? 'down' : me.dir;
      if (O.walkable(nx, ny)) { kstep = { x: nx * T + 4, y: ny * T + 7 }; me.mode = 'walk'; }
      else me.mode = 'stand';
    }
    if (!kstep && !dx && !dy && !me.cur && !me.q.length && me.mode === 'walk') me.mode = 'stand';
    // camera
    if (O.lastPan > followAt && follow) setFollow(false);
    if (follow) O.centerOn(me.x, me.y - 8);
    if (now - nearT > 150) { nearT = now; near = scan(now); renderBar(); }
    maybeSend(now);
  }
  const offTick = O.onTick(tick);

  /* ---------- tap / click: walk there (to an agent: next to them, and their menu) ---------- */
  O.setTap((sx, sy, hit) => {
    if (!active || !me) return false;
    const w = O.screenToWorld(sx, sy), tx = Math.floor(w.x / T), ty = Math.floor(w.y / T);
    kstep = null; sub = null;
    if (hit?.sid) {
      const e = O.ents.get(hit.sid); if (!e) return false;
      focusSid = hit.sid;
      const p = agentPos(e), ax = Math.floor(p.x / T), ay = Math.floor(p.y / T);
      const mx = tileX(me), my = tileY(me);
      const t = [[0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0], [0, 2], [2, 0], [-2, 0], [0, -1]].map(([ox, oy]) => ({ tx: ax + ox, ty: ay + oy })).filter(q => O.walkable(q.tx, q.ty)).sort((a, b) => Math.hypot(a.tx - mx, a.ty - my) - Math.hypot(b.tx - mx, b.ty - my))[0];
      if (use) standUp(true);
      if (t) walkTo(t.tx, t.ty, () => { if (me) me.dir = dirTo(me.x, me.y, p.x, p.y); });
      return true;
    }
    focusSid = null;
    if (use) standUp(true);
    const goal = O.walkable(tx, ty) ? [tx, ty] : O.nearestWalk(tx, ty);
    if (goal) walkTo(goal[0], goal[1]);
    return true;
  });

  /* ---------- an owner driven from another device ---------- */
  function showRemote(ow, instant) {
    if (!ow?.present || ow.x == null) { if (remote) { const e = remote; remote = null; O.engine.unclaim(REMOTE); e.q = [{ t: 'go', tx: O.world.elevator.tx, ty: O.world.elevator.ty }, { t: 'call', fn: () => { O.openElevator(1500); e.fade = true; } }]; e.cur = null; e.path = []; e.target = null; } return; }
    if (!remote) {
      remote = O.spawn(REMOTE, { ...ow.look, crown: true }); remote.name = 'Kamu'; remote.remote = true;
      if (instant) { remote.x = ow.x * T + 4; remote.y = ow.y * T + 7; } else O.openElevator(1800);
    }
    remote.look = { ...ow.look, crown: true };
    remote.target = { x: ow.x * T + 4, y: ow.y * T + 7, face: ow.face, pose: ow.pose, fx: ow.fx };
  }
  function driveRemote(dt) {
    const e = remote, g = e.target; if (!g || e.fade) return;
    const dx = g.x - e.x, dy = g.y - e.y, d = Math.hypot(dx, dy);
    if (d > T * 14) { e.x = g.x; e.y = g.y; }
    else if (d > .5) { const sp = Math.max(SPEED, d * 3) * dt; if (d <= sp) { e.x = g.x; e.y = g.y; } else { e.x += dx / d * sp; e.y += dy / d * sp; } e.mode = 'walk'; e.pose = null; e.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'); return; }
    e.mode = 'stand'; e.dir = g.face || e.dir;
    if ((g.pose || null) !== (e.pose || null)) {
      e.pose = g.pose && g.pose !== 'stand' || g.fx ? g.pose || 'stand' : null; e.fx = g.fx; e.poseAt = performance.now();
      // the spot under a remote owner is theirs
      O.engine.unclaim(REMOTE); e.poseInst = null;
      if (e.pose) { const tx = Math.round((e.x - 4) / T), ty = Math.round((e.y - 7) / T); for (const inst of O.engine.insts) { const i = inst.spots.findIndex(s => s.tx === tx && s.ty === ty); if (i >= 0 && O.engine.claim(REMOTE, inst, i)) { e.poseInst = inst; break; } } }
    }
  }
  const offLive = onLive(m => {
    const o = office();
    if (m.t !== 'owner' || !o || m.office !== o.id) return;
    if (m.owner.client === CLIENT) return;
    if (active && m.owner.present) {   // taken over from another device
      active = false; keys.clear(); kstep = null; O.engine.unclaim(ME);
      if (me) { me.fade = true; me = null; }
      btn.hidden = false; hud.hidden = true; bar.hidden = true; joyEl.hidden = true; barSig = '';
      toast('Kamu sekarang di kantor lewat perangkat lain', '');
    }
    if (me && me.look) me.look = { ...m.owner.look, crown: true };
    showRemote(m.owner, false);
  });

  // on mount: an owner already here (other device), or this tab coming back from another tab of the office
  ready.then(async () => {
    const o = office(); if (!o || destroyed) return;
    const cur = await api(`/api/offices/${encodeURIComponent(o.id)}/owner`).catch(() => null);
    if (!cur || destroyed) return;
    if (cur.present && cur.client === CLIENT && resumeAt?.office === o.id && resumeAt.until > Date.now()) enter({ x: cur.x, y: cur.y, face: cur.face });
    else if (cur.present && cur.client !== CLIENT) showRemote(cur, true);
  });

  /* ---------- look editor ---------- */
  async function lookEditor() {
    const look = me?.look || {};
    const sel = (id, opts, v) => `<select id="${id}">${Object.entries(opts).map(([k, l]) => `<option value="${esc(k)}"${k === (v ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const sw = (name, cols, v) => `<div class="ow-sw" data-name="${name}">${cols.map(c => `<button type="button" style="background:${c}" data-c="${c}" aria-pressed="${c === v}" aria-label="${c}"></button>`).join('')}</div>`;
    modal({ title: 'Tampilanmu', html: `<div class="ow-look">
      <label>Rambut ${sel('owStyle', HAIR_STYLES, look.hairStyle || 'short')}</label>
      <label>Pakaian ${sel('owOutfit', OUTFITS, look.outfit || 'jas')}</label>
      <label>Aksesori ${sel('owAcc', ACCS, look.acc || '')}</label>
      <p class="eyebrow">Warna baju</p>${sw('color', SWATCHES.concat('#C9A15A'), look.color)}
      <p class="eyebrow">Rambut</p>${sw('hair', HAIRS, look.hair)}
      <p class="eyebrow">Kulit</p>${sw('skin', SKINS, look.skin)}
      <p class="eyebrow">Hijab</p>${sw('hijab', HIJABS, look.hijab)}</div>`, actions: [
      { label: 'Simpan', kind: 'primary', fn: () => {
        const card = document.getElementById('modalCard'), pick = n => card.querySelector(`.ow-sw[data-name="${n}"] [aria-pressed="true"]`)?.dataset.c;
        const body = { hairStyle: card.querySelector('#owStyle').value, outfit: card.querySelector('#owOutfit').value, acc: card.querySelector('#owAcc').value };
        for (const n of ['color', 'hair', 'skin', 'hijab']) { const c = pick(n); if (c) body[n] = c; }
        if (body.hairStyle === 'hijab' && body.acc === 'topi') body.acc = '';
        api('/api/owner/look', { method: 'PUT', body }).then(l => { if (me) me.look = { ...l, crown: true }; send({}); toast('Tampilan disimpan', 'ok'); }).catch(err => toast(err.message, 'bad'));
      } }, { label: 'Batal' }] });
    document.getElementById('modalCard').addEventListener('click', e => { const b = e.target.closest('.ow-sw button'); if (!b) return; for (const x of b.parentElement.children) x.setAttribute('aria-pressed', String(x === b)); });
  }

  return {
    enter, leave, get active() { return active; }, get me() { return me; }, get remote() { return remote; }, get near() { return near; }, get use() { return use; },
    destroy() {
      if (destroyed) return; destroyed = true;
      // switching to another tab of this office: keep the owner "present" a little; the heartbeat stops and the daemon lets them leave after 2 minutes
      if (active && office()) resumeAt = { office: office().id, until: Date.now() + 110e3 };
      offTick(); offLive(); O.setTap(null);
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); window.removeEventListener('pagehide', onHide);
      btn.remove(); hud.remove(); bar.remove(); hint.remove(); joyEl.remove();
    },
  };
}
