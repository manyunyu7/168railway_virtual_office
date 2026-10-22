// Furniture mode of the layout editor ("Perabot" tab): a searchable palette of the catalog (GET /api/furniture),
// drag/tap placement with live valid/invalid preview, move/duplicate/delete of placed items, auto-furnish a room,
// and a small "add room" form. State (the placed list) lives in layout-editor.js so undo and save share it;
// this module only reads it through `h` and writes it back with h.setFurn().
import { esc, api, toast, confirmDo, hashStr } from './util.js';
import { WH, overlap, interior, inRoom, mulberry, doorLands, fillRoom as coreFill } from './furnish-core.js';

export { WH, doorLands };
const CAT_ORDER = ['kerja', 'dapur', 'santai', 'ibadah', 'taman', 'dekor', 'teknik'];
const KINDS = [['kode', 'Kerja / kode'], ['meeting', 'Rapat'], ['lib', 'Perpustakaan'], ['qa', 'Lab QA'], ['server', 'Server'], ['pantry', 'Pantry'],
  ['beku', 'Gudang'], ['game', 'Game'], ['manager', 'Manager'], ['musik', 'Musik'], ['musholla', 'Musholla'], ['lounge', 'Lounge'], ['gym', 'Gym'],
  ['taman', 'Taman'], ['telepon', 'Ruang telepon'], ['tidur', 'Tidur']];

export function createFurnitureEditor(h) {
  const { stage, layer, office } = h;
  let items = [], byId = new Map(), version = '', loading = false;
  let q = '', cat = '', fit = true, armed = null, selUid = null, seed = 1, last = null;
  let addOpen = false, addName = '', addKind = 'kode', addBusy = false, palScroll = 0, suppress = false;
  let active = false, fd = null, pd = null, flash = 0;
  const live = typeof stage.setFurniture === 'function';
  const el = document.createElement('div');
  el.className = 'le-furn'; el.hidden = true;
  el.innerHTML = '<div class="le-items"></div><div class="le-gh" hidden></div>';
  const itemsEl = el.firstChild, ghostEl = el.lastChild;
  let ghost = null;   // { def, x, y, why }
  let ph = 0, uidN = 0;

  const def = id => byId.get(id);
  const sel = () => h.furn().find(f => f.uid === selUid) || null;
  const room = () => (h.selRoom() ? h.rooms().find(r => r.id === h.selRoom()) : null) || null;
  const roomAt = (x, y) => h.rooms().find(r => inRoom(r, x, y)) || null;
  const uid = () => `fe${Date.now().toString(36)}${(uidN++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  /* ---------- catalog + sprites ---------- */
  const urls = new Map();
  function spriteUrl(d) {
    if (urls.has(d.id)) return urls.get(d.id);
    const c = document.createElement('canvas'); c.width = d.sprite.w; c.height = d.sprite.h;
    const g = c.getContext('2d');
    d.sprite.rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const col = row[x] === '.' ? null : d.sprite.palette[row[x]]; if (col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); } } });
    const u = c.toDataURL(); urls.set(d.id, u); return u;
  }
  async function loadCatalog(force) {
    if (loading || (items.length && !force)) return;
    loading = true;
    let list = null;
    try { list = stage.furnitureCatalog?.(); } catch {}
    if (!list?.length) { try { const r = await api('/api/furniture'); list = r.items; version = r.version || ''; } catch {} }
    items = (list || []).filter(d => d && d.sprite && d.w && d.h);
    byId = new Map(items.map(d => [d.id, d])); urls.clear();
    loading = false;
    if (active) { h.refresh(); render(); }
  }

  /* ---------- rules ---------- */
  const desksOf = () => (stage.world?.desks || []).flatMap(d => [
    { x: d.tx, y: d.ty, w: d.w, h: 2 }, ...(d.seat ? [{ x: d.seat.tx, y: d.seat.ty, w: 1, h: 1 }] : []), ...(d.front ? [{ x: d.front.tx, y: d.front.ty, w: 1, h: 1 }] : [])]);
  /** Tiles the room already had before any catalog furniture (built-in counters, racks, the lift): blocked in the stage's walk grid and not ours. */
  function builtIn() {
    const w = stage.world; if (!w?.walk) return () => false;
    const mine = new Set();
    for (const f of h.furn()) { const o = def(f.item); if (o && o.solid) for (let y = f.y; y < f.y + o.h; y++) for (let x = f.x; x < f.x + o.w; x++) mine.add(y * w.W + x); }
    return (x, y) => x >= 0 && y >= 0 && x < w.W && y < w.H && w.walk[y * w.W + x] === 0 && !mine.has(y * w.W + x);
  }
  /** Why `d` cannot stand with its top-left tile at (x,y); null when fine. */
  function check(d, x, y, ignore, list = h.furn()) {
    const r = roomAt(x, y);
    if (!r) return 'Di luar ruangan';
    const I = interior(r);
    if (x < I.x0 || y < I.y0 || x + d.w > I.x1 || y + d.h > I.y1) return 'Keluar dari ruangan';
    if (d.wall && y !== I.y0) return 'Harus menempel dinding atas';
    const box = { x, y, w: d.w, h: d.h };
    for (const f of list) {
      if (f.uid === ignore) continue;
      const o = def(f.item), ob = { x: f.x, y: f.y, w: o ? o.w : 1, h: o ? o.h : 1 };
      if (overlap(box, ob) && !!d.solid === !(o && !o.solid)) return d.solid ? 'Menabrak perabot lain' : 'Karpet atau dekor bertumpuk';
    }
    if (d.solid) {
      for (const k of desksOf()) if (overlap(box, k)) return 'Menabrak meja';
      for (const k of doorLands(r)) if (overlap(box, k)) return 'Menutup pintu';
      const blocked = builtIn();
      for (let yy = y; yy < y + d.h; yy++) for (let xx = x; xx < x + d.w; xx++) if (blocked(xx, yy)) return 'Menabrak dekor ruangan';
    }
    return null;
  }

  /* ---------- auto-furnish ---------- */
  /** New items for room `r` (the list already holds what is there). Deterministic for a given rnd. The rules live in furnish-core.js. */
  function fillRoom(r, rnd, list) {
    return coreFill(r, rnd, list, { def, uid, desks: desksOf(), blocked: builtIn(),
      cands: items.filter(d => (d.rooms || []).some(k => k === r.kind || k === '*')) });
  }

  function runFill(scope, reroll) {
    if (!items.length) return toast('Katalog perabot kosong', 'bad');
    const picked = scope === 'all' ? h.rooms() : [room()].filter(Boolean);
    if (!picked.length) return toast('Pilih ruangan dulu', 'bad');
    let rs = picked;
    if (reroll) { seed = (Math.random() * 1e6) | 0; if (last) rs = last.rooms.map(id => h.rooms().find(r => r.id === id)).filter(Boolean); }
    let list = h.furn();
    if (reroll && last) list = list.filter(f => !last.uids.has(f.uid));
    h.record();
    const added = [];
    for (const r of rs) {
      const res = fillRoom(r, mulberry(hashStr(`${seed}:${r.id}`)), list);
      list = list.concat(res); added.push(...res);
    }
    last = { uids: new Set(added.map(f => f.uid)), rooms: rs.map(r => r.id) };
    h.setFurn(list);
    toast(added.length ? `${added.length} perabot ditaruh (seed ${seed})` : 'Ruangan sudah cukup penuh atau tak ada perabot yang cocok', added.length ? 'ok' : '');
  }

  /* ---------- overlay ---------- */
  const visibleFurn = () => { const rs = h.rooms(); return h.furn().filter(f => rs.some(r => inRoom(r, f.x, f.y))); };
  function render() {
    if (!active) return;
    const list = visibleFurn().sort((a, b) => (def(a.item)?.solid ? 1 : 0) - (def(b.item)?.solid ? 1 : 0) || a.y - b.y);
    itemsEl.innerHTML = list.map(f => {
      const d = def(f.item), bad = d && check(d, f.x, f.y, f.uid);
      return `<div class="le-fi${f.uid === selUid ? ' sel' : ''}${bad ? ' bad' : ''}${d ? '' : ' unk'}" data-uid="${esc(f.uid)}" title="${esc(d ? d.name : f.item)}">${!live && d ? `<img src="${spriteUrl(d)}" alt="">` : ''}</div>`;
    }).join('');
    place();
  }
  function place() {
    if (!active) return;
    const s = stage.scale(), byUid = new Map(h.furn().map(f => [f.uid, f]));
    for (const n of itemsEl.children) {
      const f = byUid.get(n.dataset.uid); if (!f) continue;
      const d = def(f.item), [x, y] = stage.toScreen(f.x, f.y);
      n.style.transform = `translate(${x}px,${y}px)`; n.style.width = (d ? d.w : 1) * s + 'px'; n.style.height = (d ? d.h : 1) * s + 'px';
    }
    if (ghost) {
      const [x, y] = stage.toScreen(ghost.x, ghost.y), d = ghost.def;
      ghostEl.hidden = false; ghostEl.className = 'le-gh ' + (ghost.why ? 'bad' : 'ok');
      ghostEl.style.transform = `translate(${x}px,${y}px)`; ghostEl.style.width = d.w * s + 'px'; ghostEl.style.height = d.h * s + 'px';
      ghostEl.dataset.why = ghost.why || '';
      if (ghostEl.dataset.id !== d.id) { ghostEl.dataset.id = d.id; ghostEl.innerHTML = `<img src="${spriteUrl(d)}" alt="">`; }
    } else ghostEl.hidden = true;
  }
  function setGhost(d, x, y, ignore) {
    ghost = d ? { def: d, x, y, why: check(d, x, y, ignore) } : null;
    place();
  }
  /** Where the item should sit for a pointer at `e`: centred (or by grab offset), pulled inside the room under the finger. */
  function aim(d, e, off) {
    const t = stage.toTile(e.clientX, e.clientY);
    let x = Math.round(t.x - (off ? off.x : d.w / 2)), y = Math.round(t.y - (off ? off.y : d.h / 2));
    const r = roomAt(Math.floor(t.x), Math.floor(t.y));
    if (r) {
      const I = interior(r);
      if (I.x1 - I.x0 >= d.w) x = Math.max(I.x0, Math.min(I.x1 - d.w, x));
      if (I.y1 - I.y0 >= d.h) y = Math.max(I.y0, Math.min(I.y1 - d.h, y));
      if (d.wall) y = I.y0;
    }
    return { x, y };
  }
  const inStage = e => { const b = el.getBoundingClientRect(); return e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom && !document.elementFromPoint(e.clientX, e.clientY)?.closest('.le-panel'); };

  /* ---------- editing ---------- */
  function selectItem(u) { selUid = u; render(); h.refresh(); }
  function addItem(d, x, y) {
    const why = check(d, x, y);
    if (why) { toast(why, 'bad'); return false; }
    h.record();
    const f = { uid: uid(), item: d.id, x, y };
    selUid = f.uid; h.setFurn([...h.furn(), f]);
    return true;
  }
  function remove() {
    const f = sel(); if (!f) return;
    h.record(); selUid = null; h.setFurn(h.furn().filter(x => x.uid !== f.uid));
  }
  function duplicate() {
    const f = sel(), d = f && def(f.item); if (!d) return;
    const spots = [];
    for (let r = 1; r <= 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) spots.push([f.x + dx * d.w, f.y + dy * d.h], [f.x + dx, f.y + dy]);
    const s = spots.find(([x, y]) => !check(d, x, y));
    if (!s) return toast('Tidak ada tempat kosong di dekatnya', 'bad');
    addItem(d, s[0], s[1]);
  }
  function nudge(dx, dy) {
    const f = sel(), d = f && def(f.item); if (!d) return false;
    const x = f.x + dx, y = f.y + dy, why = check(d, x, y, f.uid);
    if (why) { toast(why, 'bad'); return true; }
    h.record(); h.setFurn(h.furn().map(o => o.uid === f.uid ? { ...o, x, y } : o)); return true;
  }
  function disarm() { armed = null; ghost = null; place(); h.refresh(); }

  /* ---------- pointer (layer + items) ---------- */
  function down(e, nav) {
    if (e.button !== 0) return;
    const tgt = e.currentTarget;
    nav.down(e);
    if (nav.size > 1) { tgt.setPointerCapture(e.pointerId); fd = null; ghost = null; place(); e.preventDefault(); return; }
    const touch = e.pointerType !== 'mouse', hitEl = e.target.closest?.('.le-fi');
    if (armed) fd = { kind: 'armed', touch, sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, moved: false };
    else if (hitEl) {
      const f = h.furn().find(x => x.uid === hitEl.dataset.uid), d = f && def(f.item), t = stage.toTile(e.clientX, e.clientY);
      if (f && d) {
        fd = { kind: 'item', uid: f.uid, d, off: { x: t.x - f.x, y: t.y - f.y }, f0: f, moved: false, sx: e.clientX, sy: e.clientY, slop: touch ? 8 : 3 };
        if (selUid !== f.uid) { selUid = f.uid; render(); h.refresh(); }
      }
    } else fd = { kind: 'pan', touch, px: e.clientX, py: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
    tgt.setPointerCapture(e.pointerId);
    if (fd?.kind === 'armed' && touch) { const p = aim(armed, e); setGhost(armed, p.x, p.y); }
    e.preventDefault();
  }
  function move(e, nav) {
    if (nav.move(e)) return;
    if (!fd) {
      if (armed && e.pointerType === 'mouse') { const p = aim(armed, e); setGhost(armed, p.x, p.y); }
      return;
    }
    const far = Math.hypot(e.clientX - fd.sx, e.clientY - fd.sy);
    if (fd.kind === 'pan' || (fd.kind === 'armed' && !fd.touch)) {
      if (far > 4) fd.moved = true;
      if (fd.moved) { stage.panBy(e.clientX - fd.px, e.clientY - fd.py); }
      fd.px = e.clientX; fd.py = e.clientY;
      if (fd.kind === 'armed' && fd.moved) { ghost = null; place(); }
    } else if (fd.kind === 'armed') {
      fd.moved = true; const p = aim(armed, e); setGhost(armed, p.x, p.y);
    } else if (fd.kind === 'item') {
      if (!fd.started && far < fd.slop) return;
      if (!fd.started) { fd.started = true; if (live) stage.setFurniture(h.furn().filter(x => x.uid !== fd.uid)); }
      fd.moved = true; const p = aim(fd.d, e, fd.off); fd.pos = p;
      itemsEl.querySelector(`[data-uid="${CSS.escape(fd.uid)}"]`)?.classList.add('lift');
      setGhost(fd.d, p.x, p.y, fd.uid);
    }
  }
  function up(e, nav) {
    nav.up(e, !!fd && fd.kind === 'pan' && fd.touch && fd.moved);
    const f = fd; fd = null;
    if (!f) return;
    if (f.kind === 'item') {
      if (f.started && f.pos) {
        const why = check(f.d, f.pos.x, f.pos.y, f.uid);
        ghost = null;
        if (!why && (f.pos.x !== f.f0.x || f.pos.y !== f.f0.y)) { h.record(); h.setFurn(h.furn().map(o => o.uid === f.uid ? { ...o, x: f.pos.x, y: f.pos.y } : o)); return; }
        if (why) toast(why, 'bad');
        if (live) stage.setFurniture(h.furn());
        render();
      }
      return;
    }
    if (f.kind === 'armed') {
      if (!f.touch && f.moved) { place(); return; }
      const p = aim(armed, e);
      if (addItem(armed, p.x, p.y)) { ghost = null; place(); } else { setGhost(armed, p.x, p.y); }
      return;
    }
    if (!f.moved) {   // a tap on bare floor: pick the room under it, or nothing
      const t = stage.toTile(e.clientX, e.clientY), r = roomAt(Math.floor(t.x), Math.floor(t.y));
      selUid = null; h.selectRoom(r ? r.id : null); render();
    }
  }
  function cancel(e, nav) { nav.up(e, false); fd = null; ghost = null; place(); if (live) stage.setFurniture(h.furn()); render(); }
  function wheel(e) { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); const b = layer.getBoundingClientRect(); stage.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - b.left, e.clientY - b.top); }

  /* palette drag with a mouse; touch uses tap-then-tap */
  const onDocMove = e => {
    if (!pd) return;
    if (!pd.moved && Math.hypot(e.clientX - pd.sx, e.clientY - pd.sy) < 6) return;
    pd.moved = true; armed = pd.d;
    if (inStage(e)) { const p = aim(pd.d, e); setGhost(pd.d, p.x, p.y); } else { ghost = null; place(); }
  };
  const onDocUp = e => {
    document.removeEventListener('pointermove', onDocMove); document.removeEventListener('pointerup', onDocUp);
    const p = pd; pd = null;
    if (!p || !p.moved) return;
    armed = null;
    suppress = true; setTimeout(() => { suppress = false; }, 0);
    ghost = null;
    if (inStage(e)) { const a = aim(p.d, e); addItem(p.d, a.x, a.y); }
    place(); h.refresh();
  };

  /* ---------- panel ---------- */
  const cats = () => { const s = new Set(items.map(d => d.cat)); return [...CAT_ORDER.filter(c => s.has(c)), ...[...s].filter(c => !CAT_ORDER.includes(c)).sort()]; };
  function filtered() {
    const r = room(), needle = q.trim().toLowerCase();
    return items.filter(d => (!cat || d.cat === cat) && (!needle || `${d.name} ${d.id} ${d.cat}`.toLowerCase().includes(needle))
      && (!fit || !r || (d.rooms || []).some(k => k === r.kind || k === '*')));
  }
  const zoomFor = d => Math.max(1, Math.min(4, Math.floor(Math.min(84 / d.sprite.w, 52 / d.sprite.h))));
  const card = d => `<button type="button" class="lf-card${armed?.id === d.id ? ' on' : ''}" data-lf="pick" data-id="${esc(d.id)}" title="${esc(d.name)} · ${d.w}×${d.h}${d.wall ? ' · dinding' : ''}">
      <span class="lf-th"><img src="${spriteUrl(d)}" alt="" loading="lazy" width="${d.sprite.w * zoomFor(d)}" height="${d.sprite.h * zoomFor(d)}"></span><span class="lf-nm">${esc(d.name)}</span></button>`;
  const palHTML = () => {
    const list = filtered();
    return list.length ? list.map(card).join('') : `<p class="hint lf-none">${items.length ? 'Tidak ada perabot yang cocok. Matikan filter ruangan atau ganti kata kunci.' : loading ? 'Memuat katalog…' : 'Katalog perabot kosong atau gagal dimuat.'}</p>`;
  };
  function panelHTML() {
    const r = room(), f = sel(), fd_ = f && def(f.item), cs = cats();
    const total = h.furn().filter(x => r && inRoom(r, x.x, x.y)).length;
    return `<section class="le-sec lf-sec"><h3>Perabot${items.length ? ` · ${items.length}` : ''}</h3>
        <input type="search" class="lf-q" data-lf="q" placeholder="Cari perabot…" value="${esc(q)}" autocomplete="off" aria-label="Cari perabot">
        <div class="lf-cats" role="group" aria-label="Kategori">
          <button type="button" class="lf-chip${cat ? '' : ' on'}" data-lf="cat" data-v="">Semua</button>${cs.map(c => `<button type="button" class="lf-chip${cat === c ? ' on' : ''}" data-lf="cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <label class="lf-fit"><input type="checkbox" data-lf="fit" ${fit ? 'checked' : ''} ${r ? '' : 'disabled'}> <span>${r ? `Cocok untuk <b>${esc(r.name)}</b>` : 'Cocok untuk ruangan terpilih (pilih ruangan)'}</span></label>
        <div class="lf-pal" data-lf-pal>${palHTML()}</div>
        <p class="hint lf-help">${armed ? `<b>${esc(armed.name)}</b> siap: ${matchMedia('(pointer:coarse)').matches ? 'ketuk denah untuk menaruh' : 'klik denah untuk menaruh, atau seret'}. <button type="button" class="lf-link" data-lf="disarm">Selesai</button>`
          : 'Seret perabot ke denah, atau ketuk perabot lalu ketuk denah. Hijau = bisa, merah = tidak bisa.'}</p></section>
      ${f ? `<section class="le-sec"><h3>${esc(fd_ ? fd_.name : f.item)}</h3>
        <p class="hint">Posisi ${f.x}, ${f.y}${fd_ ? ` · ${fd_.w}×${fd_.h}` : ''}. Seret untuk memindah, panah menggeser 1 tile.</p>
        <div class="btn-row"><button type="button" class="btn sm" data-lf="dup">Duplikat</button><button type="button" class="btn sm danger" data-lf="del">Hapus</button></div></section>` : ''}
      <section class="le-sec"><h3>Isi perabot otomatis</h3>
        <p class="hint">${r ? `Ruangan: <b>${esc(r.name)}</b> (${esc(r.kind)}), ${total} perabot.` : 'Pilih ruangan di denah, atau isi semuanya.'} Jalan dari pintu ke setiap titik duduk tetap kosong; meja penghuni tidak ditutup. Musholla: sajadah berbaris rapi menghadap satu arah (mengikuti arah hadap di data perabot, saat ini ke atas layar), rak sandal dan tempat wudhu di dekat pintu.</p>
        <div class="btn-row"><button type="button" class="btn sm primary" data-lf="fill" ${r ? '' : 'disabled'}>Isi ruangan ini</button>
          <button type="button" class="btn sm" data-lf="fill-all">Isi semua</button>
          <button type="button" class="btn sm" data-lf="reroll" title="Ganti seed dan ulangi isian terakhir">Acak lagi</button></div>
        <div class="btn-row"><span class="hint">Seed ${seed}</span><button type="button" class="btn sm" data-lf="clear" ${r ? '' : 'disabled'}>Kosongkan ruangan</button></div></section>
      <section class="le-sec"><button type="button" class="lf-fold" data-lf="add-toggle" aria-expanded="${addOpen}"><h3>Tambah ruangan</h3><span>${addOpen ? '−' : '+'}</span></button>
        ${addOpen ? `<label>Nama<input type="text" data-lf="add-name" value="${esc(addName)}" maxlength="40" placeholder="mis. Musholla Lt 2"></label>
        <label>Jenis<select data-lf="add-kind">${KINDS.map(([v, l]) => `<option value="${v}"${v === addKind ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <button type="button" class="btn sm primary" data-lf="add-go" ${addBusy ? 'disabled' : ''}>${addBusy ? 'Menambah…' : 'Tambah'}</button>` : ''}</section>`;
  }
  /** After the panel was rebuilt: put the palette scroll back. */
  function afterPanel(panel) {
    const pal = panel.querySelector('[data-lf-pal]'); if (pal) pal.scrollTop = palScroll;
  }
  function repal(panel) { const p = panel.querySelector('[data-lf-pal]'); if (p) p.innerHTML = palHTML(); }

  async function addRoom() {
    const name = addName.trim();
    if (!name) return toast('Nama ruangan wajib diisi', 'bad');
    addBusy = true; h.refresh();
    try {
      const { id } = await api(`/api/offices/${office.id}/rooms`, { method: 'POST', body: { name, kind: addKind } });
      const L = await api(`/api/offices/${office.id}/layout`);
      const nr = L.plan.rooms.find(r => r.id === id);
      if (!nr) throw new Error('Ruangan dibuat, tapi belum muncul di denah. Muat ulang halaman.');
      h.addedRoom(nr);
      addName = ''; toast(`Ruangan ${name} ditambahkan`, 'ok');
    } catch (err) { toast(err.message, 'bad'); }
    addBusy = false; h.refresh();
  }

  function panelClick(panel, e) {
    if (suppress) return;
    const b = e.target.closest('[data-lf]'); if (!b || b.disabled || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
    switch (b.dataset.lf) {
      case 'cat': cat = b.dataset.v; h.refresh(); break;
      case 'pick': { const d = def(b.dataset.id); armed = armed?.id === d.id ? null : d; ghost = null; place(); h.refresh(); break; }
      case 'disarm': disarm(); break;
      case 'dup': duplicate(); break;
      case 'del': remove(); break;
      case 'fill': runFill('sel'); break;
      case 'fill-all': runFill('all'); break;
      case 'reroll': runFill(last?.rooms.length > 1 ? 'all' : 'sel', true); break;
      case 'clear': {
        const r = room(); if (!r) break;
        h.record(); selUid = null; h.setFurn(h.furn().filter(x => !inRoom(r, x.x, x.y))); last = null; break;
      }
      case 'add-toggle': addOpen = !addOpen; h.refresh(); break;
      case 'add-go': addRoom(); break;
    }
  }
  function panelInput(panel, e) {
    const t = e.target;
    if (t.dataset.lf === 'q') { q = t.value; repal(panel); }
    else if (t.dataset.lf === 'add-name') addName = t.value;
  }
  function panelChange(panel, e) {
    const t = e.target;
    if (t.dataset.lf === 'fit') { fit = t.checked; h.refresh(); }
    else if (t.dataset.lf === 'add-kind') addKind = t.value;
  }
  function panelDown(e) {
    const c = e.target.closest?.('.lf-card'); if (!c || e.pointerType !== 'mouse' || e.button !== 0) return;
    const d = def(c.dataset.id); if (!d) return;
    pd = { d, sx: e.clientX, sy: e.clientY, moved: false };
    document.addEventListener('pointermove', onDocMove); document.addEventListener('pointerup', onDocUp);
  }

  function key(e) {
    if (e.key === 'Escape') { if (armed) { disarm(); return true; } if (selUid) { selectItem(null); return true; } return false; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && sel()) { e.preventDefault(); duplicate(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel()) { e.preventDefault(); remove(); return true; }
    const f = sel(); if (!f) return false;
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (k) { e.preventDefault(); return nudge(k[0], k[1]); }
    return false;
  }

  el.addEventListener('pointerdown', e => down(e, h.nav));
  el.addEventListener('pointermove', e => move(e, h.nav));
  el.addEventListener('pointerup', e => up(e, h.nav));
  el.addEventListener('pointercancel', e => cancel(e, h.nav));
  el.addEventListener('pointerleave', e => { if (!fd && e.pointerType === 'mouse' && ghost && armed) { ghost = null; place(); } });
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('contextmenu', e => e.preventDefault());

  return {
    el, check, fillRoom, get armed() { return armed; },
    get active() { return active; },
    activate(on) {
      active = on; el.hidden = !on;
      if (on) { loadCatalog(); render(); } else { armed = null; ghost = null; fd = null; selUid = null; ghostEl.hidden = true; }
    },
    reload: () => loadCatalog(true),
    render, place, panelHTML, afterPanel, panelClick, panelInput, panelChange, panelDown, key,
    onPalScroll: v => { palScroll = v; },
    down, move, up, cancel, wheel,
    select: u => { selUid = u; },
    destroy() { document.removeEventListener('pointermove', onDocMove); document.removeEventListener('pointerup', onDocUp); el.remove(); },
  };
}
