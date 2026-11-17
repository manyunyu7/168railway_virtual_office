// Jawaban agen yang sedang ditulis, dibaca dari layar pane tmux (capture-pane -p -J -e): transkrip JSONL Claude Code
// dan rollout Codex baru ditulis setelah satu pesan selesai, tapi TUI keduanya sudah menampilkan teksnya. Modul ini
// murni (tanpa tmux/ssh/db): pengurai warna ANSI, pemotong bagian jawaban terbaru per engine, perapi teks (baris yang
// dibungkus terminal disambung lagi, judul, daftar, kode inline, tautan, tabel/kode di dalam ```, markdown mentah Codex
// yang belum tertutup), penyambung layar Codex yang bergulir, dan
// pembanding dengan pesan asisten terakhir di transkrip. Kabelnya ada di stream.js.
//
// Contoh nyata (fixture di test/fixtures/stream/):
//   Claude Code 2.1.x (layar biasa, riwayat ikut di -S): prompt pengguna "❯ …" (latar abu), jawaban "⏺ …" dengan
//   baris lanjutan menjorok 2, alat "⏺ Bash(ls)" + "  ⎿ …" atau "  Listed 1 directory (ctrl+o to expand)", spinner
//   "✳ Herding… (9s · …)" / "✻ Sautéed for 20s · done", lalu kotak input (garis ─, "❯ ", garis ─, footer).
//   Codex 0.16x (layar alternatif, hanya yang terlihat): prompt "› …" (latar abu, dipaku di baris atas saat bergulir),
//   jawaban "• …" + lanjutan menjorok 2, alat "• Explored/Ran/Called …" + "  └ …", "• Working (4s • esc to interrupt)",
//   "  Worked for 40s • 13:04", lalu composer "› Ask Codex to do anything" dan footer.

export const MAX_TEXT = 8000;

/* ---------------- ANSI (keluaran capture-pane -e: SGR saja, status warna berlanjut antarbaris) ---------------- */
/**
 * Teks capture-pane -e → baris [{ t, cells:[{ch, b, dim, it, ul, fg, bg, link}] }]. t = teks polos (panjangnya = cells,
 * per code point). link = URL hyperlink OSC 8 (Claude Code dan Codex menandai tautan dengan itu). Tanpa escape (capture
 * tanpa -e) hasilnya sama, hanya tanpa atribut.
 */
export function parseAnsi(text) {
  const out = [];
  let st = { ...PLAIN }, link = null;
  let cells = [];
  const src = String(text ?? '').replace(/\r/g, '');
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\x1b') {
      const n = src[i + 1];
      if (n === '[') { // CSI: hanya SGR (m) yang dipakai
        let j = i + 2;
        while (j < src.length && !/[@-~]/.test(src[j])) j++;
        if (src[j] === 'm') st = sgr(st, src.slice(i + 2, j));
        i = j + 1; continue;
      }
      if (n === ']') { // OSC: hyperlink 8;params;url (url kosong = akhir tautan), lainnya dibuang; diakhiri BEL atau ESC \
        let j = i + 2;
        while (j < src.length && src[j] !== '\x07' && !(src[j] === '\x1b' && src[j + 1] === '\\')) j++;
        const m = /^8;[^;]*;(.*)$/s.exec(src.slice(i + 2, j));
        if (m) link = m[1] || null;
        i = src[j] === '\x07' ? j + 1 : j + 2; continue;
      }
      i += 2; continue;
    }
    if (c === '\n') { out.push(lineOf(cells)); cells = []; i++; continue; }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp < 0x20) continue;
    cells.push({ ch: ch === '\u00a0' ? ' ' : ch, nbsp: ch === '\u00a0', ...st, link });
  }
  if (cells.length) out.push(lineOf(cells));
  return out;
}
const PLAIN = { b: false, dim: false, it: false, ul: false, fg: null, bg: null };
function lineOf(cells) {
  let n = cells.length;
  while (n && cells[n - 1].ch === ' ' && !cells[n - 1].nbsp) n--;
  cells = cells.slice(0, n);
  return { t: cells.map(x => x.ch).join(''), cells };
}
function sgr(st, params) {
  // bagian dengan ":" adalah sub-parameter satu atribut (4:3 garis bawah keriting, 38:2::r:g:b)
  const parts = params === '' ? ['0'] : params.split(';');
  st = { ...st };
  for (let k = 0; k < parts.length; k++) {
    if (parts[k].includes(':')) {
      const q = parts[k].split(':').map(x => +x || 0);
      if (q[0] === 4) st.ul = q[1] !== 0;
      else if (q[0] === 38 || q[0] === 48) {
        const rgb = q.slice(-3), col = q[1] === 5 ? `5;${q[2]}` : q[1] === 2 ? `2;${rgb.join(';')}` : null;
        if (q[0] === 38) st.fg = col; else st.bg = col;
      }
      continue;
    }
    const v = +parts[k] || 0;
    if (v === 0) st = { ...PLAIN };
    else if (v === 1) st.b = true;
    else if (v === 2) st.dim = true;
    else if (v === 3) st.it = true;
    else if (v === 4) st.ul = true;
    else if (v === 22) { st.b = false; st.dim = false; }
    else if (v === 23) st.it = false;
    else if (v === 24) st.ul = false;
    else if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97)) st.fg = String(v);
    else if (v === 39) st.fg = null;
    else if ((v >= 40 && v <= 47) || (v >= 100 && v <= 107)) st.bg = String(v);
    else if (v === 49) st.bg = null;
    else if (v === 38 || v === 48) {
      const p = parts.map(x => +x || 0);
      let col = null;
      if (p[k + 1] === 5) { col = `5;${p[k + 2]}`; k += 2; } else if (p[k + 1] === 2) { col = `2;${p[k + 2]};${p[k + 3]};${p[k + 4]}`; k += 4; }
      if (v === 38) st.fg = col; else st.bg = col;
    }
  }
  return st;
}
const lead = l => l.t.length - l.t.trimStart().length;
const blank = l => !l.t.trim();
const firstCell = l => l.cells[lead(l)] || null;
const LINE = l => ({ t: '', cells: [], ...l });
/** Baris dengan awalan diganti spasi (mis. "⏺ " / "• " jadi "  "), atributnya tetap. */
function unprefix(l, n = 2) {
  const cells = l.cells.map((c, i) => i < n ? { ...c, ch: ' ', b: false, it: false, ul: false, fg: null, link: null } : c);
  return { t: cells.map(x => x.ch).join(''), cells };
}

/* ---------------- Claude Code ---------------- */
const RULE = /^\s*─{8,}/;
const CLAUDE_DOT = /^[⏺●]\s/;
const CLAUDE_STATUS = /^[✻✳✢✶✽·*✺❋✦✧∗⋆◆◇]\s/; // spinner dan "✻ Sautéed for 20s · done"
const CTRL_O = /\(ctrl\+o to (?:expand|see all)\)|ctrl\+o to expand/;
const CLAUDE_TOOL_HEAD = /^(?:[\w.:-]+(?: - [\w .:-]+)?(?: \(MCP\))?)\(/; // "Bash(ls)", "kantor - card_get (MCP)(…)"
const isFence = l => /^\s*⎿/.test(l.t);

/**
 * Bagian jawaban Claude Code yang sedang ditulis: blok "⏺" teks terakhir di bawah prompt pengguna terakhir,
 * asal tidak ada blok alat sesudahnya. → { lines, head } (head = awal blok terlihat) atau null.
 */
export function claudeBlock(lines) {
  // kotak input: "❯" yang tepat di bawah garis ─ (paling bawah). Tanpa kotak (dialog izin, menu): tidak dibaca.
  let top = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^❯(?:\s|$)/.test(lines[i].t) && RULE.test(lines[i - 1].t)) { top = i - 1; break; }
  }
  if (top < 0) return null;
  // prompt pengguna terakhir di atasnya ("❯ " di kolom 0), lewati baris lanjutannya
  let start = 0, head = false;
  for (let i = top - 1; i >= 0; i--) {
    if (/^❯\s/.test(lines[i].t)) { start = i + 1; while (start < top && !blank(lines[start]) && lead(lines[start]) > 0) start++; head = true; break; }
  }
  const region = lines.slice(start, top);
  // pecah jadi blok: baris kolom 0 memulai blok; baris menjorok ikut blok sebelumnya, kecuali baris alat ringkas
  // (abu-abu "Listed 1 directory (ctrl+o to expand)", atau judul yang diikuti "⎿", saat titiknya sedang berkedip)
  const blocks = [];
  let cur = null;
  const open = (kind, at) => { cur = { kind, lines: [], at }; blocks.push(cur); };
  for (let i = 0; i < region.length; i++) {
    const l = region[i];
    if (blank(l)) { if (cur) cur.lines.push(l); continue; }
    if (lead(l) === 0) {
      if (CLAUDE_DOT.test(l.t)) {
        const body = l.t.replace(CLAUDE_DOT, '');
        const next = region.slice(i + 1).find(x => !blank(x));
        const tool = CLAUDE_TOOL_HEAD.test(body) || CTRL_O.test(body) || (next && isFence(next) && region.indexOf(next) === i + 1);
        open(tool ? 'tool' : 'text', i);
        cur.lines.push(tool ? l : unprefix(l));
      } else if (CLAUDE_STATUS.test(l.t)) { open('status', i); cur.lines.push(l); }
      else if (/^∴/.test(l.t)) { open('thinking', i); cur.lines.push(l); }
      else { open('other', i); cur.lines.push(l); }
      continue;
    }
    const prevBlank = i === 0 || blank(region[i - 1]);
    const toolish = CTRL_O.test(l.t) || (prevBlank && region[i + 1] && isFence(region[i + 1]) && lead(l) <= 2);
    if (!cur || (toolish && cur.kind !== 'status' && cur.kind !== 'tool')) { open(toolish ? 'tool' : 'cont', i); }
    else if (cur.kind === 'text' && isFence(l)) cur.kind = 'tool';
    cur.lines.push(l);
  }
  const content = blocks.filter(b => b.kind !== 'status');
  const last = content[content.length - 1];
  if (!last) return null;
  if (last.kind === 'text') return { lines: trimBlank(last.lines), head: true };
  // awal jawaban sudah lewat dari riwayat yang dibaca: baris menjorok tanpa "⏺" di atas
  if (last.kind === 'cont' && !head && content.length === 1) return { lines: trimBlank(last.lines), head: false };
  return null;
}

/* ---------------- Codex ---------------- */
const CODEX_TOOL = /^• (?:Called|Calling|Ran|Running|Explored|Exploring|Edited|Editing|Added|Deleted|Read|Reading|Searched|Searching|Listed|Waited|Waiting|Updated Plan|Updated|Viewed|Applied|Proposed|Change|Interrupted|Generated|Generating|You)\b/;
const CODEX_STATUS = /^• \S.*\(\d+[smh]?\S*\s*•\s*(?:esc|ctrl)/; // "• Working (4s • esc to interrupt)"
const CODEX_DONE = /^\s*(?:─\s*)?Worked for \d/;

/**
 * Bagian jawaban Codex yang sedang ditulis: item "•" teks terakhir di bawah prompt terakhir, asal tidak ada item alat
 * sesudahnya. Codex memakai layar alternatif, jadi awal jawaban panjang bisa sudah tergulir (head:false).
 */
export function codexBlock(lines) {
  // composer: "›" terakhir di kolom 0 tanpa latar (prompt di riwayat berlatar abu)
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^›(?:\s|$)/.test(lines[i].t) && !lines[i].cells[0]?.bg) { bottom = i; break; }
  }
  if (bottom < 0) return null;
  let start = 0, head = false;
  for (let i = bottom - 1; i >= 0; i--) {
    if (/^›(?:\s|$)/.test(lines[i].t)) {
      start = i + 1;
      // lanjutan prompt (berlatar), juga saat ANSI tidak ada: baris menjorok sampai baris kosong
      const ansi = lines[i].cells.some(c => c.bg);
      while (start < bottom && !blank(lines[start]) && lead(lines[start]) > 0 && (ansi ? !!firstCell(lines[start])?.bg : true)) start++;
      head = true; break;
    }
  }
  const region = lines.slice(start, bottom);
  const blocks = [];
  let cur = null;
  const open = kind => { cur = { kind, lines: [] }; blocks.push(cur); };
  for (let i = 0; i < region.length; i++) {
    const l = region[i];
    if (blank(l)) { if (cur) cur.lines.push(l); continue; }
    if (lead(l) === 0) {
      if (/^•\s/.test(l.t)) {
        const next = region[i + 1];
        const kind = CODEX_STATUS.test(l.t) ? 'status' : CODEX_TOOL.test(l.t) || (next && /^\s{1,4}└/.test(next.t)) ? 'tool' : 'text';
        open(kind);
        cur.lines.push(kind === 'text' ? unprefix(l) : l);
      } else { open('other'); cur.lines.push(l); }
      continue;
    }
    if (CODEX_DONE.test(l.t)) { open('status'); cur.lines.push(l); continue; }
    if (!cur) open('cont');
    if (cur.kind === 'text' && /^\s{1,4}└/.test(l.t)) cur.kind = 'tool';
    if (cur.kind === 'cont' && (/^\s{1,4}└/.test(l.t) || /^\s+\+ Show details/.test(l.t))) cur.kind = 'tool';
    cur.lines.push(l);
  }
  const content = blocks.filter(b => b.kind !== 'status');
  const last = content[content.length - 1];
  if (!last) return null;
  if (last.kind === 'text') return { lines: trimBlank(last.lines), head: true };
  if (last.kind === 'cont' && content.length === 1) return { lines: trimBlank(last.lines), head: false };
  return null;
}
function trimBlank(ls) {
  let a = 0, b = ls.length;
  while (a < b && blank(ls[a])) a++;
  while (b > a && blank(ls[b - 1])) b--;
  return ls.slice(a, b);
}

/* ---------------- layar Codex yang bergulir ---------------- */
/**
 * Sambung baris yang sudah terkumpul (prev) dengan layar baru (next) yang mungkin sudah bergulir: cari tempat awal
 * `next` bertumpuk dengan ekor `prev` (baris terakhir prev boleh masih terpotong). Tanpa tumpukan → next saja.
 */
export function stitch(prev, next, head) {
  if (head || !prev?.length) return next;
  // baris kosong diabaikan (Codex menyisipkan jarak antarparagraf setelah markdown-nya selesai), begitu juga tanda
  // markdown yang masih mentah di baris terakhir ("`nama.txt" lalu jadi "nama.txt" berwarna)
  const T = l => l.t.trim().replace(/[`*~]/g, '');
  const pa = prev.map((l, i) => [T(l), i]).filter(x => x[0]);
  const nb = next.map(T).filter(Boolean);
  if (!nb.length) return prev;
  // baris terakhir prev tidak dibandingkan: baris yang sedang ditulis bisa dibungkus ulang ("…hanya mengg" →
  // "…hanya" + "menggambarkan")
  for (let i = 0; i < pa.length; i++) {
    const n = pa.length - 1 - i;
    if (n > nb.length) continue;
    let ok = true;
    for (let j = 0; j < n; j++) if (pa[i + j][0] !== nb[j]) { ok = false; break; }
    if (ok && n >= Math.min(2, nb.length)) return prev.slice(0, pa[i][1]).concat(next);
  }
  return next;
}

/* ---------------- perapi teks ---------------- */
// Gaya render yang terbaca dari fixture (Claude Code 2.1.326 / Codex 0.167, tema gelap):
//   judul      Claude: "# " = tebal+miring+garis bawah, "##"/"###"/… = tebal saja (tidak bisa dibedakan), baris sendiri
//              diikuti baris kosong. Codex: "## …" ditulis apa adanya (tebal + warna).
//   kode       Claude: kode inline dan blok kode tanpa bahasa = satu warna (5;153); blok berbahasa = warna sintaks.
//              Codex: kode inline hijau (2;166;227;161); blok berbahasa = warna sintaks; blok tanpa bahasa POLOS tanpa
//              warna, hanya terlihat dari baris yang dipatahkan sendiri.
//   tautan     keduanya OSC 8 (Claude 94, Codex garis bawah biru); Codex menulis "teks (url)".
//   kutipan    Claude "▎ " redup + miring; Codex "> " berwarna. Tebal Codex = tebal + warna, miring = miring + warna.
const BOX = /^[│┌└├┬┴┼─━╭╮╯╰║╔╗╚╝═╠╣╦╩╬┐┘┤]/;
const LIST = /^(?:([-*•◦▪‣⁃])|(\d+[.)])|([☐☒✔✓◻◼□■]))\s+/;
const QUOTE = /^(?:▎|>)(?:\s+|$)/;
const HEAD = /^#{1,6}\s/;
const ink = c => c.ch !== ' ';
const special = l => { const t = l.t.trimStart(); return LIST.test(t) || HEAD.test(t) || QUOTE.test(t) || BOX.test(t); };
/** Kalimat yang selesai: baris prosa terakhir sebelum paragraf baru, bukan baris kode. */
const sentenceEnd = t => /[.!?…]["'”’)\]]*$/.test(t) || (/:$/.test(t) && t.trim().split(/\s+/).length >= 4);
/** Warna sel sebagai kode inline: berwarna, bukan tebal/redup/miring/garis bawah/tautan (Claude: biru 94/34 = tautan). */
const codeCell = (c, engine, qfg) => !!c.fg && !c.b && !c.dim && !c.it && !c.ul && !c.link && c.fg !== qfg &&
  !(engine === 'claude' && (c.fg === '94' || c.fg === '34'));
/** Jumlah warna berbeda di baris: blok kode berwarna sintaks memakai beberapa warna, kode inline hanya satu. */
function colors(l) {
  const s = new Set();
  for (const c of l.cells) if (ink(c) && c.fg && !c.b && !c.dim && !c.it && !c.ul && !c.link) s.add(c.fg);
  return s.size;
}
/** Warna tunggal seluruh huruf di baris (bukan tebal/tautan/kutipan), atau null. */
function monoColor(l) {
  if (QUOTE.test(l.t.trimStart())) return null;
  const xs = l.cells.filter(ink);
  const f = xs[0]?.fg;
  return f && xs.every(c => c.fg === f && !c.b && !c.dim && !c.it && !c.ul && !c.link) ? f : null;
}
function codeRun(run, width) {
  const body = run.filter(l => !blank(l));
  if (!body.length) return false;
  if (body.some(l => BOX.test(l.t.trimStart()))) return true;
  // blok kode tanpa warna sintaks Claude Code: semua baris satu warna (warna kode inline), juga bila hanya satu baris
  const mono = body.map(monoColor);
  if (mono[0] && mono.every(f => f === mono[0])) return true;
  if (body.some(special)) return false;
  const codeish = body.filter(l => { const f = firstCell(l); return colors(l) >= 2 || (f && f.fg && !f.b && !f.link && !f.it && !f.ul); }).length;
  if (body.length === 1) return colors(body[0]) >= 2;
  if (codeish / body.length < 0.4) return false;
  // prosa yang dibungkus terminal: semua baris kecuali terakhir hampir selebar layar
  const wrapped = body.slice(0, -1).every(l => l.t.trimEnd().length >= width - 16);
  return !wrapped;
}

/**
 * Codex menampilkan blok kode tanpa bahasa sebagai teks polos, dan selama menulis paragraf sesudahnya menempel tanpa
 * baris kosong. Baris kode dikenali dari patahan keras: kata pertama baris berikutnya masih muat di baris ini (jadi
 * bukan bungkus terminal; `width` = baris terpanjang ≤ lebar bungkus sebenarnya) dan baris tidak berakhir seperti
 * kalimat. Minimal dua baris berurutan. → [{ code, lines }]
 */
function codexSplit(run, width) {
  const n = run.length, txt = run.map(l => l.t.trimEnd()), sp = run.map(special);
  const hard = txt.map((t, i) => {
    if (i === n - 1 || sp[i] || sp[i + 1] || sentenceEnd(t) || /\p{L}-$/u.test(t)) return false;
    return t.length + 1 + run[i + 1].t.trimStart().split(' ')[0].length <= width;
  });
  const segs = [];
  const prose = l => { const last = segs[segs.length - 1]; if (last && !last.code) last.lines.push(l); else segs.push({ code: false, lines: [l] }); };
  for (let i = 0; i < n;) {
    let j = i;
    while (hard[j]) j++;
    let end = j;
    if (j > i) {
      // baris terakhir rangkaian: prosa bila sesudahnya bungkus terminal / kalimat baru, atau (baris terakhir layar,
      // masih ditulis) panjang seperti kalimat
      const t = txt[j], words = t.trim().split(/\s+/).length;
      if (j < n - 1 ? !sp[j + 1] : (words >= 8 || t.length >= width * 0.7)) end = j - 1;
    }
    if (end > i) { segs.push({ code: true, lines: run.slice(i, end + 1) }); i = end + 1; } else { prose(run[i]); i++; }
  }
  return segs;
}

/** Judul Claude Code: satu-dua baris sendiri yang seluruhnya tebal, tanpa tanda baca akhir kalimat. → "# …"/"## …" atau null. */
function claudeHeading(run) {
  if (run.length > 2 || run.some(special)) return null;
  const xs = run.flatMap(l => l.cells.filter(ink));
  if (!xs.length || !xs.every(c => c.b && !c.link)) return null;
  const t = run.map(l => l.t.trim()).join(' ');
  if (t.length > 90 || /[.!?,;:…]$/.test(t) || !/\p{L}/u.test(t)) return null;
  return (xs.every(c => c.it && c.ul) ? '# ' : '## ') + t;
}

/**
 * Satu baris → markdown: tebal **…**, miring *…*, kode inline `…` (rentang sel berwarna kode), tautan [teks](url).
 * → { s, a, z, quote }: a/z = jenis rentang di awal/akhir baris (untuk menyambung kode/tautan yang dibungkus terminal).
 */
function mdLine(l, from, engine) {
  let cells = l.cells.slice(from);
  const plain = cells.map(c => c.ch).join('');
  if (HEAD.test(plain)) return { s: plain.trimEnd() }; // Codex menulis judul ## apa adanya
  let pre = '', qfg;
  const q = QUOTE.exec(plain);
  if (q) { pre = '> '; qfg = cells[0].fg; cells = cells.slice(q[0].length); }
  else { const m = LIST.exec(plain); if (m) { pre = plain.slice(0, m[0].length); cells = cells.slice(m[0].length); } }
  const own = c => c.link ? 'L' + c.link : c.b ? 'b' : c.it && !q ? 'i' : codeCell(c, engine, qfg) ? 'c' + c.fg : '';
  const kinds = cells.map(own);
  // spasi tanpa gaya di antara dua kata bergaya sama ikut gaya itu (Claude tidak menebalkan spasi antarkata)
  for (let i = 0; i < cells.length; i++) {
    if (ink(cells[i]) || /^[Lc]/.test(kinds[i])) continue;
    let a = i - 1, b = i + 1;
    while (a >= 0 && !ink(cells[a])) a--;
    while (b < cells.length && !ink(cells[b])) b++;
    kinds[i] = a >= 0 && b < cells.length && kinds[a] === kinds[b] && /^[bi]$/.test(kinds[a]) ? kinds[a] : '';
  }
  let out = '', first, last;
  for (let i = 0; i < cells.length;) {
    let j = i;
    while (j < cells.length && kinds[j] === kinds[i]) j++;
    const k = kinds[i], raw = cells.slice(i, j).map(c => c.ch).join('');
    i = j;
    if (!k) { out += raw; if (raw.trim()) last = ''; continue; }
    const body = raw.trim(), lw = raw.slice(0, raw.length - raw.trimStart().length), tw = raw.slice(raw.trimEnd().length);
    let s;
    if (k === 'b') s = /[\p{L}\p{N}]/u.test(body) ? `**${body}**` : body;
    else if (k === 'i') s = /[\p{L}\p{N}]/u.test(body) ? `*${body}*` : body;
    else if (k[0] === 'c') s = body.includes('`') ? `\`\` ${body} \`\`` : `\`${body}\``;
    else s = `[${body}](${k.slice(1)})`; // teks = URL → URL polos (di prose, sesudah potongan yang dibungkus disambung)
    if (first === undefined && !out.trim()) first = k;
    out += lw + s + tw; last = k;
  }
  return { s: (pre + out).trimEnd(), a: first || '', z: last || '', quote: !!q };
}

/** Rapikan satu paragraf/daftar (baris tanpa baris kosong di antaranya). */
function prose(r, base, engine) {
  const out = [];
  let cur = null; // { indent, cont, text, item, heading, quote, z }
  for (const l of r) {
    const rel = Math.max(0, lead(l) - base);
    const m = mdLine(l, lead(l), engine);
    const text = m.s, li = !m.quote && LIST.exec(text);
    if (li) {
      const marker = li[2] || (li[3] ? li[3] : '-');
      cur = { indent: rel, cont: rel + li[0].length, text: `${' '.repeat(rel)}${marker} ${text.slice(li[0].length)}`, item: true, z: m.z };
      out.push(cur); continue;
    }
    const heading = HEAD.test(text);
    const body = m.quote ? text.replace(/^> /, '') : text;
    const joins = cur && !cur.heading && !heading && (m.quote ? cur.quote : !cur.quote &&
      (cur.item ? rel >= cur.cont - 1 : rel === cur.indent));
    if (joins) {
      const a = cur.text, url = cur.z[0] === 'L' ? cur.z.slice(1) : null;
      if (cur.z && cur.z === m.a && cur.z[0] === 'c' && a.endsWith('`') && body.startsWith('`')) cur.text = a.slice(0, -1) + ' ' + body.slice(1);
      else if (url && cur.z === m.a && a.endsWith(`](${url})`) && body.startsWith('[')) cur.text = a.slice(0, -(url.length + 3)) + ' ' + body.slice(1);
      else cur.text += /\p{L}-$/u.test(a) ? body : ' ' + body;
      cur.z = m.z;
      continue;
    }
    cur = { indent: rel, text: (cur?.item && rel > 0 ? ' '.repeat(rel) : '') + text, heading, quote: m.quote, z: m.z };
    out.push(cur);
  }
  let s = out.map(x => x.text).join('\n').replace(/\*\* \*\*/g, ' ').replace(/\*\* (`[^`\n]+`) \*\*/g, ' $1 ')
    // tautan yang teksnya URL itu sendiri (juga yang dibungkus terminal jadi dua potong): URL polos
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, t, u) => t.replace(/\s+/g, '') === u ? u : all);
  // Codex menulis tautan [teks](url) sebagai "teks (url)"
  if (engine === 'codex') s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\) \(\2\)/g, '[$1]($2)');
  return s;
}

/**
 * Baris jawaban (sudah tanpa "⏺ "/"• ") → teks markdown sederhana: paragraf yang dibungkus terminal disambung,
 * daftar dan kutipan dipertahankan, judul Claude jadi #/##, tabel kotak dan blok kode di dalam ```, tebal **…**,
 * miring *…*, kode inline `…`, tautan [teks](url).
 */
export function formatLines(lines, engine = 'claude') {
  const ls = trimBlank(lines);
  if (!ls.length) return '';
  const base = Math.min(...ls.filter(l => !blank(l)).map(lead));
  const width = Math.max(...ls.map(l => l.t.trimEnd().length));
  // kelompok baris di antara baris kosong
  const runs = [];
  let run = [];
  for (const l of ls) { if (blank(l)) { if (run.length) runs.push(run); run = []; } else run.push(l); }
  if (run.length) runs.push(run);
  const parts = []; // { code, box, runs } | { text }
  const code = (r, box = false) => {
    const prev = parts[parts.length - 1];
    if (prev?.code && !prev.box && !box) prev.runs.push(r); // blok kode yang memuat baris kosong
    else parts.push({ code: true, box, runs: [r] });
  };
  for (const r0 of runs) {
    // tabel yang langsung diikuti teks tanpa baris kosong (Codex selama menulis): baris sesudah garis tabel terakhir
    // ikut tabel hanya bila lebih menjorok (sel Codex diawali spasi), sisanya diproses sendiri
    let r = r0;
    const lastBox = r.findLastIndex(l => BOX.test(l.t.trimStart()));
    if (lastBox >= 0) {
      let k = lastBox + 1;
      while (k < r.length && lead(r[k]) > lead(r[lastBox]) && !special(r[k])) k++;
      if (k < r.length) { runs.splice(runs.indexOf(r0) + 1, 0, r.slice(k)); r = r.slice(0, k); }
    }
    const prev = parts[parts.length - 1];
    if (codeRun(r, width)) { code(r, r.some(l => BOX.test(l.t.trimStart()))); continue; }
    const h = engine === 'claude' ? claudeHeading(r) : null;
    if (h) { parts.push({ text: h }); continue; }
    if (engine === 'codex') {
      // satu baris pendek tanpa akhir kalimat tepat sesudah blok kode: lanjutan blok itu (sesudah baris kosongnya)
      const t = r[0].t.trim();
      if (r.length === 1 && prev?.code && !prev.box && !special(r[0]) && !sentenceEnd(t) && t.split(/\s+/).length <= 6 &&
        t.length < width * 0.6 && !r[0].cells.some(c => c.b || c.link)) { code(r); continue; }
      for (const sg of codexSplit(r, width)) sg.code ? code(sg.lines) : parts.push({ text: prose(sg.lines, base, engine) });
      continue;
    }
    parts.push({ text: prose(r, base, engine) });
  }
  return parts.map(p => {
    if (!p.code) return p.text;
    const ind = Math.min(...p.runs.flat().map(lead));
    return '```\n' + p.runs.map(r => r.map(l => l.t.slice(ind).trimEnd()).join('\n')).join('\n\n') + '\n```';
  }).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Codex menampilkan markdown mentah selama penandanya belum tertutup ("**Saat", "`config.y"). Di baris terakhir teks
 * sementara: penanda yang belum berpasangan ditutup sementara di ujung baris (atau dibuang bila belum ada isinya), blok
 * ``` yang terbuka ditutup. Teks yang semua penandanya berpasangan tidak berubah.
 */
export function closeTail(text) {
  if (!text) return text;
  if (((text.match(/^```/gm) || []).length) % 2) return text + '\n```';
  const nl = text.lastIndexOf('\n');
  let line = text.slice(nl + 1);
  if (/^```/.test(line)) return text;
  const fix = (s, i, mk) => {
    const rest = s.slice(i + mk.length);
    return /[\p{L}\p{N}]/u.test(rest) ? s.trimEnd() + mk : (s.slice(0, i) + rest).trimEnd();
  };
  // kode inline: penanda terbuka selalu yang terakhir (sesudahnya Codex belum merender apa pun)
  if (((line.match(/`/g) || []).length) % 2) line = fix(line, line.lastIndexOf('`'), '`');
  const spans = [];
  let s = line.replace(/`[^`]*`/g, m => `\u0000${spans.push(m) - 1}\u0000`);
  for (const mk of ['**', '__']) {
    const re = mk === '**' ? /\*\*/g : /(?<![\p{L}\p{N}])__|__(?![\p{L}\p{N}])/gu;
    const at = [...s.matchAll(re)].map(m => m.index);
    if (at.length % 2) s = fix(s, at[at.length - 1], mk);
  }
  // miring tunggal: *kata / _kata di awal kata tanpa pasangan sesudahnya
  for (const [mk, re] of [['*', /(?<![*\p{L}\p{N}])\*(?=[^\s*])/gu], ['_', /(?<![_\p{L}\p{N}])_(?=\p{L})/gu]]) {
    const at = [...s.matchAll(re)].map(m => m.index);
    const i = at[at.length - 1];
    if (i == null) continue;
    const after = s.slice(i + 1);
    const closed = mk === '*' ? /[^\s*]\*(?!\*)/.test(after) : /\p{L}_(?![\p{L}\p{N}])/u.test(after);
    if (!closed) s = fix(s, i, mk);
  }
  line = s.replace(/\u0000(\d+)\u0000/g, (_, k) => spans[+k]);
  return text.slice(0, nl + 1) + line;
}

/** Ekor maks MAX_TEXT karakter, dipotong di awal baris. */
export function tailText(text, max = MAX_TEXT) {
  if (text.length <= max) return text;
  const t = text.slice(-max);
  const nl = t.indexOf('\n');
  return '…' + (nl >= 0 && nl < 400 ? t.slice(nl) : t);
}

/**
 * Layar → { text, lines, head, partial } atau null bila agen tidak sedang menulis teks (alat, dialog, tidak ada jawaban).
 * prev: baris yang terkumpul dari layar sebelumnya (untuk Codex yang bergulir), prevPartial: partial bacaan itu.
 * partial = awal jawaban tidak terlihat (sudah tergulir sebelum chat dibuka), jadi `text` hanya ekornya.
 */
export function extractStream(screen, engine = 'claude', prev = null, prevPartial = false) {
  const lines = parseAnsi(screen);
  const blk = engine === 'codex' ? codexBlock(lines) : claudeBlock(lines);
  if (!blk || !blk.lines.length) return null;
  const all = stitch(prev, blk.lines, blk.head);
  const joined = all !== blk.lines;
  let text = formatLines(all, engine);
  if (engine === 'codex') text = closeTail(text);
  text = tailText(text);
  const partial = blk.head ? false : joined ? !!prevPartial : true;
  return text ? { text, lines: all, head: blk.head || joined, partial } : null;
}

/* ---------------- pembanding dengan transkrip ---------------- */
export const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** Teks pesan asisten terakhir sesudah pesan pengguna terakhir (items readTranscript), atau null. */
export function lastAssistantText(items) {
  for (let i = (items?.length || 0) - 1; i >= 0; i--) {
    const it = items[i];
    if (it.k === 'user') return null;
    if (it.k === 'text') return it.s;
  }
  return null;
}
/** Teks layar sudah sama dengan pesan asisten di transkrip (teks layar boleh hanya ekor, transkrip boleh terpotong "…"). */
export function sameAsTranscript(text, last) {
  if (!text || !last) return false;
  const clipped = /…$/.test(last);
  // layar tidak menampilkan nama bahasa blok kode (```python)
  const a = norm(String(text).replace(/^…/, '')), b = norm((clipped ? last.slice(0, -1) : last).replace(/```[\w+.-]+/g, '```'));
  if (!a || !b) return false;
  if (a === b || (a.length >= 24 && b.includes(a))) return true; // teks pendek: hanya bila persis sama
  // sel tabel yang dibungkus di layar mengubah urutan kata: isi yang sama persis tapi urutannya lain tetap sama
  if (a.length === b.length && a.length >= 24 && [...a].sort().join('') === [...b].sort().join('')) return true;
  if (!clipped && a.includes(b) && b.length >= a.length * 0.9) return true; // sisa spinner/tanda kecil di layar
  return clipped && a.startsWith(b.slice(0, Math.min(b.length, 400)));
}
/** Tanda awal teks: membedakan jawaban yang sudah selesai dari jawaban baru. */
export const signature = text => norm(String(text).replace(/^…/, '')).slice(0, 120);
