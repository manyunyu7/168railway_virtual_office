import { live, logOffice, whoOf, bus, serialize } from './live.js';
import { tmux, sendKeys, hasTmux } from './tmux.js';
import { codexScreen, parseModelPicker, parseEffortPicker, parsePermPicker, parsePickerRows, codexModels, modeLabelRe, effortLabelRe, footerModel, CODEX_MODES, validEffort, readCodexSettings } from './codex.js';

// Drives Codex's own /model and /permissions pickers inside a kantor tmux pane, the Codex twin of modelpick.js.
// Rows are found by their text, never by position, so a changed model list or order cannot pick the wrong one.
// Real screens (Codex CLI 0.163):
//
//   Select Model and Effort                          Select Reasoning Level for GPT-6-Astra
//   › 1. GPT-6.1-Sol (current)  Latest workhorse…      1. Low               Fast responses…
//     2. GPT-6-Astra            Frontier intelligence…› 2. Medium (default)  Balances speed…
//     enter select · esc back                          5. More reasoning…   Max and Ultra consume usage limits faster
//                                                       enter default · s session · esc back
//   Update Model Permissions
//   › 1. Ask for approval (current)  2. Approve for me  3. Full Access  4. Read Only
//
// Enter on the effort screen would save the choice as the global default (~/.codex/config.toml), so we press `s`
// (this session only). Done message: "Model changed to gpt-6-astra low for this session only".
// The permissions menu applies for the session; its footer says nothing, so the result is read back by reopening it.

const screen = name => { try { return tmux(['capture-pane', '-p', '-t', name]); } catch { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const err = (msg, code = 409) => Object.assign(new Error(msg), { code });

async function waitFor(name, test, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = test(screen(name));
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(120);
  }
}
// scrollback too: a message from an earlier change must not count as this one's confirmation
const history = name => { try { return tmux(['capture-pane', '-p', '-t', name, '-S', '-300']); } catch { return ''; } };
const CHANGED = /Model changed to (\S+) (\S+) for this session only/g;
const cursorOf = rows => rows?.find(r => r.cursor)?.index ?? null;

/** Type a slash command and wait for its menu. */
async function openMenu(name, cmd, parser, { busyOk = false } = {}) {
  // right after a start or a change Codex is busy for a moment: type only into a ready composer, and try twice
  const ready = t => { const sc = codexScreen(t); return busyOk ? sc.composer && !sc.picker && !sc.approval : sc.idle; };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!await waitFor(name, ready, 8000)) throw err('Codex belum siap menerima perintah. Coba lagi sebentar.', 504);
    await sleep(attempt ? 1500 : 400);
    sendKeys(name, ['-l', cmd]);
    await sleep(500);
    sendKeys(name, ['Enter']);
    const rows = await waitFor(name, parser, 6000);
    if (rows) return rows;
    // Esc on an idle composer would arm "edit previous message": close a menu with it, clear typed text otherwise
    try { sendKeys(name, [codexScreen(screen(name)).picker ? 'Escape' : 'C-u']); } catch {}
  }
  throw err(`Menu ${cmd} tidak muncul. Coba lagi sebentar.`, 504);
}

/** Move the cursor onto the row `match` accepts. Returns that row. */
async function moveTo(name, parser, match) {
  let rows = parser(screen(name));
  if (!rows) throw err('Menu sudah tertutup', 409);
  const target = rows.find(match);
  if (!target) return null;
  const n = rows.length;
  let cur = cursorOf(rows);
  for (let i = 0; i < n + 2 && cur !== target.index; i++) {
    const idx = rows.findIndex(r => r.index === cur), tgt = rows.findIndex(r => r.index === target.index);
    sendKeys(name, [tgt > idx ? 'Down' : 'Up']);
    await sleep(80);
    rows = parser(screen(name));
    if (!rows) throw err('Menu tertutup di tengah jalan', 409);
    cur = cursorOf(rows);
  }
  if (cur !== target.index) throw err('Gagal menggeser pilihan', 500);
  return rows.find(r => r.index === cur);
}

function paneOf(sid) {
  const s = live.get(sid), name = s?.tmux;
  if (!s) throw err('Sesi tidak ditemukan', 404);
  if (s.engine !== 'codex') throw err('Ini bukan sesi Codex');
  if (!name || !hasTmux(name)) throw err('Ganti pengaturan hanya untuk sesi yang jalan di terminal kantor. Untuk sesi lain, ketik perintahnya di jendela terminalnya.');
  return { s, name };
}
// busyOk: Codex opens /permissions while a turn runs and applies the choice mid-turn (tested on 0.163); /model waits
function requireIdle(name, { busyOk = false } = {}) {
  const sc = codexScreen(screen(name));
  if (sc.busy && !busyOk) throw err('Agen sedang bekerja; hentikan atau tunggu');
  if (sc.approval) throw err('Sesi sedang menunggu izin di terminalnya. Jawab dulu, lalu coba lagi.');
  if (sc.picker) { try { sendKeys(name, ['Escape']); } catch {} }
  else if (!sc.composer) throw err('Sesi belum siap menerima perintah. Coba lagi sebentar.');
}

/** Reasoning-effort row: by effort id ("xhigh" -> "Extra high"), through "More reasoning…" for max/ultra. */
async function pickEffort(name, effort) {
  const re = effortLabelRe(effort);
  if (!re) throw err(`Effort tidak dikenal: ${effort}`, 400);
  let hit = await moveTo(name, parseEffortPicker, r => re.test(r.label));
  if (!hit) {
    const more = await moveTo(name, parseEffortPicker, r => /^more reasoning/i.test(r.label));
    if (!more) throw err(`Model ini tidak menyediakan effort ${effort}`, 400);
    sendKeys(name, ['Enter']);
    await sleep(400);
    hit = await moveTo(name, parseEffortPicker, r => re.test(r.label));
    if (!hit) throw err(`Model ini tidak menyediakan effort ${effort}`, 400);
  }
  return hit;
}

/** Change model and/or effort for this session only. Missing parts keep their current value. */
export async function setCodexModel(sid, { model, effort } = {}) {
  const { s, name } = paneOf(sid);
  if (effort && !validEffort(effort)) throw err('Effort tidak valid', 400);
  requireIdle(name);
  const info = await codexModels();
  const bySlug = new Map(info.models.map(m => [m.slug, m]));
  const wanted = model ? (bySlug.get(model) || info.models.find(m => m.name.toLowerCase() === String(model).toLowerCase())) : null;
  if (model && !wanted && info.models.length) throw err(`Model tidak dikenal: ${model}`, 400);
  const seen = [...history(name).matchAll(CHANGED)].length;
  await openMenu(name, '/model', parseModelPicker);
  try {
    const label = wanted ? wanted.name.toLowerCase() : null;
    const hit = await moveTo(name, parseModelPicker, r => label ? r.label.toLowerCase() === label : r.current)
      || (model ? await moveTo(name, parseModelPicker, r => r.label.toLowerCase().includes(String(model).toLowerCase())) : null);
    if (!hit) throw err(`Model ${model} tidak ada di pemilih Codex`, 400);
    sendKeys(name, ['Enter']);
    if (!await waitFor(name, parseEffortPicker, 4000)) throw err('Pemilih effort tidak muncul', 504);
    // no effort given: keep the current one when the new model has it, else the model's default
    const want = effort || s.effort;
    let row = null;
    if (want) { try { row = await pickEffort(name, want); } catch (e) { if (effort) throw e; } }
    if (!row) row = await moveTo(name, parseEffortPicker, r => r.isDefault) || await moveTo(name, parseEffortPicker, () => true);
    sendKeys(name, ['s']);
    const done = await waitFor(name, () => { const all = [...history(name).matchAll(CHANGED)]; return all.length > seen ? { model: all.at(-1)[1], effort: all.at(-1)[2] } : null; }, 5000);
    if (!done) throw err('Tidak ada konfirmasi dari Codex. Cek terminal sesi.', 504);
    s.model = done.model; s.effort = done.effort;
    bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
    logOffice(s.office, whoOf(s), `mengganti model ke ${done.model} (${done.effort})`, 'session');
    return { ok: true, model: done.model, effort: done.effort };
  } catch (e) {
    // leave no menu open on the pane
    for (let i = 0; i < 3 && codexScreen(screen(name)).picker; i++) { try { sendKeys(name, ['Escape']); } catch {} await sleep(250); }
    throw e;
  }
}

/** Open /permissions, read which row is (current), close it. */
export async function readCodexMode(name, { busyOk = false } = {}) {
  await openMenu(name, '/permissions', parsePermPicker, { busyOk });
  const rows = parsePermPicker(screen(name)) || [];
  sendKeys(name, ['Escape']);
  await sleep(250);
  const cur = rows.find(r => r.current);
  return cur ? (CODEX_MODES.find(m => modeLabelRe(m).test(cur.label)) || null) : null;
}

/** Switch the approval/sandbox preset through /permissions and read it back. */
export async function setCodexMode(sid, target) {
  const { s, name } = paneOf(sid);
  if (!CODEX_MODES.includes(target)) throw err(`Mode tidak dikenal. Pilihan: ${CODEX_MODES.join(', ')}`, 400);
  requireIdle(name, { busyOk: true });
  await openMenu(name, '/permissions', parsePermPicker, { busyOk: true });
  try {
    const hit = await moveTo(name, parsePermPicker, r => modeLabelRe(target).test(r.label));
    if (!hit) throw err('Mode itu tidak ada di menu /permissions Codex', 400);
    sendKeys(name, ['Enter']);
    await sleep(900);
    // a confirmation (Full Access) may follow: Codex words it as a numbered list headed "…permission…"
    let t = screen(name);
    if (parsePickerRows(t, /full access|are you sure|confirm/i) && !codexScreen(t).idle) {
      const yes = await moveTo(name, x => parsePickerRows(screen(name), /full access|are you sure|confirm/i), r => /^yes|^enable|^continue|^proceed|^i understand/i.test(r.label));
      if (yes) { sendKeys(name, ['Enter']); await sleep(700); }
    }
  } catch (e) {
    for (let i = 0; i < 3 && codexScreen(screen(name)).picker; i++) { try { sendKeys(name, ['Escape']); } catch {} await sleep(250); }
    throw e;
  }
  const now = await readCodexMode(name, { busyOk: true });
  if (now) s.permMode = now;
  bus.emit('msg', { t: 'session', office: s.office, session: serialize(s) });
  if (now !== target) throw err('Codex tidak menerima mode itu. Cek terminal sesi.', 502);
  logOffice(s.office, whoOf(s), `mengganti mode izin ke ${target}`, 'session');
  return { mode: now };
}

/** model, effort and mode of a Codex pane as best we can tell: footer for model+effort, rollout for mode. */
export function codexState(sid) {
  const { s, name } = paneOf(sid);
  const f = footerModel(screen(name));
  const cs = readCodexSettings(s.transcript);
  return { model: s.model || null, effort: f?.effort || s.effort || null, footerName: f?.name || null, mode: cs?.mode || s.permMode || null };
}
