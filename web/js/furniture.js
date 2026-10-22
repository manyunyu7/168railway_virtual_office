// Furniture for the pixel office: catalog loader, sprite baker and the activity engine (behaviors.json).
// The renderer (office-canvas.js) owns drawing of characters; this file decides WHO goes WHERE and does WHAT.
//   loadCatalog()  -> GET /api/furniture once (cached by version), tolerant of failure / empty catalog
//   baked(def)     -> offscreen canvases per item/frame (cached)
//   createEngine(env) -> { layout, tick, placeFor, abort, release, insts, ... } (see bottom)
import { api } from './util.js';

export const T = 8;
const rnd = (a, b) => a + Math.random() * (b - a);
const rint = n => Math.floor(Math.random() * n);

/* ---------------- catalog ---------------- */
const NO_BEH = { prayer: { windowMin: 20, names: ['subuh', 'dzuhur', 'ashar', 'maghrib', 'isya'], steps: [] }, chat: { distance: 6, minIdleSec: 20, dwell: [30, 90] }, rules: [], fallback: [] };
let cat = { items: [], byId: new Map(), behaviors: NO_BEH, version: '' }, inflight = null;
const bakeCache = new Map();

const dw = (d, def) => Array.isArray(d) && d.length === 2 && d[0] <= d[1] ? d : def;
function normBeh(b) {
  if (!b || typeof b !== 'object') return NO_BEH;
  const fix = r => ({ ...r, when: r.when || {}, chance: typeof r.chance === 'number' ? r.chance : 1, pick: (r.pick || []).map(x => ({ a: x.a, w: x.w ?? 1 })), dwell: dw(r.dwell, [10, 30]) });
  return {
    prayer: { ...NO_BEH.prayer, ...(b.prayer || {}) }, chat: { ...NO_BEH.chat, ...(b.chat || {}) },
    rules: (Array.isArray(b.rules) ? b.rules : []).map(fix), fallback: (Array.isArray(b.fallback) ? b.fallback : []).map(fix),
  };
}
export const getCatalog = () => cat;
/** Load the catalog (one request, shared). force=true refetches; a changed `version` drops the baked sprites. */
export function loadCatalog(force = false) {
  if (inflight && !force) return inflight;
  inflight = api('/api/furniture').then(d => {
    const items = Array.isArray(d?.items) ? d.items : [];
    if (d?.version !== cat.version) bakeCache.clear();
    cat = { items, byId: new Map(items.map(i => [i.id, i])), behaviors: normBeh(d?.behaviors), scenes: Array.isArray(d?.scenes) ? d.scenes : [], version: d?.version || '', problems: d?.problems || [] };
    return cat;
  }).catch(() => cat);
  return inflight;
}

/* ---------------- sprite baker ---------------- */
function paint(def, rows) {
  const { w, h, palette } = def.sprite, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  for (let y = 0; y < h; y++) {
    const row = rows[y] || ''; let x = 0;
    while (x < w) {
      const ch = row[x]; if (!ch || ch === '.' || !palette[ch]) { x++; continue; }
      let n = 1; while (x + n < w && row[x + n] === ch) n++;
      c.fillStyle = palette[ch]; c.fillRect(x, y, n, 1); x += n;
    }
  }
  return cv;
}
/** { frames:[canvas], fps, active:canvas|null } for an item; cached. */
export function baked(def) {
  let b = bakeCache.get(def.id); if (b) return b;
  b = { frames: (def.frames?.length ? def.frames : [{ rows: def.sprite.rows }]).map(f => paint(def, f.rows)), fps: def.fps || 2, active: def.active ? paint(def, def.active.rows) : null };
  bakeCache.set(def.id, b);
  return b;
}

/* ---------------- prayer times ---------------- */
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

/* ---------------- behaviors: when-matching ---------------- */
const rxCache = new Map();
const rx = s => { let r = rxCache.get(s); if (!r) { try { r = new RegExp(s, 'i'); } catch { r = /$^/; } rxCache.set(s, r); } return r; };
function whenOk(w, x) {
  for (const k in w) {
    const v = w[k];
    switch (k) {
      case 'status': if (!(Array.isArray(v) ? v : [v]).includes(x.status)) return false; break;
      case 'tools': if (!x.tool || !(Array.isArray(v) ? v : [v]).includes(x.tool.name)) return false; break;
      case 'bash': if (x.tool?.name !== 'Bash' || !rx(v).test(x.tool.label || '')) return false; break;
      case 'label': if (!x.tool || !rx(v).test(x.tool.label || '')) return false; break;
      case 'subagent': if (!!v !== x.subagent) return false; break;
      case 'thinking': if (!!v !== x.thinking) return false; break;
      case 'idleMin': if (x.idleMin < v[0] || (v[1] != null && x.idleMin >= v[1])) return false; break;
      case 'neighbor': if (!!v !== !!x.neighbor) return false; break;
      case 'prayer': if (!!v !== !!x.prayer) return false; break;
      default: return false;
    }
  }
  return true;
}
// working agents only leave the desk for these; the rest of the work rules (type/test/server/meeting) keep the old desk/room logic
const WORK_VISIT = new Set(['print', 'whiteboard', 'phone', 'read']);
// pose sequence while praying: [name, seconds]
const PRAY = [['berdiri', 2.4], ['ruku', 1.6], ['berdiri', 1.1], ['sujud', 2], ['duduk', 1.4], ['sujud', 2], ['berdiri', 1.5]];
const PRAY_TOTAL = PRAY.reduce((a, p) => a + p[1], 0);
export function prayPhase(sec) { let t = sec % PRAY_TOTAL; for (const [n, d] of PRAY) { if (t < d) return n; t -= d; } return 'berdiri'; }

/**
 * env: { world(): world object, ents(): Map, roomOf(tx,ty): roomId|null, ownRoom(e): roomId|null,
 *        blocked(e,s): true while a higher-priority place (leave/meeting/server/qa/lib/music) owns the agent,
 *        zoneRoom?: unused }
 */
export function createEngine(env) {
  let insts = [], byAff = new Map(), seq = 0, pt = { date: null, times: null, retry: 0 };
  const prayed = new Map();   // sid -> Set('date:name')
  const E = { get insts() { return insts; }, get catalog() { return cat; } };
  const PERF = () => performance.now();

  /* ----- layout: instantiate placed furniture into the world ----- */
  E.layout = list => {
    const w = env.world(), { W, H, walk, inRoom, rooms } = w;
    insts = []; byAff = new Map();
    const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
    for (const p of list || []) {
      const def = cat.byId.get(p.item); if (!def) continue;
      const cx = Math.min(W - 1, Math.max(0, p.x + (def.w >> 1))), cy = Math.min(H - 1, Math.max(0, p.y + def.h - 1)), ri = inRoom[cy * W + cx];
      const inst = {
        uid: p.uid, def, b: baked(def), x: p.x, y: p.y, px: p.x * T, py: (p.y + def.h) * T - def.sprite.h, sortY: (p.y + def.h) * T,
        wall: !!def.wall, flat: !def.solid && !def.wall && def.sprite.h <= def.h * T, use: 0, spots: [], roomId: ri >= 0 ? rooms[ri].id : null,
      };
      if (def.solid && !def.wall) for (let yy = p.y; yy < p.y + def.h; yy++) for (let xx = p.x; xx < p.x + def.w; xx++) if (inb(xx, yy)) walk[yy * W + xx] = 0;
      insts.push(inst);
    }
    // spots standing inside their own footprint stay reachable; then validate every spot
    for (const inst of insts) {
      const { def } = inst;
      for (const s of def.spots || []) {
        const tx = inst.x + s.dx, ty = inst.y + s.dy;
        const own = tx >= inst.x && ty >= inst.y && tx < inst.x + def.w && ty < inst.y + def.h;
        if (own && inb(tx, ty) && w.baseWalk[ty * W + tx] && !def.wall) walk[ty * W + tx] = 1;
        inst.spots.push({ tx, ty, pose: s.pose, face: s.face || 'down', occ: null, ok: false });
      }
    }
    for (const inst of insts) for (const sp of inst.spots) {
      sp.ok = inb(sp.tx, sp.ty) && walk[sp.ty * W + sp.tx] === 1;
      if (sp.ok) w.seat.add(sp.ty * W + sp.tx);
    }
    for (const inst of insts) for (const a of inst.def.affords || []) { let l = byAff.get(a); if (!l) byAff.set(a, l = []); l.push(inst); }
    insts.sort((a, b) => a.sortY - b.sortY);
  };

  /* ----- finding a place ----- */
  const tileOf = e => [Math.floor(e.x / T), Math.floor(e.y / T)];
  const isMinion = id => !!env.ents().get(id)?.minion;
  // a real agent (or the owner) that takes a spot held by a Magang sends them away from it
  const evict = (spot, id) => { if (spot.occ && spot.occ !== id && isMinion(spot.occ)) { const m = env.ents().get(spot.occ); E.abort(m); spot.occ = null; } };
  function findSpot(e, aff, opt = {}) {
    const list = byAff.get(aff); if (!list) return null;
    const own = env.ownRoom(e), [ex, ey] = tileOf(e), now = PERF();
    let best = null, bs = Infinity;
    for (const inst of list) {
      if (opt.room && inst.roomId !== opt.room) continue;
      for (let i = 0; i < inst.spots.length; i++) {
        const sp = inst.spots[i];
        if (!sp.ok || (sp.occ && sp.occ !== e.id && (e.minion || !isMinion(sp.occ)))) continue;
        if (e.badSpots && e.badSpots.get(inst.uid + ':' + i) > now) continue;
        if (opt.pose && sp.pose !== opt.pose) continue;
        const score = Math.abs(sp.tx - ex) + Math.abs(sp.ty - ey) + (inst.roomId === own ? 0 : 30) + Math.random() * 6 - Math.min(4, (inst.def.weight || 1) - 1);
        if (score < bs) { bs = score; best = { inst, si: i }; }
      }
    }
    return best;
  }
  const wpick = list => { let t = 0; for (const p of list) t += p.w; let r = Math.random() * t; for (const p of list) { r -= p.w; if (r <= 0) return p; } return list[list.length - 1]; };
  // weighted random order without replacement; the last-used affordance goes to the back so visits vary
  function order(pick, last) {
    const rest = pick.filter(p => p.w > 0), out = [];
    while (rest.length) { const p = wpick(rest); out.push(p); rest.splice(rest.indexOf(p), 1); }
    if (last && out.length > 1) { const i = out.findIndex(p => p.a === last); if (i >= 0 && i < out.length - 1) out.push(out.splice(i, 1)[0]); }
    return out;
  }

  /* ----- prayer ----- */
  function ensurePrayer() {
    const d = ymd(new Date());
    if (pt.date === d && pt.times) return;
    if (Date.now() < pt.retry) return;
    pt.retry = Date.now() + 5 * 60e3;
    api(`/api/prayer-times?date=${d}`).then(r => { pt = { date: d, times: r, retry: 0 }; }).catch(() => {});
  }
  const prayNow = () => {
    if (!pt.times || pt.date !== ymd(new Date())) return null;
    const b = cat.behaviors.prayer, d = new Date(), m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    for (const n of b.names) { const t = hm(pt.times[n]); if (t != null && m >= t && m < t + (b.windowMin || 20)) return n; }
    return null;
  };
  const prayedKey = n => `${ymd(new Date())}:${n}`;

  /* ----- context of an agent ----- */
  function neighborOf(e) {
    const ch = cat.behaviors.chat, [ex, ey] = tileOf(e), room = env.roomOf(ex, ey);
    let best = null, bd = Infinity;
    for (const o of env.ents().values()) {
      if (o === e || o.sub || !o.s || o.leaving || o.fade || o.alpha < 1) continue;
      if (o.s.status !== 'idle' || o.s.waiting || o.s.kind === 'rapat') continue;
      if (o.act && (o.act.aff === 'chat' || o.act.aff === 'sleep' || o.act.src === 'prayer')) continue;
      if (o.talkUntil > PERF() || o.mode === 'walk' || o.pose === 'sleep' || o.pose === 'pray') continue;
      if ((Date.now() - Date.parse(o.s.lastSeen)) / 1000 < (ch.minIdleSec || 0)) continue;
      const [ox, oy] = tileOf(o); if (env.roomOf(ox, oy) !== room) continue;
      const d = Math.hypot(ox - ex, oy - ey); if (d <= (ch.distance || 6) && d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function ctxOf(e, s) {
    const idleSec = (Date.now() - Date.parse(s.lastSeen)) / 1000;
    const x = { status: s.waiting ? 'waiting' : s.status, tool: s.tool || null, subagent: !!s.subs?.some(q => q.status === 'working'), thinking: s.status === 'working' && !s.tool,
      idleMin: Number.isFinite(idleSec) ? Math.max(0, idleSec / 60) : 0, idleSec, neighbor: null, prayer: false, prayerName: null };
    const pn = prayNow(); if (pn && !prayed.get(e.sid)?.has(prayedKey(pn))) { x.prayer = true; x.prayerName = pn; }
    if (x.status === 'idle' && idleSec >= (cat.behaviors.chat.minIdleSec || 0)) x.neighbor = neighborOf(e);
    return x;
  }

  /* ----- deciding ----- */
  function mkAct(e, src, aff, hit, dwell, chain, rule) {
    const a = { id: ++seq, src, aff, inst: hit.inst, si: hit.si, phase: 'go', dwell, chain: chain || [], rule, until: 0, t0: 0 };
    evict(hit.inst.spots[hit.si], e.id);
    hit.inst.spots[hit.si].occ = e.id; e.act = a; return a;
  }
  function realize(e, r, x, working) {
    const b = cat.behaviors;
    if (r.then === 'prayer.steps' || r.when.prayer) {
      const steps = (b.prayer.steps || []).filter(st => byAff.has(st.a));
      if (!steps.length || !steps.some(st => st.a === 'pray') || !x.prayerName) return null;
      const first = steps[0], hit = findSpot(e, first.a); if (!hit) return null;
      let set = prayed.get(e.sid); if (!set) prayed.set(e.sid, set = new Set()); set.add(prayedKey(x.prayerName));
      return mkAct(e, 'prayer', first.a, hit, dw(first.dwell, [20, 40]), steps.slice(1), r.id);
    }
    for (const p of order(r.pick, e.lastAff)) {
      if (working && !WORK_VISIT.has(p.a)) return 'stay';
      if (p.a === 'chat' && x.neighbor) return startChat(e, x.neighbor, dw(r.dwell, b.chat.dwell || [30, 90]));
      const hit = findSpot(e, p.a);
      if (hit) return mkAct(e, working ? 'work' : 'idle', p.a, hit, r.dwell, null, r.id);
      if (working) return 'stay';
    }
    return null;
  }
  function evaluate(e, s) {
    const x = ctxOf(e, s), working = x.status === 'working', b = cat.behaviors;
    for (const r of b.rules) {
      if (!whenOk(r.when, x)) continue;
      if (r.chance < 1 && Math.random() >= r.chance) continue;
      const res = realize(e, r, x, working);
      if (res) return res === 'stay' ? null : res;
    }
    if (!working && x.status === 'idle') for (const r of b.fallback) {
      if (!whenOk(r.when, x)) continue;
      const res = realize(e, r, x, false); if (res && res !== 'stay') return res;
    }
    return null;
  }

  /* ----- chat between two idle agents ----- */
  function startChat(e, n, dwell) {
    const [nx, ny] = tileOf(n), w = env.world(), { W, H, walk } = w, [ex, ey] = tileOf(e);
    let best = null, bd = Infinity;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1]]) {
      const tx = nx + dx, ty = ny + dy; if (tx < 0 || ty < 0 || tx >= W || ty >= H || !walk[ty * W + tx] || w.seat.has(ty * W + tx)) continue;
      const d = Math.abs(tx - ex) + Math.abs(ty - ey); if (d < bd) { bd = d; best = { tx, ty }; }
    }
    if (!best) return null;
    const a = { id: ++seq, src: 'idle', aff: 'chat', inst: null, si: 0, phase: 'go', dwell, chain: [], rule: 'ngobrol', until: 0, t0: 0, partner: n.id, at: best };
    e.act = a; return a;
  }

  function release(e) {
    const a = e.act; if (a?.inst) { const sp = a.inst.spots[a.si]; if (sp && sp.occ === e.id) sp.occ = null; }
    for (const inst of insts) for (const sp of inst.spots) if (sp.occ === e.id) sp.occ = null;
  }
  /** Drop the current activity (agent goes back to its normal place). */
  E.abort = e => { release(e); e.act = null; e.pose = null; e.talkUntil = 0; };
  function finish(e, s) {
    const a = e.act; e.lastAff = a.aff;
    if (a.chain?.length) {
      const st = a.chain[0], hit = findSpot(e, st.a);
      if (hit) { release(e); const n = mkAct(e, a.src, st.a, hit, dw(st.dwell, [20, 40]), a.chain.slice(1), a.rule); e.pose = null; return n; }
    }
    release(e); e.act = null; e.pose = null; e.talkUntil = 0;
    e.nextEval = PERF() + rnd(1500, 4500);
    if (a.src === 'work') e.workCool = PERF() + rnd(15e3, 35e3);
  }

  /* ----- Magang (minions.js): same spots and poses as agents, driven by their own director, never preempting a real agent ----- */
  E.has = aff => byAff.has(aff);
  /** Walkable activity tiles of aff (optionally only items whose id matches rx), without reserving: [{tx,ty,roomId,uid}]. */
  E.tilesOf = (aff, rx) => (byAff.get(aff) || []).filter(i => !rx || rx.test(i.def.id)).flatMap(i => i.spots.filter(s => s.ok).map(s => ({ tx: s.tx, ty: s.ty, roomId: i.roomId, uid: i.uid })));
  /** Reserve a free spot for aff (optionally followed by chain [{a,dwell}]); null when none. The caller walks there and calls E.arrive. */
  E.minionStart = (e, aff, dwell, chain, room) => {
    const hit = findSpot(e, aff, room ? { room } : {}); if (!hit) return null;
    const steps = (chain || []).filter(c => byAff.has(c.a));
    return mkAct(e, 'minion', aff, hit, dwell, steps, 'magang');
  };
  /** Advance a Magang's activity: true when it just finished (spot released, pose cleared). Chains continue by themselves (returns the new act). */
  E.minionTick = e => {
    const a = e.act; if (!a || a.phase !== 'do' || PERF() < a.until) return false;
    if (a.chain?.length) { const st = a.chain[0], hit = findSpot(e, st.a); if (hit) { release(e); const n = mkAct(e, 'minion', st.a, hit, dw(st.dwell, [20, 40]), a.chain.slice(1), a.rule); e.pose = null; return n; } }
    release(e); e.act = null; e.pose = null; e.lastAff = a.aff; return true;
  };
  /** Name of the prayer time now (any), or null. */
  E.prayerNow = () => prayNow();
  /** Name of the prayer time a Magang has not prayed yet (marks it), or null. */
  E.minionPrayer = e => {
    const pn = prayNow(); if (!pn) return null;
    let set = prayed.get(e.id); if (!set) prayed.set(e.id, set = new Set());
    if (set.has(prayedKey(pn))) return null;
    set.add(prayedKey(pn)); return pn;
  };

  /** Called from the stage when the agent reaches the target tile. */
  E.arrive = e => {
    const a = e.act; if (!a || a.phase !== 'go') return;
    const now = PERF();
    if (a.aff === 'chat' && a.partner) {
      const n = env.ents().get(a.partner); const [ex, ey] = tileOf(e);
      if (!n || n.leaving || n.fade || n.s?.status !== 'idle' || Math.hypot(ex - Math.floor(n.x / T), ey - Math.floor(n.y / T)) > 3) { E.abort(e); return; }
      a.phase = 'do'; a.t0 = now; a.until = now + rnd(a.dwell[0], a.dwell[1]) * 1000;
      const dx = n.x - e.x, dy = n.y - e.y; e.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      if (n.mode !== 'sit' && !n.pose && !n.cur && !n.q.length) n.dir = e.dir === 'left' ? 'right' : e.dir === 'right' ? 'left' : e.dir === 'up' ? 'down' : 'up';
      e.talkUntil = n.talkUntil = a.until; e.talkWith = n.id; n.talkWith = e.id; e.talkSeed = n.talkSeed = Math.random() * 9;
      return;
    }
    const sp = a.inst.spots[a.si], [ex, ey] = tileOf(e);
    if (Math.abs(ex - sp.tx) > 1 || Math.abs(ey - sp.ty) > 1) { (e.badSpots ||= new Map()).set(a.inst.uid + ':' + a.si, now + 60e3); E.abort(e); return; }
    e.x = sp.tx * T + 4; e.y = sp.ty * T + 7; e.dir = sp.face; e.pose = sp.pose; e.poseAt = now; e.fx = a.aff; e.poseInst = a.inst; e.mode = 'stand';
    a.phase = 'do'; a.t0 = now; a.until = now + rnd(a.dwell[0], a.dwell[1]) * 1000;
  };

  /** Stage asks (inside desiredPlace) whether the agent is busy with an activity. */
  E.placeFor = e => e.act ? { key: 'furn:' + e.act.id, type: 'furn', act: e.act } : null;

  const bucket = m => m < .3 ? 0 : m < 5 ? 1 : m < 20 ? 2 : 3;
  /** Every ~400 ms: finish/abort activities, count use, start new ones. */
  E.tick = () => {
    const now = PERF(); ensurePrayer();
    for (const inst of insts) inst.use = 0;
    for (const e of env.ents().values()) {
      const s = e.s; if (e.sub || !s || e.leaving || e.fade) continue;
      let a = e.act;
      if (a) {
        if (s.waiting || s.status === 'ended' || (a.src === 'idle' && s.status === 'working')) { E.abort(e); a = null; }
        else if (a.phase === 'do' && now >= a.until) { finish(e, s); a = e.act; }
        if (a && a.phase === 'do' && a.inst) a.inst.use++;
      }
      if (e.act || s.waiting || s.kind === 'rapat' || (s.status !== 'working' && s.status !== 'idle')) continue;
      if (env.blocked(e, s)) continue;
      const sig = `${s.status}|${s.tool?.name || ''}|${(s.tool?.label || '').slice(0, 30)}|${bucket((Date.now() - Date.parse(s.lastSeen)) / 60e3 || 0)}`;
      const changed = sig !== e.fsig; e.fsig = sig;
      if (e.nextEval == null) e.nextEval = now + rnd(300, 5000);
      if (s.status === 'working') { if (!changed || now < (e.workCool || 0)) continue; }
      else if (now < e.nextEval && !changed) continue;
      if (!evaluate(e, s)) e.nextEval = now + rnd(8e3, 20e3);
    }
  };
  // a prayer activity is "one of" the idle ones; abort everything when the layout changes
  E.reset = () => { for (const e of env.ents().values()) E.abort(e); };
  /* ----- the owner (owner.js) uses spots too: claimed spots are skipped by agents like any occupied one ----- */
  /** Placed furniture whose footprint or spots lie within r tiles of (tx,ty), nearest first: [{inst, d}]. */
  E.near = (tx, ty, r = 1) => insts.map(inst => {
    const { def } = inst, fx = Math.max(inst.x, Math.min(tx, inst.x + def.w - 1)), fy = Math.max(inst.y, Math.min(ty, inst.y + def.h - 1));
    let d = Math.max(Math.abs(fx - tx), Math.abs(fy - ty));
    for (const sp of inst.spots) if (sp.ok) d = Math.min(d, Math.max(Math.abs(sp.tx - tx), Math.abs(sp.ty - ty)));
    return { inst, d };
  }).filter(x => x.d <= r).sort((a, b) => a.d - b.d);
  /** Claim spot si of inst for id (releases its other claims). false when someone else holds it. */
  E.claim = (id, inst, si) => {
    const sp = inst?.spots[si]; if (!sp || !sp.ok) return false;
    evict(sp, id);
    if (sp.occ && sp.occ !== id) return false;
    E.unclaim(id); sp.occ = id; return true;
  };
  E.unclaim = id => { for (const inst of insts) for (const sp of inst.spots) if (sp.occ === id) sp.occ = null; };
  E.freeSpots = roomId =>insts.flatMap(i => i.roomId === roomId ? i.spots.filter(s => s.ok && !s.occ).map(s => ({ uid: i.uid, tx: s.tx, ty: s.ty, pose: s.pose })) : []);
  return E;
}
