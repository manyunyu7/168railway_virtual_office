import { live, logOffice, whoOf, bus, serialize } from './live.js';
import { tmux, sendKeys, hasTmux, paneMode } from './tmux.js';

// Drives Claude Code's own /model picker inside a kantor tmux pane. The list is whatever the picker shows;
// nothing here knows model names. Real screen (Claude Code 2.1.x):
//
//    Select model
//      1.  Default (recommended)  Sonnet 5.5 · Efficient for routine tasks
//    ❯ 4.  Sonnet 5.5 ✔           Most efficient for simpler tasks      (❯ = cursor, ✔ = active)
//    ↓ 10. Opus 4.8               Best for everyday, complex tasks      (window of 10; "… +3 models" hidden)
//      Enter to set as default · s to use this session only · Esc to cancel
//
// Digits pick AND save as the global default, so we never use them: arrows to the row, then `s` (this session only).
// Up/Down wrap around. Done message: "Set model to X for this session only"; Esc: "Kept model as X".

// visible screen only: scrollback may still hold an old picker frame
const screen = name => { try { return tmux(['capture-pane', '-p', '-t', name]); } catch { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OPEN_TIMEOUT_MS = 4000, IDLE_CLOSE_MS = 60000;
const open = new Map(); // tmux name -> { timer, cursor, n }

const ROW = /^\s*(❯|↑|↓)?\s*(\d+)\.\s+(.*?)\s*$/;
/** Visible rows of the picker on a captured screen: {index, label, desc, current, cursor}. */
export function parsePicker(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/Select model/.test(l)) at = i; });
  if (at < 0) return null;
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    const m = ROW.exec(l);
    if (!m) { if (rows.length && /Enter to |Esc to /.test(l)) break; continue; }
    const [label, ...rest] = m[3].split(/\s{2,}/);
    rows.push({ index: +m[2], label: label.replace(/\s*✔\s*$/, '').trim(), desc: rest.join(' ').trim(), current: /✔/.test(label), cursor: m[1] === '❯' });
  }
  return rows.length ? rows : null;
}

const err = (msg, code = 409) => Object.assign(new Error(msg), { code });
async function waitFor(name, test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const txt = screen(name), v = test(txt);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(120);
  }
}
const cursorOf = rows => rows?.find(r => r.cursor)?.index ?? null;

function arm(name) {
  const o = open.get(name) || {};
  clearTimeout(o.timer);
  o.timer = setTimeout(() => { cancelPicker(name).catch(() => {}); }, IDLE_CLOSE_MS);
  o.timer.unref?.();
  open.set(name, o);
  return o;
}

/** Open /model in the pane and read the whole list (scrolling through it once and back). */
export async function openPicker(name) {
  if (!hasTmux(name)) throw err('Sesi tidak berjalan di terminal kantor');
  let rows = parsePicker(screen(name));
  if (!rows) {
    sendKeys(name, ['-l', '/model']);
    await sleep(500);
    sendKeys(name, ['Enter']);
    rows = await waitFor(name, parsePicker, OPEN_TIMEOUT_MS);
    if (!rows) { try { sendKeys(name, ['Escape']); } catch {} throw err('Pemilih model tidak muncul. Coba lagi sebentar.', 504); }
  }
  // collect every row: step Down until the cursor is back where it started
  const all = new Map(rows.map(r => [r.index, r]));
  const start = cursorOf(rows);
  let cur = start;
  for (let i = 0; i < 60; i++) {
    sendKeys(name, ['Down']);
    await sleep(70);
    const now = parsePicker(screen(name));
    if (!now) break;
    for (const r of now) all.set(r.index, { ...all.get(r.index), ...r, cursor: false });
    cur = cursorOf(now);
    if (cur == null || cur === start) break;
  }
  const options = [...all.values()].sort((a, b) => a.index - b.index).map(({ index, label, desc, current }) => ({ index, label, desc, current }));
  const o = arm(name);
  o.cursor = cur; o.n = options.length;
  return { options };
}

const modelId = label => {
  const m = /^(Opus|Sonnet|Haiku|Fable)\s+(\d+(?:\.\d+)?)/i.exec(label || '');
  return m ? `claude-${m[1].toLowerCase()}-${m[2].replace('.', '-')}` : null;
};

/** Move the cursor to option `index` and confirm for this session only. */
export async function selectOption(name, index) {
  if (!hasTmux(name)) throw err('Sesi tidak berjalan di terminal kantor');
  index = +index;
  let rows = parsePicker(screen(name));
  if (!rows) throw err('Pemilih model sudah tertutup. Buka lagi.', 409);
  const o = open.get(name) || arm(name);
  const n = o.n || Math.max(...rows.map(r => r.index));
  if (!(index >= 1 && index <= n)) throw err('Pilihan tidak ada', 400);
  let cur = cursorOf(rows);
  for (let i = 0; i < n + 2 && cur !== index; i++) {
    const fwd = ((index - cur) % n + n) % n;
    sendKeys(name, [fwd <= n / 2 ? 'Down' : 'Up']);
    await sleep(70);
    rows = parsePicker(screen(name));
    if (!rows) throw err('Pemilih model tertutup di tengah jalan', 409);
    cur = cursorOf(rows);
  }
  if (cur !== index) throw err('Gagal menggeser pilihan', 500);
  const row = rows.find(r => r.index === index);
  clearTimeout(o.timer); open.delete(name);
  sendKeys(name, ['s']);
  const done = await waitFor(name, t => { const m = /Set model to (.+?) for this session only/.exec(t); return m ? { model: m[1] } : /Kept model as/.test(t) ? { kept: true } : null; }, 4000);
  if (!done) throw err('Tidak ada konfirmasi dari Claude Code. Cek terminal sesi.', 504);
  if (done.kept) throw err('Model tidak berubah');
  return { ok: true, model: done.model, label: row?.label || done.model, desc: row?.desc || '' };
}

export async function cancelPicker(name) {
  const o = open.get(name);
  if (o) { clearTimeout(o.timer); open.delete(name); }
  if (hasTmux(name) && parsePicker(screen(name))) sendKeys(name, ['Escape']);
  return { ok: true };
}

// ---- session-level wrappers used by the routes ----
function paneOf(sid) {
  const s = live.get(sid), name = s?.tmux;
  if (!s) throw err('Sesi tidak ditemukan', 404);
  if (s.engine === 'codex') throw err('Sesi Codex: ganti model lewat POST /api/sessions/:sid/codex/settings', 400);
  if (!name || !hasTmux(name)) throw err('Ganti model hanya untuk sesi yang jalan di terminal kantor. Untuk sesi lain, ketik /model di jendelanya.');
  return { s, name };
}
export async function openForSession(sid) {
  const { s, name } = paneOf(sid);
  if (!open.has(name)) {
    if (!['idle', 'waiting'].includes(s.status)) throw err('Agen sedang bekerja; hentikan atau tunggu');
    if (paneMode(name) == null && !parsePicker(screen(name))) throw err('Sesi sedang menampilkan dialog. Jawab dulu di terminalnya, lalu coba lagi.');
  }
  const r = await openPicker(name);
  logOffice(s.office, whoOf(s), 'membuka pemilih model', 'session');
  return r;
}
export async function selectForSession(sid, index) {
  const { s, name } = paneOf(sid);
  const r = await selectOption(name, index);
  const id = modelId(r.model) || modelId(r.label);
  if (id) s.model = id;
  bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
  logOffice(s.office, whoOf(s), `mengganti model ke ${r.model}`, 'session');
  return { ok: true, model: r.model };
}
export async function cancelForSession(sid) {
  const { name } = paneOf(sid);
  return cancelPicker(name);
}
