// Magang ("minion"): NPC kosmetik yang meramaikan kantor. BUKAN agen: tidak memanggil model apa pun, murni simulasi di klien.
// Identitas (nama + tampilan) dan jumlah datang dari server (GET /api/offices/:id/minions, event {t:'minions'}); gerak diputuskan di sini.
// Mereka memakai perabot lewat afford yang sama dengan agen (furniture.js: E.minionStart), selalu mengalah ke agen asli dan owner,
// dan jadi kurir untuk KERJA NYATA (dm, kartu, rapat, proses, file, wiki, izin menunggu) tanpa mengubah apa pun di server.
export const MAX = 30;
const T = 8;
const rnd = (a, b) => a + Math.random() * (b - a);
const wchoose = list => { let t = 0; for (const p of list) t += p.w; let r = Math.random() * t; for (const p of list) { r -= p.w; if (r <= 0) return p; } return list[list.length - 1]; };

/** Jumlah efektif pada mode otomatis: sepi malam, berkurang saat banyak agen asli bekerja. */
export function autoCount(base, working, date = new Date()) {
  if (base <= 0) return 0;
  const h = date.getHours() + date.getMinutes() / 60;
  const f = h >= 22 || h < 5.5 ? .25 : h >= 20 ? .5 : h >= 18 ? .8 : 1;
  return Math.max(1, Math.min(base, Math.floor(base * f + .0001) - Math.max(0, working - 2)));
}

/** Perubahan papan kartu -> tugas kurir. cards: [{id,title,col,who,board?,done?}]; selesai = kolom berjenis selesai (done), klien lama: col 4. */
const isDone = c => (c.done ?? c.col >= 4);
export function diffCards(prev, next) {
  const out = [], was = new Map((prev || []).map(c => [c.id, c]));
  if (!prev) return out;
  for (const c of next || []) {
    const o = was.get(c.id);
    if (!o) { out.push({ kind: isDone(c) ? 'done' : 'baru', card: c }); continue; }
    const moved = o.col !== c.col || (o.board || 'utama') !== (c.board || 'utama');
    if (moved && isDone(c) && !isDone(o)) out.push({ kind: 'done', card: c });
    else if (o.who !== c.who && c.who) out.push({ kind: 'tugas', card: c });
    else if (moved && c.who) out.push({ kind: 'pindah', card: c });
  }
  return out;
}

// sprite bawaan generator ruang (office-canvas `_k`) -> afford
const BUILTIN = { counter: 'coffee', water: 'water', fridge: 'snack', vending: 'snack', printer: 'print', shelf: 'read', cabinet: 'file', wbstand: 'whiteboard', recep: 'recep', qabench: 'test', rack: 'server', arcade: 'game', piano: 'music', drums: 'music', guitar: 'music' };
// afford, bobot, lama (detik). pose/prop digambar office-canvas.drawPosed
const ACTS = [
  { a: 'coffee', w: 3, d: [12, 25] }, { a: 'print', w: 2.2, d: [8, 14] }, { a: 'plant', w: 2, d: [10, 20] }, { a: 'water', w: 1.4, d: [6, 12] },
  { a: 'snack', w: 1, d: [8, 15] }, { a: 'read', w: 2, d: [15, 30] }, { a: 'whiteboard', w: 1.5, d: [15, 30] }, { a: 'exercise', w: 1, d: [20, 40] },
  { a: 'type', w: 3, d: [30, 70] }, { a: 'think', w: 1, d: [10, 20] }, { a: 'phone', w: 1, d: [10, 20] }, { a: 'eat', w: .5, d: [20, 40] },
  { a: 'sofa', w: .7, d: [25, 60] }, { a: 'play', w: .6, d: [15, 35] }, { a: 'music', w: .5, d: [15, 35] },
  { a: 'clean', w: 1.6, d: [0, 0] }, { a: 'errand', w: 2.6, d: [0, 0] },
];
const ARSIP = /rak|lemari|arsip|berkas|katalog/;

/**
 * env: { world(), plan(), roles(), sessions(), ents (Map), engine, spawn(id, look, atElevator), randomSpot(roomId), serverDoor(), openElevator(ms) }
 */
export function createMinions(env) {
  const engine = env.engine, mm = new Map(), deskBy = new Map(), bocc = new Map();
  const seenDm = new Set();
  let view = null, pending = [], spawnQ = [], recent = new Map(), known = null, procSt = new Map(), standCache = null, lastAuto = 0, first = true, tickAt = 0;

  /* ---------------- places ---------------- */
  const W = () => env.world();
  const walkable = (tx, ty) => { const w = W(); return tx >= 0 && ty >= 0 && tx < w.W && ty < w.H && !!w.walk[ty * w.W + tx]; };
  function stands() {
    if (standCache) return standCache;
    const w = W(), m = new Map();
    for (const it of w.items) {
      if (it.k === 'mtable') {   // chairs along both long sides of the meeting table: sit facing it
        if (!m.has('meeting')) m.set('meeting', []);
        for (let i = 1; i < it.fw - 1; i += 2) {
          for (const [row, face] of [[it.ty - 1, 'down'], [it.ty + it.fh, 'up']]) if (walkable(it.tx + i, row) && !w.seat.has(row * w.W + it.tx + i)) m.get('meeting').push({ tx: it.tx + i, ty: row, face, pose: 'sit', kind: 'meeting', key: `meeting:${it.tx + i},${row}` });
        }
        continue;
      }
      const kind = BUILTIN[it.k] || (/^plant/.test(it.k || '') ? 'plant' : null); if (!kind) continue;
      for (let dy = 0; dy < 2; dy++) {
        const row = it.ty + it.fh + dy, cols = [...Array(it.fw).keys()].map(i => it.tx + i).sort((a, b) => Math.abs(a - it.tx - it.fw / 2) - Math.abs(b - it.tx - it.fw / 2));
        const tx = cols.find(x => walkable(x, row) && !w.seat.has(row * w.W + x));
        if (tx != null) { if (!m.has(kind)) m.set(kind, []); m.get(kind).push({ tx, ty: row, face: 'up', kind, key: `${kind}:${tx},${row}` }); break; }
      }
    }
    return standCache = m;
  }
  const tilesFor = (aff, rx) => [...engine.tilesOf(aff, rx), ...(rx ? [] : stands().get(aff) || [])];
  const near = (list, from) => list.slice().sort((a, b) => Math.abs(a.tx - from.tx) + Math.abs(a.ty - from.ty) - Math.abs(b.tx - from.tx) - Math.abs(b.ty - from.ty))[0] || null;
  const tileOfEnt = e => ({ tx: Math.floor(e.x / T), ty: Math.floor(e.y / T) });
  const roomTile = (id, kind) => {
    const pl = env.plan(), r = pl.rooms.find(x => x.id === id) || (kind && pl.rooms.find(x => x.kind === kind));
    return r ? env.randomSpot(r.id) : null;
  };
  const roleOfSid = sid => env.sessions().find(s => s.sid === sid)?.role || null;
  function deskTile(roleId, side = 0) {
    const w = W(), d = roleId && w.desks.find(x => x.role === roleId);
    if (d) return { tx: d.front.tx + side, ty: d.front.ty };
    const r = env.roles().find(x => x.id === roleId);
    return r ? roomTile(r.room) : null;
  }
  const mgrId = () => env.roles().find(r => r.isMgr)?.id || null;
  function resolve(spec, from) {
    if (!spec) return null;
    if (typeof spec === 'object') return spec;
    const i = spec.indexOf(':'), k = i < 0 ? spec : spec.slice(0, i), arg = i < 0 ? '' : spec.slice(i + 1);
    switch (k) {
      case 'desk': return deskTile(arg) || deskTile(mgrId());
      case 'side': return deskTile(arg, 1) || deskTile(mgrId(), 1);
      case 'mgr': return deskTile(mgrId());
      case 'room': return roomTile(arg, arg);
      case 'lift': { const el = W().elevator; return { tx: el.tx, ty: el.ty }; }
      case 'lobby': return roomTile('lobby', 'lobby') || resolve('lift');
      case 'archive': return near(tilesFor('read', ARSIP).concat(stands().get('file') || []), from) || near(tilesFor('read'), from) || roomTile('lib', 'lib');
      case 'server': { const d = env.serverDoor(); return d || roomTile('server', 'server'); }
      case 'board': return near(tilesFor('whiteboard'), from) || deskTile(mgrId());
      default: return near(tilesFor(k), from) || null;
    }
  }

  /* ---------------- movement helpers ---------------- */
  function stop(m) {   // drop whatever the Magang is doing (spot released, pose cleared)
    const st = m.mn;
    engine.abort(m); freeStand(m);
    m.q = []; m.cur = null; m.path = []; m.pose = null; m.fx = null; m.poseInst = null; m.mode = 'stand'; m.carry = null; m.bubble = ''; m.speed = 0; m.dir = 'down';
    st.job = null;
  }
  function freeStand(m) {
    const st = m.mn;
    if (st.stand) { if (bocc.get(st.stand) === m.id) bocc.delete(st.stand); st.stand = null; }
    if (st.desk) { if (deskBy.get(st.desk) === m.id) deskBy.delete(st.desk); st.desk = null; }
  }
  const idle = (m, ms) => { const st = m.mn; st.state = 'idle'; st.nextAt = performance.now() + (ms ?? rnd(400, 2200)); };
  function walkTo(m, tx, ty, then) { m.q.push({ t: 'go', tx, ty }); if (then) m.q.push({ t: 'call', fn: then }); }

  /* ---------------- courier jobs ---------------- */
  // steps: [{to: spec, carry?: prop|null, wait?: ms, speed?: px/s}]; cond(): false ends a long wait early
  function startJob(m, job) {
    stop(m);
    const st = m.mn; st.state = 'job'; st.job = job; m.bubble = job.glyph || '';
    const here = tileOfEnt(m);
    for (const s of job.steps) {
      const to = resolve(s.to, here); if (!to) continue;
      m.q.push({ t: 'call', fn: () => { m.speed = s.speed || 0; } }, { t: 'go', tx: to.tx, ty: to.ty },
        { t: 'call', fn: () => { if (s.carry !== undefined) m.carry = s.carry; } });
      if (s.wait) m.q.push({ t: 'wait', ms: s.wait });
    }
    if (!m.q.length) { stop(m); idle(m, 500); }
  }
  function enqueue(job) {
    const now = performance.now();
    if (recent.get(job.key) > now - (job.cool ?? 20e3)) return;
    recent.set(job.key, now);
    if (recent.size > 200) for (const [k, t] of recent) if (t < now - 120e3) recent.delete(k);
    pending = pending.filter(p => p.key !== job.key);
    pending.push({ ...job, at: now });
    if (pending.length > 10) pending.splice(0, pending.length - 10);   // too many: the oldest are skipped
  }
  function dispatch() {
    if (!pending.length) return;
    const now = performance.now();
    pending = pending.filter(p => now - p.at < 30e3);
    for (const job of pending.slice()) {
      const free = [...mm.values()].filter(m => ['idle', 'act', 'do'].includes(m.mn.state) && m.alpha >= 1 && !m.fade && now - m.mn.born > 1500);
      if (!free.length) return;
      const to = resolve(job.steps[0]?.to, { tx: 0, ty: 0 }) || { tx: 0, ty: 0 };
      const m = free.sort((a, b) => Math.abs(a.x / T - to.tx) + Math.abs(a.y / T - to.ty) - Math.abs(b.x / T - to.tx) - Math.abs(b.y / T - to.ty))[0];
      pending.splice(pending.indexOf(job), 1);
      startJob(m, job);
    }
  }
  const jobs = {
    mail: (from, to, id) => ({ key: `dm:${id}`, glyph: '✉', cool: 6e3, steps: [{ to: `desk:${from}`, carry: 'mail', wait: 500 }, { to: `desk:${to}`, carry: null, wait: 1500 }], id }),
    card: (kind, c) => {
      const who = c.who;
      if (kind === 'done') return { key: `kartu-selesai:${c.id}`, glyph: '✓', steps: [{ to: who ? `desk:${who}` : 'board', carry: 'folder', wait: 400 }, { to: 'archive', carry: null, wait: 1800 }] };
      return { key: `kartu:${c.id}:${kind}`, glyph: '📋', steps: [{ to: kind === 'baru' ? 'board' : 'mgr', carry: 'folder', wait: 500 }, { to: who ? `side:${who}` : 'board', carry: null, wait: 1800 }] };
    },
    meeting: (sid, n) => ({ key: `rapat:${sid}:${n}`, glyph: '☕', cool: 60e3, steps: [{ to: 'coffee', carry: 'cup', wait: 500 }, { to: 'room:meeting', carry: null, wait: 2400 }] }),
    server: key => ({ key: `server:${key}`, glyph: '!', cool: 30e3, steps: [{ to: 'server', speed: 92, wait: 4200 }, { to: 'lobby', speed: 56 }] }),
    parcel: (sid, key) => { const r = roleOfSid(sid); return { key: `paket:${key}`, glyph: '📦', steps: [{ to: r ? `desk:${r}` : 'mgr', carry: 'box', wait: 400 }, { to: 'lobby', carry: null, wait: 2200 }] }; },
    wiki: key => { const w = env.sessions().find(s => s.status === 'working' && s.role); return { key: `wiki:${key}`, glyph: '📖', cool: 15e3, steps: [{ to: w ? `desk:${w.role}` : 'mgr', carry: 'book', wait: 400 }, { to: 'room:lib', carry: null, wait: 2200 }] }; },
    ask: (sid, role, cond) => ({ key: `izin:${sid}`, glyph: '?', cool: 60e3, cond, steps: [{ to: `side:${role}`, carry: 'sign', wait: 60e3 }] }),
  };

  /* ---------------- idle life ---------------- */
  const lunch = () => { const h = new Date().getHours() + new Date().getMinutes() / 60; return h >= 11.5 && h < 13.5; };
  function planIdle(m) {
    const st = m.mn, here = tileOfEnt(m), hour = new Date().getHours();
    if (Math.random() < .8 && pickScene(m)) return;   // room scenes first; the afford roulette below is the fallback
    if (engine.has('wudhu') && engine.has('pray') && (st.n % 10) < 7) {
      const pn = engine.minionPrayer(m);
      if (pn) { const act = engine.minionStart(m, 'wudhu', [15, 25], [{ a: 'pray', dwell: [40, 70] }]); if (act) return goAct(m, act); }
    }
    const opts = ACTS.map(o => ({ ...o, w: o.a === 'eat' && lunch() ? 5 : o.a === 'exercise' && (hour < 6 || hour > 19) ? .3 : o.w }));
    while (opts.length) {
      const o = wchoose(opts); opts.splice(opts.indexOf(o), 1);
      if (o.a === st.last && opts.length > 1) continue;
      if (o.a === 'errand') { errand(m); st.last = o.a; return; }
      if (o.a === 'clean') { clean(m); st.last = o.a; return; }
      if (o.a === 'type' && sitDesk(m, o.d)) { st.last = o.a; return; }
      if (engine.has(o.a)) { const act = engine.minionStart(m, o.a, o.d); if (act) { st.last = o.a; return goAct(m, act); } }
      if (standAt(m, o, here)) { st.last = o.a; return; }
    }
    errand(m);
  }
  function goAct(m, act) {
    const st = m.mn, sp = act.inst.spots[act.si];
    st.state = 'act'; st.since = performance.now();
    m.q = []; m.cur = null; m.path = []; m.speed = 0;
    walkTo(m, sp.tx, sp.ty, () => engine.arrive(m));
  }
  // built-in furniture (counter, water, fridge, printer, shelf, whiteboard, plants): stand in front of it and use it
  function standAt(m, o, here) {
    const list = (stands().get(o.a) || []).filter(s => !bocc.has(s.key)); if (!list.length) return false;
    const s = list.sort((a, b) => Math.abs(a.tx - here.tx) + Math.abs(a.ty - here.ty) - Math.abs(b.tx - here.tx) - Math.abs(b.ty - here.ty) + (Math.random() - .5) * 14)[0], st = m.mn;
    bocc.set(s.key, m.id); st.stand = s.key; st.state = 'act'; st.since = performance.now();
    walkTo(m, s.tx, s.ty, () => {
      if (!mm.has(m.id) || st.stand !== s.key) return;
      m.x = s.tx * T + 4; m.y = s.ty * T + 7; m.dir = 'up'; m.pose = o.a === 'read' ? 'read' : 'stand'; m.fx = o.a === 'file' ? 'read' : o.a; m.poseAt = performance.now(); m.poseInst = null;
      st.state = 'do'; st.until = performance.now() + rnd(o.d[0] || 8, o.d[1] || 15) * 1000;
    });
    return true;
  }
  // an empty desk: sit and type (stands up the moment an agent is assigned to it)
  function sitDesk(m, d) {
    const w = W(), here = tileOfEnt(m), st = m.mn;
    const free = w.desks.filter(x => !x.occ && (x.spare || !x.role) && !deskBy.has(x));
    if (!free.length) return false;
    const desk = free.sort((a, b) => Math.abs(a.seat.tx - here.tx) + Math.abs(a.seat.ty - here.ty) - Math.abs(b.seat.tx - here.tx) - Math.abs(b.seat.ty - here.ty) + (Math.random() - .5) * 14)[0];
    deskBy.set(desk, m.id); st.desk = desk; st.state = 'act'; st.since = performance.now();
    walkTo(m, desk.seat.tx, desk.seat.ty, () => {
      if (!mm.has(m.id) || st.desk !== desk || desk.occ) return;
      m.x = desk.seat.x; m.y = desk.seat.y - 1; m.dir = desk.facing; m.pose = 'sit'; m.fx = 'type'; m.poseAt = performance.now(); m.poseInst = null;
      st.state = 'do'; st.until = performance.now() + rnd(d[0], d[1]) * 1000;
    });
    return true;
  }
  const PROPS = ['folder', 'box', 'paper', 'mail', 'book'];
  // walk to another room carrying something, linger, come back later
  function errand(m) {
    const pl = env.plan(), rooms = pl.rooms.filter(r => r.kind !== 'zone' && r.kind !== 'toilet');
    const here = tileOfEnt(m), cur = rooms.find(r => here.tx >= r.x && here.tx < r.x + r.w && here.ty >= r.y && here.ty < r.y + r.h);
    const others = rooms.filter(r => r !== cur), r = (others.length ? others : rooms)[Math.floor(Math.random() * (others.length || rooms.length))];
    const to = r && env.randomSpot(r.id); if (!to) return idle(m, 3000);
    const st = m.mn, prop = PROPS[Math.floor(Math.random() * PROPS.length)];
    st.state = 'job'; st.job = { key: 'errand', steps: [] };
    m.carry = prop;
    walkTo(m, to.tx, to.ty);
    m.q.push({ t: 'wait', ms: rnd(1200, 3500) }, { t: 'call', fn: () => { m.carry = null; } });
  }
  // sweep a room with a broom: a few waypoints
  function clean(m) {
    const pl = env.plan(), rooms = pl.rooms.filter(r => r.kind !== 'zone' && r.kind !== 'toilet');
    const r = rooms[Math.floor(Math.random() * rooms.length)]; if (!r) return idle(m, 3000);
    const st = m.mn; st.state = 'job'; st.job = { key: 'clean', steps: [] };
    m.carry = 'broom';
    for (let i = 0; i < 4; i++) { const p = env.randomSpot(r.id); if (p) walkTo(m, p.tx, p.ty); }
    m.q.push({ t: 'call', fn: () => { m.carry = null; } });
  }

  /* ---------------- scenes (server/furniture/scenes.json, contract in docs/FRONTEND-CONTRACT.md) ---------------- */
  // Every step is resolved LAZILY when it runs (a 'call' queue entry injects the real go/wait entries), so targets such as "beside the partner" are current.
  const sceneLast = new Map();           // scene id -> ms of the last start (cooldown)
  const hourNow = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
  const nowMs = () => performance.now();
  const hourW = sc => { const h = hourNow(); let w = 1; for (const x of sc.hourWeights || []) { const [a, b] = x.h || [0, 24]; if ((h >= a && h < b) || (h + 24 >= a && h + 24 < b)) w *= x.w; } return w; };
  const walkRooms = () => env.plan().rooms.filter(r => r.kind !== 'zone');
  const tileIn = (r, t) => t.tx >= r.x && t.tx < r.x + r.w && t.ty >= r.y && t.ty < r.y + r.h;
  const roomAtEnt = e => { const t = tileOfEnt(e); return walkRooms().find(r => tileIn(r, t)) || null; };
  const realAgents = () => [...env.ents.values()].filter(e => e.s && !e.sub && !e.owner && !e.minion && !e.leaving && !e.fade && e.alpha >= 1 && e.s.status !== 'ended');
  const agentsWorkingIn = room => realAgents().filter(e => e.s.status === 'working' && (!room || tileIn(room, e.mode === 'sit' && e.desk ? { tx: e.desk.seat.tx, ty: e.desk.seat.ty } : tileOfEnt(e))));
  const dirFrom = (ax, ay, bx, by) => Math.abs(bx - ax) > Math.abs(by - ay) ? (bx < ax ? 'left' : 'right') : (by < ay ? 'up' : 'down');
  const wait2ms = w => (Array.isArray(w) ? rnd(w[0], w[1]) : Number(w) || 0) * 1000;
  const needOk = sc => (sc.need || []).every(n => n === 'agent' ? agentsWorkingIn(null).length > 0 : n === 'mgr-desk' ? !!deskTile(mgrId()) : true);
  const roomsOf = (sc, m) => {
    const all = walkRooms();
    if (sc.rooms.includes('*')) { const cur = roomAtEnt(m); const pool = all.filter(r => r.kind !== 'toilet' && r.kind !== 'lobby'); return cur && cur.kind !== 'toilet' ? [cur] : pool.slice(0, 1); }
    return all.filter(r => sc.rooms.includes(r.kind) || sc.rooms.includes(r.id));
  };
  const standsIn = (kind, room, taken) => (stands().get(kind) || []).filter(s => (!room || tileIn(room, s)) && (!taken || !bocc.has(s.key)));
  function doorTile(room, from) {
    const out = (room.doors || []).map(d => d.s === 'b' ? { tx: room.x + d.at + 1, ty: room.y + room.h } : d.s === 't' ? { tx: room.x + d.at + 1, ty: room.y - 1 } : d.s === 'l' ? { tx: room.x - 1, ty: room.y + d.at } : { tx: room.x + room.w, ty: room.y + d.at });
    return near(out, from) || null;
  }
  function besideTile(ent, k) {
    const w = W(), t = ent.mode === 'sit' && ent.desk ? { tx: ent.desk.seat.tx, ty: ent.desk.seat.ty } : tileOfEnt(ent);
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0]], off = k % 2 ? sides.slice().reverse() : sides;
    for (const [dx, dy] of off) { const x = t.tx + dx, y = t.ty + dy; if (walkable(x, y) && !w.seat.has(y * w.W + x)) return { tx: x, ty: y }; }
    return null;
  }
  function agentDeskTile(room, from) {
    const list = agentsWorkingIn(room); const pool = list.length ? list : agentsWorkingIn(null);
    const ds = pool.filter(e => e.desk).map(e => ({ tx: e.desk.front.tx, ty: e.desk.front.ty }));
    return near(ds, from);
  }
  const partnerOf = (sc, a) => a.mn.ai === 0 ? (sc.actors[1] || sc.guest) : sc.actors[0];
  const guestIdx = sc => sc.actors.length;
  function sceneAlive(sc) {
    if (sc.cancelled) return false;
    for (const a of sc.actors) if (!mm.has(a.id) || a.fade || a.mn.state === 'leave') return false;
    const g = sc.guest; if (g && (!env.ents.has(g.id) || g.mode === 'walk' || g.leaving || g.fade || g.s?.status === 'working' || g.act)) return false;
    return true;
  }
  function cancelScene(sc) {
    if (sc.cancelled) return; sc.cancelled = true;
    for (const a of sc.actors) if (mm.has(a.id) && a.mn.scene === sc && a.mn.state !== 'leave') { stop(a); a.say = null; a.mn.scene = null; idle(a, rnd(1, 3)); }
  }
  function endSceneActor(sc, a) {
    stop(a); a.say = null; a.mn.scene = null; a.mn.cycle = null; a.mn.holdAct = false; idle(a, rnd(2, 5));
  }
  function setSay(m, say, ms) {
    if (!say) return;
    if (Array.isArray(say)) { m.mn.cycle = { arr: say, i: 0, next: nowMs() + 2600, until: nowMs() + Math.max(ms, 2600) }; m.say = { text: say[0], until: nowMs() + 2700 }; }
    else { m.mn.cycle = null; m.say = { text: say, until: nowMs() + Math.max(ms, 1800) }; }
  }
  function arriveStep(sc, a, step, stand) {
    if (!sceneAlive(sc)) return;
    const st = a.mn;
    if (step.face) {
      let d = null;
      if (['up', 'down', 'left', 'right'].includes(step.face)) d = step.face;
      else if (step.face === 'partner') { const p = partnerOf(sc, a); if (p) d = dirFrom(a.x, a.y, p.x, p.y); }
      if (d) a.dir = d;
    } else if (stand && !a.act) a.dir = stand.face || 'up';
    if (step.pose && !a.act) { a.pose = step.pose; a.fx = step.fx || stand?.kind || null; a.poseAt = nowMs(); a.poseInst = null; a.mode = 'stand'; }
    else if (step.fx && a.pose) a.fx = step.fx;
    else if (stand && !step.pose && !a.act) { a.pose = stand.pose || 'stand'; a.fx = step.fx || stand.kind; a.poseAt = nowMs(); a.poseInst = null; }
    if (step.carry !== undefined) a.carry = step.carry === '' ? null : step.carry;
    setSay(a, step.say, wait2ms(step.wait));
    if (step.turnAgent) {
      const ag = agentsWorkingIn(sc.room)[0] || realAgents().find(e => sc.room && tileIn(sc.room, tileOfEnt(e)));
      if (ag) { const d = dirFrom(ag.x, ag.y, a.x, a.y); if (ag.mode === 'sit' && ag.desk) { ag.faceUntil = nowMs() + 3000; ag.faceDir = d; } else if (!ag.pose && ag.mode !== 'walk') ag.dir = d; }
    }
  }
  // inject the concrete entries of one step at the front of the actor's queue
  function runStep(sc, a, step, si) {
    if (!sceneAlive(sc)) { cancelScene(sc); return; }
    const st = a.mn, q = [], here = tileOfEnt(a), room = sc.room;
    if (step.skipIf === 'agent-in-room' && agentsWorkingIn(room).length) {
      if (!step.waitOutside) return;
      const d = doorTile(room, here);
      if (d) q.push({ t: 'go', tx: d.tx, ty: d.ty });
      q.push({ t: 'wait', ms: 20000, done: () => !agentsWorkingIn(room).length }, { t: 'call', fn: () => { if (agentsWorkingIn(room).length) cancelScene(sc); } });
    }
    if (step.go || step.pose) {
      engine.abort(a); freeStand(a); st.holdAct = false;
      if (!step.pose) { a.pose = null; a.fx = null; } else { a.pose = null; }
      a.mode = 'stand';
    }
    const g = step.go;
    let tile = null, stand = null, act = null;
    if (g) {
      if (g === 'door') tile = doorTile(room, here);
      else if (g === 'inside') tile = env.randomSpot(room.id);
      else if (g === 'lift') { const el = W().elevator; tile = { tx: el.tx, ty: el.ty }; }
      else if (g === 'partner') { const p = partnerOf(sc, a); tile = st.ai === 0 || !p ? null : besideTile(p, st.ai); if (!tile && st.ai !== 0) tile = env.randomSpot(room.id); }
      else if (g === 'desk:mgr') tile = deskTile(mgrId());
      else if (g === 'desk:agent') tile = agentDeskTile(room, here);
      else if (g.startsWith('room:')) { const k = g.slice(5); const r = walkRooms().find(x => x.id === k || x.kind === k); tile = r ? env.randomSpot(r.id) : null; }
      else if (g.startsWith('stand:')) { const s = near(standsIn(g.slice(6), room, true), here); if (s) { stand = s; tile = s; bocc.set(s.key, a.id); st.stand = s.key; } }
      else if (g.startsWith('aff:')) {
        const aff = g.slice(4), dwell = 600;
        if (engine.has(aff)) act = engine.minionStart(a, aff, [dwell, dwell], null, room.id);
        if (!act) { const s = near(standsIn(aff, room, true), here); if (s) { stand = s; tile = s; bocc.set(s.key, a.id); st.stand = s.key; } }
      }
      if (!tile && !act && g !== 'partner' && !step.optional && g !== 'desk:mgr') tile = env.randomSpot(room.id);
      else if (!tile && !act && g === 'desk:mgr' && !step.optional) tile = env.randomSpot(room.id);
    }
    if (act) {
      const sp = act.inst.spots[act.si]; st.holdAct = true;
      q.push({ t: 'go', tx: sp.tx, ty: sp.ty }, { t: 'call', fn: () => { if (sceneAlive(sc) && a.act === act) engine.arrive(a); } });
      q.push({ t: 'call', fn: () => arriveStep(sc, a, { ...step, pose: undefined, go: undefined }, null) });
    } else {
      if (tile) q.push({ t: 'go', tx: tile.tx, ty: tile.ty });
      q.push({ t: 'call', fn: () => arriveStep(sc, a, step, stand) });
    }
    // the virtual guest (a real idle agent) only gets the speech balloon
    const gi = guestIdx(sc);
    if (sc.guest && step.say && (step.actor === 'all' || step.actor === gi)) q.push({ t: 'call', fn: () => { if (sceneAlive(sc)) { const gs = sc.guest; gs.say = { text: Array.isArray(step.say) ? step.say[Math.floor(Math.random() * step.say.length)] : step.say, until: nowMs() + Math.max(wait2ms(step.wait), 2000) }; if (gs.mode !== 'sit' && !gs.pose) gs.dir = dirFrom(gs.x, gs.y, a.x, a.y); } } });
    const ms = wait2ms(step.wait);
    if (ms > 0) q.push({ t: 'wait', ms });
    a.q.unshift(...q);
  }
  function buildQueue(sc, a, i) {
    const gi = guestIdx(sc);
    let k = 0;
    sc.def.steps.forEach((step, si) => {
      const who = step.actor === undefined ? 0 : step.actor;
      const mine = who === 'all' || who === i || (who === gi && sc.guest && i === 0);
      const bar = step.sync ? k++ : -1;
      if (mine && (step.go || step.say || step.wait || step.pose || step.carry !== undefined || step.fx || step.turnAgent)) {
        const s2 = who === gi && sc.guest ? { say: step.say, wait: step.wait, actor: step.actor } : step;
        a.q.push({ t: 'call', fn: () => runStep(sc, a, s2, si) });
      }
      if (bar >= 0) a.q.push({ t: 'call', fn: () => { sc.arr[bar] = (sc.arr[bar] || 0) + 1; } }, { t: 'wait', ms: 15000, done: () => !sceneAlive(sc) || (sc.arr[bar] || 0) >= sc.actors.length });
    });
    a.q.push({ t: 'call', fn: () => { sc.done++; } });
  }
  function recruit(m, n, room) {
    const t = nowMs();
    const free = [...mm.values()].filter(x => x !== m && ['idle', 'act', 'do'].includes(x.mn.state) && x.alpha >= 1 && !x.fade && t - x.mn.born > 1500);
    free.sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y));
    return free.slice(0, n - 1);
  }
  function idleGuest(room, avoid) {
    return realAgents().find(e => e.s.status === 'idle' && !e.s.waiting && e.s.kind !== 'rapat' && !e.act && !e.cur && !e.q.length && e.mode !== 'walk' && !avoid.includes(e) && tileIn(room, e.mode === 'sit' && e.desk ? { tx: e.desk.seat.tx, ty: e.desk.seat.ty } : tileOfEnt(e)) && Date.now() - Date.parse(e.s.lastSeen) > 20e3) || null;
  }
  function startScene(m, def, room, n) {
    const others = n > 1 ? recruit(m, n, room) : [];
    const actors = [m, ...others];
    let guest = null;
    if (actors.length < (def.actors?.[0] || 1) || (def.withAgent && actors.length < n && Math.random() < .6)) {
      if (def.withAgent) guest = idleGuest(room, actors);
      if (actors.length + (guest ? 1 : 0) < (def.actors?.[0] || 1)) return false;
    }
    const sc = { def, room, actors, guest, arr: {}, done: 0, cancelled: false, at: nowMs() };
    sceneLast.set(def.id, sc.at);
    actors.forEach((a, i) => {
      stop(a); const st = a.mn; st.state = 'scene'; st.scene = sc; st.ai = i; st.last = 'scene:' + def.id; st.lastScene = def.id;
      buildQueue(sc, a, i);
      if (def.when === 'prayer') engine.minionPrayer(a);
    });
    return true;
  }
  function pickScene(m) {
    const scenes = env.scenes?.() || []; if (!scenes.length) return false;
    const praying = !!engine.prayerNow() && walkRooms().some(r => r.kind === 'musholla');
    const t = nowMs(), cands = [];
    for (const sc of scenes) {
      if (sc.when === 'prayer' && !praying) continue;
      if (sc.id === m.mn.lastScene) continue;
      const last = sceneLast.get(sc.id); if (last && t - last < (sc.cooldown || 60) * 1000) continue;
      const rooms = roomsOf(sc, m); if (!rooms.length || !needOk(sc)) continue;
      const room = rooms[Math.floor(Math.random() * rooms.length)];
      cands.push({ sc, room, w: (sc.weight || 1) * hourW(sc) * (praying ? (sc.when === 'prayer' ? 30 : .2) : 1) });
    }
    while (cands.length) {
      const c = wchoose(cands); cands.splice(cands.indexOf(c), 1);
      const [lo, hi] = c.sc.actors || [1, 1], n = lo + Math.floor(Math.random() * (hi - lo + 1));
      if (startScene(m, c.sc, c.room, n)) return true;
    }
    return false;
  }
  // per-tick upkeep of an actor in a scene: waits with a condition, speech cycling, loss of a held spot, end
  function sceneTick(m, now) {
    const st = m.mn, sc = st.scene;
    if (!sc || sc.cancelled) { stop(m); idle(m); return; }
    if (!sceneAlive(sc)) { cancelScene(sc); return; }
    if (m.cur?.t === 'wait' && m.cur.done && m.cur.done()) m.cur.ms = 0;
    if (st.holdAct && !m.act && m.pose === null && m.cur?.t !== 'go' && !m.q.some(x => x.t === 'go')) { /* nothing left to hold */ }
    if (st.holdAct && !m.act) { cancelScene(sc); return; }   // an agent or the owner took the spot
    if (st.cycle && now >= st.cycle.next) { const c = st.cycle; c.i = (c.i + 1) % c.arr.length; c.next = now + 2600; if (now < c.until) m.say = { text: c.arr[c.i], until: now + 2700 }; else st.cycle = null; }
    if (!m.cur && !m.q.length) endSceneActor(sc, m);
  }

  /* ---------------- lifecycle ---------------- */
  function spawn(mi, instant) {
    const hash = [...mi.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const m = env.spawn(mi.id, mi.look, !instant);
    m.minion = true; m.name = mi.name; m.homeRoom = (() => { const rs = env.plan().rooms.filter(r => r.kind !== 'zone' && r.kind !== 'toilet'); return rs.length ? rs[hash % rs.length].id : null; })();
    m.mn = { state: 'idle', nextAt: performance.now() + rnd(800, 4000), born: performance.now(), n: hash % 10, last: null, job: null, stand: null, desk: null };
    if (instant) { const sp = env.randomSpot(m.homeRoom); if (sp) { m.x = sp.tx * T + 4; m.y = sp.ty * T + 7; } m.mn.nextAt = performance.now() + rnd(100, 3500); }
    mm.set(mi.id, m);
  }
  function leave(id, why) {
    const m = mm.get(id); if (!m || m.mn.state === 'leave') return;
    stop(m);
    m.mn.state = 'leave'; m.bubble = ''; m.say = { text: why || 'Pamit', until: performance.now() + 2200 }; m.speed = 70;
    const el = W().elevator;
    m.q.push({ t: 'go', tx: el.tx, ty: el.ty }, { t: 'call', fn: () => { env.openElevator(1500); m.fade = true; } });
  }
  function wanted() {
    if (!view) return [];
    const base = view.minions || [];
    if (!view.auto) return base.slice(0, view.count);
    const working = env.sessions().filter(s => s.status === 'working' && s.kind !== 'rapat').length;
    return base.slice(0, autoCount(view.count, working));
  }
  function reconcile() {
    const want = wanted(), ids = new Set(want.map(x => x.id));
    for (const [id, m] of mm) if (!ids.has(id) && m.mn.state !== 'leave') leave(id);
    for (const [id, m] of mm) if (!env.ents.has(id) || (m.fade && m.alpha <= 0)) mm.delete(id);
    for (const w of want) if (!mm.has(w.id) && !spawnQ.some(x => x.id === w.id)) {
      if (first) spawn(w, true); else spawnQ.push(w);
    }
    spawnQ = spawnQ.filter(x => ids.has(x.id));
    first = false;
  }

  // a Magang passing the owner (< 3 tiles) waves; once per 40 s each
  function greetOwner(now) {
    const owners = [...env.ents.values()].filter(e => e.owner && !e.fade && e.alpha >= 1); if (!owners.length) return;
    for (const m of mm.values()) {
      if (m.fade || m.mn.state === 'leave' || now - (m.mn.greet || -1e9) < 40000 || m.say && m.say.until > now) continue;
      const o = owners.find(q => Math.hypot(q.x - m.x, q.y - m.y) < 24); if (!o) continue;
      m.mn.greet = now; m.say = { text: '\uD83D\uDC4B', until: now + 2200 };
      if (m.mode !== 'walk' && !m.pose) m.dir = dirFrom(m.x, m.y, o.x, o.y);
    }
  }

  const M = {
    /** Config from the server (office payload, GET, or {t:'minions'} event). */
    apply(v) { if (!v) return; view = v; lastAuto = performance.now(); reconcile(); },
    get view() { return view; },
    /** Start a scene by id right now (tests / debugging): false when no room, actor or need fits. */
    playScene(id) {
      const def = (env.scenes?.() || []).find(x => x.id === id); if (!def) return false;
      sceneLast.delete(id);
      for (const m of mm.values()) {
        if (!['idle', 'act', 'do'].includes(m.mn.state)) continue;
        const rooms = roomsOf(def, m); if (!rooms.length || !needOk(def)) return false;
        const [lo, hi] = def.actors || [1, 1];
        if (startScene(m, def, rooms[0], hi)) return rooms[0].id;
      }
      return false;
    },
    sceneOf: id => mm.get(id)?.mn.scene?.def.id || null,
    list: () => [...mm.values()],
    get: id => mm.get(id),
    count: () => [...mm.values()].filter(m => m.mn.state !== 'leave').length,
    leave: id => leave(id),
    worldChanged() { standCache = null; bocc.clear(); deskBy.clear(); for (const m of mm.values()) { m.mn.stand = null; m.mn.desk = null; } },
    /** The stage rebuilt its world (ents cleared): bring everyone back at once. */
    rebuild() { mm.clear(); spawnQ = []; pending = []; bocc.clear(); deskBy.clear(); standCache = null; first = true; reconcile(); },
    /** Live events -> courier jobs. */
    live(m) {
      switch (m.t) {
        case 'dm': if (m.from && m.to && m.from !== m.to && !seenDm.has(m.item?.id)) { seenDm.add(m.item?.id); if (seenDm.size > 300) seenDm.delete(seenDm.values().next().value); enqueue(jobs.mail(m.from, m.to, m.item?.id)); } break;
        case 'attachment': if (m.item) enqueue(jobs.parcel(m.sid, m.item.id)); break;
        case 'show': if (m.item) enqueue(jobs.parcel(m.item.sid, m.item.id)); break;
        case 'proc': {
          const p = m.proc; if (!p) { if (m.removed) procSt.delete(m.removed); break; }
          const was = procSt.get(p.id); procSt.set(p.id, p.status);
          if (was && was !== p.status && (p.status === 'gagal' || (was === 'jalan' && p.status !== 'jalan'))) enqueue(jobs.server(`${p.id}:${p.status}`));
          break;
        }
        case 'changed': if (m.what === 'wiki' && m.slug) enqueue(jobs.wiki(m.slug)); break;
      }
    },
    /** Board refetched: prev/next card lists. */
    cards(prev, next) { for (const d of diffCards(prev, next).slice(0, 6)) enqueue(jobs.card(d.kind, d.card)); },
    /** Session list (called from stage.sync): new meeting, waiting-for-permission, deploy-like commands. */
    sessions(list) {
      const cur = new Map();
      for (const s of list) {
        const tool = s.tool ? `${s.tool.name} ${s.tool.label || ''}` : '';
        cur.set(s.sid, { rapat: s.kind === 'rapat' && s.status !== 'ended', wait: !!s.waiting, deploy: s.status === 'working' && /\b(deploy|rsync|scp|kubectl|docker push|pm2 restart)\b/.test(tool) });
      }
      if (known) for (const [sid, c] of cur) {
        const o = known.get(sid) || {}, s = list.find(x => x.sid === sid);
        if (c.rapat && !o.rapat) { enqueue(jobs.meeting(sid, 1)); enqueue(jobs.meeting(sid, 2)); }
        if (c.wait && !o.wait && s.role) enqueue(jobs.ask(sid, s.role, () => env.sessions().some(x => x.sid === sid && x.waiting)));
        if (c.deploy && !o.deploy) enqueue(jobs.server(`deploy:${sid}`));
      }
      known = cur;
    },
    /** ~every 400 ms from the stage. */
    tick() {
      const now = performance.now();
      greetOwner(now);
      if (view?.auto && now - lastAuto > 5000) { lastAuto = now; reconcile(); }
      if (spawnQ.length && now - tickAt > 700 && mm.size < MAX) { tickAt = now; spawn(spawnQ.shift(), false); }
      for (const m of mm.values()) {
        const st = m.mn;
        if (m.fade || st.state === 'leave') continue;
        if (st.desk?.occ) { stop(m); idle(m, 300); continue; }       // an agent took the desk
        switch (st.state) {
          case 'idle': if (!m.cur && !m.q.length && now >= st.nextAt) planIdle(m); break;
          case 'act':
            if (!m.act && !st.stand && !st.desk) idle(m);               // the engine took the spot back (an agent needs it)
            else if (m.act) {
              if (m.act.phase === 'go' && !m.cur && !m.q.length && now - st.since > 2500) { stop(m); idle(m); }
              else { const r = engine.minionTick(m); if (r && r !== true) goAct(m, r); else if (r) idle(m); }
            } else if (!m.cur && !m.q.length && now - st.since > 4000) { freeStand(m); idle(m); }
            break;
          case 'do':
            if (now >= st.until) { if (st.desk) m.y += 1; freeStand(m); m.pose = null; m.fx = null; m.mode = 'stand'; idle(m); }
            break;
          case 'scene': sceneTick(m, now); break;
          case 'job':
            if (st.job?.cond && m.cur?.t === 'wait' && !st.job.cond()) m.cur.ms = 0;
            if (!m.cur && !m.q.length) { m.carry = null; m.bubble = ''; m.speed = 0; st.job = null; idle(m, 1500); }
            break;
        }
      }
      dispatch();
    },
  };
  return M;
}
