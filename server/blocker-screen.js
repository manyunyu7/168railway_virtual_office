// Layar yang menahan agen di tmux (login Codex/Claude, percayai folder, "Press enter to continue"): dibaca dari
// capture-pane lalu dijadikan `blocker` untuk kartu di app HP. Modul ini murni (tanpa tmux/ssh/db): pembaca layar,
// validasi callback login, dan pemetaan aksi → tombol tmux dengan fungsi yang disuntikkan. Kabelnya ada di blocker.js.

/** Aksi yang boleh dikirim app (POST /api/sessions/:sid/blocker). Selain ini ditolak. */
export const ACTIONS = ['device', 'browser', 'enter', 'esc', 'yes', 'no', 'code', 'callback'];

const TAIL = 26; // dialog login mengisi dasar layar; teks di atasnya (banner, percakapan lama) diabaikan
const nonEmpty = text => String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
// kotak input biasa terlihat di dasar layar: agen tidak tertahan dialog (teks "Press enter" di percakapan tidak dihitung)
const NORMAL_FOOTER = /\? for shortcuts|esc to interrupt|shift\+tab to cycle|for agents ·|f2 to view|context left|bypass permissions on|auto mode on|accept edits on|plan mode on/i;
/** Kotak input Claude (❯ di antara garis ─) atau Codex (›) di dasar layar, bukan baris pilihan "❯ 1. …". */
function normalScreen(all) {
  if (NORMAL_FOOTER.test(all.slice(-4).join('\n'))) return true;
  const low = all.slice(-8);
  if (low.some(l => /^\s*─{20,}\s*$/.test(l)) && low.some(l => /^\s*❯(?!\s*(?:[✔✓]\s*)?\d+\.)/.test(l))) return true;
  return all.slice(-6).some(l => /^\s*›(?!\s*\d+\.)/.test(l));
}

/** Baris pilihan bernomor: "> 1. Sign in with ChatGPT", "❯ 1. Claude account · …", "  2. No, quit". */
const ROW = /^\s*([›>❯▶])?\s*(?:[✔✓]\s*)?(\d+)\.\s+(.+?)\s*$/;
export function parseRows(text, anchorRe = null) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let at = -1;
  // judul dialog terakhir di layar (baris pilihan yang kebetulan cocok, mis. "1. Yes, allow Codex to work in this folder", bukan judul)
  if (anchorRe) { lines.forEach((l, i) => { if (anchorRe.test(l) && !ROW.test(l)) at = i; }); if (at < 0) return []; }
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    const m = ROW.exec(l);
    if (!m) continue;
    rows.push({ index: +m[2], label: m[3].split(/\s+·\s+|\s{2,}/)[0].trim(), cursor: !!m[1] });
  }
  // nomor yang berulang berarti daftar lain di bawahnya (mis. langkah 1./2. layar kode): ambil daftar pertama saja
  const out = [];
  for (const r of rows) { if (out.some(x => x.index === r.index)) break; out.push(r); }
  return out;
}

const URL_CHARS = /^[\w\-.~:/?#[\]@!$&'()*+,;=%]+$/;
/** URL yang terpotong ke beberapa baris oleh lebar terminal: baris berikutnya disambung selama tanpa spasi. */
export function joinedUrl(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let url = lines[i].slice(m.index).trim();
    if (/\s/.test(url)) url = url.split(/\s/)[0];
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k].trim();
      if (!t || /\s/.test(t) || !URL_CHARS.test(t) || /^https?:\/\//.test(t)) break;
      url += t;
    }
    return url;
  }
  return null;
}
const urlOk = (u, hosts, pathRe) => { try { const x = new URL(u); return x.protocol === 'https:' && hosts.includes(x.hostname) && pathRe.test(x.pathname); } catch { return false; } };
const CLAUDE_HOSTS = ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'];

const A = (id, label, primary = false) => ({ id, label, primary });
const clip = (s, n = 200) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export const TRUST_RE = /Do you trust the (?:files|contents) (?:in|of) this (?:folder|directory)|Trust this folder|Is this a project you created or one you trust|allow Codex to work in this folder/i;
export const CODEX_MENU_RE = /Choose how you want to use Codex|Sign in with ChatGPT to use Codex/i;
export const CLAUDE_MENU_RE = /Select login method/i;

/**
 * Apa yang menahan pane ini, dari teks capture-pane (layar terlihat). null = layar normal.
 * opts: { engine: engine sesi, who: nama agen untuk judul, now: Date.now() untuk expiresAt }.
 * Hasilnya bentuk kontrak `blocker` tanpa `at` (diisi blocker.js saat pertama terlihat).
 */
export function parseBlocker(text, { engine = null, who = 'Agen', now = Date.now() } = {}) {
  const all = nonEmpty(text);
  if (!all.length) return null;
  const lines = all.slice(-TAIL);
  const tail = lines.join('\n');
  if (normalScreen(all)) return null;
  const base = { kind: 'login', engine: engine || null, method: null, title: '', detail: null, url: null, code: null, expiresAt: null, actions: [], input: null };

  // Codex: kode sekali pakai (layar ini juga berjudul "Finish signing in via your browser", jadi dicek lebih dulu)
  if (/Enter this one-time code/i.test(tail)) {
    const code = lines.map(l => /^\s*([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\s*$/.exec(l)?.[1]).find(Boolean) || null;
    const url = joinedUrl(lines, /https:\/\/auth\.openai\.com\/codex\/device\S*/);
    const mins = +(/expires in (\d+) minutes?/i.exec(tail)?.[1] || 15);
    return { ...base, engine: 'codex', method: 'device', title: `${who} perlu login ChatGPT`,
      detail: code ? `Buka tautan, login ke ChatGPT, lalu masukkan kode ini. Berlaku ${mins} menit.` : 'Codex sedang meminta kode login…',
      url: url && urlOk(url, ['auth.openai.com'], /^\/codex\/device/) ? url : null, code,
      expiresAt: code ? new Date(now + mins * 60e3).toISOString() : null, actions: [A('browser', 'Cara lain')] };
  }
  // Codex: login lewat browser (URL authorize terpotong ke beberapa baris)
  if (/Finish signing in via your browser/i.test(tail)) {
    const url = joinedUrl(lines, /https:\/\/auth\.openai\.com\/oauth\/authorize\S*/);
    return { ...base, engine: 'codex', method: 'browser', title: `${who} perlu login ChatGPT`,
      detail: 'Buka tautan lalu login. Setelah itu browser membuka alamat 127.0.0.1 yang gagal dimuat: salin alamat halaman itu dan tempel di sini.',
      url: url && urlOk(url, ['auth.openai.com'], /^\/oauth\/authorize$/) ? url : null,
      input: { id: 'callback', label: 'Tempel alamat halaman setelah login', placeholder: 'http://127.0.0.1:1455/auth/callback?code=…' },
      actions: [A('device', 'Pakai kode saja')] };
  }
  if (/Signed in with your ChatGPT account/i.test(tail)) {
    return { ...base, kind: 'prompt', engine: 'codex', title: `${who} sudah login ChatGPT`, detail: 'Tekan Lanjut supaya Codex mulai bekerja.', actions: [A('enter', 'Lanjut', true)] };
  }
  if (CODEX_MENU_RE.test(tail) || (/Sign in with ChatGPT/i.test(tail) && /Sign in with Device Code/i.test(tail))) {
    return { ...base, engine: 'codex', method: 'menu', title: `${who} perlu login ChatGPT`, detail: 'Codex belum login. Login dengan kode paling mudah dari HP.',
      actions: [A('device', 'Login dengan kode', true), A('browser', 'Login lewat browser')] };
  }
  if (/Paste or type your API key/i.test(tail)) {
    return { ...base, engine: 'codex', title: `${who} perlu login`, detail: 'Codex meminta API key. Kembali ke menu untuk login dengan ChatGPT.', actions: [A('esc', 'Kembali', true)] };
  }

  // Claude Code: /login
  if (/Paste code here if prompted/i.test(tail)) {
    const url = joinedUrl(lines, /https:\/\/[\w.-]+\/\S*oauth\/authorize\S*/);
    return { ...base, engine: 'claude', method: 'claude', title: `${who} perlu login Claude`,
      detail: 'Buka tautan lalu login. Halaman itu menampilkan kode: salin dan tempel di sini.',
      url: url && urlOk(url, CLAUDE_HOSTS, /oauth\/authorize$/) ? url : null,
      input: { id: 'code', label: 'Tempel kode dari halaman login', placeholder: 'Kode dari halaman Claude' } };
  }
  if (CLAUDE_MENU_RE.test(tail) && parseRows(tail, CLAUDE_MENU_RE).length) {
    return { ...base, engine: 'claude', method: 'menu', title: `${who} perlu login Claude`, detail: 'Claude Code belum login. Pilih login dengan akun langganan Claude.',
      actions: [A('enter', 'Login akun Claude', true)] };
  }

  // percayai folder (Claude Code, Codex)
  if (TRUST_RE.test(tail)) {
    const rows = parseRows(tail, TRUST_RE);
    if (rows.some(r => /^yes\b/i.test(r.label)) && rows.some(r => /^no\b/i.test(r.label))) {
      const folder = lines.map(l => /^\s*((?:~|\/)[^\s]*)\s*$/.exec(l)?.[1] || /You are (?:running|in) [\w ]*?((?:~|\/)\S+)/.exec(l)?.[1]).find(Boolean);
      return { ...base, kind: 'prompt', title: `${who} minta izin membuka folder`, detail: folder ? `Percayai file di ${folder}?` : 'Percayai file di folder kerja ini?',
        actions: [A('yes', 'Ya, percaya', true), A('no', 'Tidak')] };
    }
  }

  // layar lain yang hanya menunggu Enter (selesai login, catatan keamanan, dsb.)
  if (/press enter to continue|enter to continue/i.test(all.slice(-3).join('\n'))) {
    const head = lines.slice(-8, -1).filter(l => !/press enter|enter to continue/i.test(l) && !ROW.test(l)).slice(-2).join(' ');
    return { ...base, kind: 'prompt', title: `${who} menunggu Lanjut`, detail: clip(head) || null, actions: [A('enter', 'Lanjut', true)] };
  }
  return null;
}

/* ---------------- kapan layar perlu dibaca ---------------- */
export const QUIET_MS = 20000, NEW_MS = 120000;
/**
 * Perlu membaca layar sesi ini? stat = { size, mtimeMs } transkripnya (null bila belum ada).
 * Ya bila: blocker masih tampil, transkrip kosong/belum ada, sesi baru (< 2 menit), atau idle tanpa aktivitas > 20 detik.
 */
export function wantsScan(s, { now = Date.now(), stat = null } = {}) {
  if (!s?.tmux || s.status === 'ended' || s.waiting) return false; // izin alat (waiting) sudah punya kartunya sendiri
  if (s.blocker) return true;
  if (!stat || !stat.size) return true;
  if (now - (Date.parse(s.startedAt) || 0) < NEW_MS) return true;
  return (s.status === 'idle' || s.status === 'starting') && now - stat.mtimeMs > QUIET_MS;
}

/** Sama atau tidak (tanpa `at`, dan expiresAt boleh beda selama kodenya sama). */
export function sameBlocker(a, b) {
  if (!a || !b) return !a && !b;
  const k = x => JSON.stringify({ ...x, at: null, expiresAt: x.code ? null : x.expiresAt });
  return k(a) === k(b);
}

/* ---------------- callback login Codex (anti-SSRF) ---------------- */
const bad = (msg, code = 400) => Object.assign(new Error(msg), { code });
/**
 * Alamat yang ditempel pemilik setelah login lewat browser → URL yang boleh di-GET di mesin agen.
 * Hanya http://127.0.0.1|localhost:<port redirect_uri>/auth/callback?code=…&state=<state URL authorize di layar>.
 */
export function checkCallback(value, blocker) {
  if (blocker?.input?.id !== 'callback') throw bad('Layar agen tidak sedang menunggu alamat callback login.', 409);
  let auth;
  try { auth = new URL(blocker.url); } catch { throw bad('Tautan login di layar agen tidak terbaca utuh. Pilih "Pakai kode saja".', 409); }
  const state = auth.searchParams.get('state');
  if (!state) throw bad('Tautan login di layar agen tidak lengkap (state tidak ada). Pilih "Pakai kode saja".', 409);
  let redirect = null;
  try { redirect = new URL(auth.searchParams.get('redirect_uri') || ''); } catch {}
  const port = redirect?.port || '1455';
  const raw = String(value ?? '').replace(/\s+/g, '');
  if (!raw) throw bad('Tempel alamat halaman setelah login.');
  if (raw.length > 4096) throw bad('Alamat terlalu panjang.');
  let u;
  try { u = new URL(raw); } catch { throw bad('Itu bukan alamat yang valid. Salin seluruh alamat dari kolom alamat browser.'); }
  if (u.protocol !== 'http:') throw bad('Alamat harus diawali http://127.0.0.1 (halaman yang gagal dimuat setelah login).');
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw bad('Alamat harus ke 127.0.0.1 atau localhost.');
  if (u.username || u.password) throw bad('Alamat tidak boleh berisi nama pengguna atau sandi.');
  if (u.port !== port) throw bad(`Port alamat harus ${port}, sama dengan login di layar agen.`);
  if (u.pathname !== '/auth/callback') throw bad('Alamat harus berakhir di /auth/callback.');
  if (!u.searchParams.get('code')) throw bad('Alamat tidak berisi code. Salin alamat setelah login selesai.');
  if (!u.searchParams.get('state')) throw bad('Alamat tidak berisi state.');
  if (u.searchParams.get('state') !== state) throw bad('Alamat ini dari login lain (state berbeda). Buka lagi tautan login yang sekarang di layar.');
  return `http://${u.hostname}:${port}/auth/callback${u.search}`;
}

/** Kode Claude yang ditempel: karakter aman saja, supaya tidak ada tombol atau perintah yang ikut terketik. */
export function checkCode(value) {
  const v = String(value ?? '').trim();
  if (!v) throw bad('Tempel kode dari halaman login.');
  if (!/^[A-Za-z0-9][A-Za-z0-9#_\-.~+/=]{3,511}$/.test(v)) throw bad('Kode tidak valid. Salin kode persis dari halaman login.');
  return v;
}

/* ---------------- aksi → tombol tmux ---------------- */
/**
 * Pindahkan kursor ke baris `pick` (fungsi row → bool) di bawah `anchor`, cek di layar, lalu Enter.
 * io: { screen: () => Promise<text>, keys: (keys[]) => Promise, sleep: ms => Promise }
 */
export async function chooseRow(io, anchor, pick, what) {
  for (let i = 0; i < 4; i++) {
    const rows = parseRows(await io.screen(), anchor);
    const target = rows.find(pick), cur = rows.find(r => r.cursor);
    if (!target) throw bad(`Pilihan "${what}" tidak ada di layar agen.`, 409);
    if (!cur) throw bad('Kursor pilihan di layar agen tidak terbaca. Buka tab Terminal sesi ini.', 409);
    const at = rows.indexOf(cur), to = rows.indexOf(target);
    if (at === to) { await io.keys(['Enter']); return; }
    await io.keys(Array(Math.abs(to - at)).fill(to > at ? 'Down' : 'Up'));
    await io.sleep(300);
  }
  throw bad(`Kursor tidak mau pindah ke "${what}". Buka tab Terminal sesi ini.`, 409);
}

const isDevice = r => /device code/i.test(r.label);
const isChatGpt = r => /^sign in with chatgpt/i.test(r.label);

/**
 * Jalankan satu aksi untuk blocker yang sedang tampil. Aksi harus ada di `blocker` (tombol atau input-nya).
 * io: { screen, keys, literal: text => Promise, fetchAt: url => Promise<{status}>, sleep }
 * → { sent: [...] } plus { callback: {status} } untuk aksi callback.
 */
export async function runAction(blocker, action, value, io) {
  if (!ACTIONS.includes(action)) throw bad('Aksi tidak dikenal.');
  if (!blocker) throw bad('Layar agen sudah tidak menunggu apa pun.', 409);
  const offered = blocker.actions.some(a => a.id === action) || blocker.input?.id === action;
  if (!offered) throw bad('Aksi itu tidak tersedia di layar agen sekarang.', 409);
  const back = async () => { await io.keys(['Escape']); await io.sleep(800); };
  switch (action) {
    case 'device':
    case 'browser': {
      if (blocker.engine !== 'codex') throw bad('Pilihan login ini hanya untuk Codex.', 409);
      if (blocker.method !== 'menu') await back(); // dari layar browser/kode: Esc kembali ke menu
      await chooseRow(io, CODEX_MENU_RE, action === 'device' ? isDevice : isChatGpt, action === 'device' ? 'Sign in with Device Code' : 'Sign in with ChatGPT');
      return { sent: action };
    }
    case 'enter':
      if (blocker.engine === 'claude' && blocker.method === 'menu') { await chooseRow(io, CLAUDE_MENU_RE, r => /claude account|subscription/i.test(r.label), 'Claude account'); return { sent: action }; }
      await io.keys(['Enter']); return { sent: action };
    case 'esc': await io.keys(['Escape']); return { sent: action };
    case 'yes': case 'no':
      await chooseRow(io, TRUST_RE, r => new RegExp(`^${action}\\b`, 'i').test(r.label), action === 'yes' ? 'Yes' : 'No');
      return { sent: action };
    case 'code': {
      const code = checkCode(value);
      await io.literal(code);
      await io.sleep(300);
      await io.keys(['Enter']);
      return { sent: action };
    }
    case 'callback': {
      const url = checkCallback(value, blocker);
      const r = await io.fetchAt(url);
      return { sent: action, callback: r };
    }
  }
}
