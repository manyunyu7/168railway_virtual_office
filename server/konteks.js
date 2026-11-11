// "Agen ini lagi ngerjain apa, dan gimana?": ringkasan satu sesi dari transcript-nya, tanpa LLM dan tanpa biaya token.
import fs from 'node:fs';
import path from 'node:path';
import { globalDb, officeDb, one, run, nowIso } from './db.js';
import { scanAppended } from './jsonl.js';
import { readTranscript, unpaste } from './transcript.js';

const FIRST_SCAN_MAX = 32 << 20; // transcript raksasa cukup dibaca 32 MB terakhir pada scan pertama
const MARKS = ['"ai-title"', '"custom-title"', '"queue-operation"', '"role":"assistant"', '"role":"user","content":"', '"role":"user","content":[{"type":"text"', '"role":"user","content":[{"type":"image"', '[Request interrupted'];
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TRIVIAL = /^(lanjut(kan)?|terus|ya|iya|yes|y|ok|oke|okay|gas|sip|mantap|next|continue|go|makasih|thanks|thx|tes|test|gimana|udah|sudah|terus gimana|gimana hasilnya)[\s.!?]*$/i;
const states = new Map();

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';

/** Markdown jadi kalimat polos; blok kode dibuang karena tidak terbaca di satu baris. */
export function plain(md) {
  return String(md ?? '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`([^`]*)`/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/gm, '').replace(/(\*\*|__|\*)/g, '').replace(/^\s*\|.*\|\s*$/gm, ' ');
}

/** Pertanyaan yang menutup sebuah balasan: tandanya agen menunggu jawaban pemilik. */
export function closingQuestion(text) {
  const last = plain(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).pop() || '';
  if (!/\?["')\]]*$/.test(last)) return null;
  return clip(last.split(/(?<=[.!?])\s+/).pop(), 200);
}

/** Satu prompt jadi permintaan bermakna, atau null kalau bukan perintah (kosong, slash command, "lanjut", pesan sistem kantor). */
export function askOf(raw, at) {
  const t = unpaste(raw).trim();
  if (!t || /^</.test(t) || /^\//.test(t) || /^\[Kantor\b/.test(t) || /^\[Image\b/.test(t) || /^\[Request interrupted/.test(t) || /^This session is being continued/.test(t) || t.length < 4 || TRIVIAL.test(t)) return null;
  const dm = /^\[Pesan dari ([^·\]]+?)\s*·[^\]]*\]\s*([\s\S]*)$/.exec(t);
  if (dm) return { s: clip(`${dm[1]}: ${dm[2].replace(/\s*Balas dengan tool kantor[\s\S]*$/, '')}`, 280), at: at || null, from: 'agen' };
  return { s: clip(t, 280), at: at || null, from: 'kamu' };
}

function fresh() { return { draft: null, ai: null, custom: null, ask: null, reply: null, stop: false, err: null, files: [], fileN: 0, branch: null }; }

/** Satu kata pendek ("lnjurknb", "deploy") tidak menggeser permintaan yang sudah menjelaskan pekerjaannya. */
function setAsk(c, ask) {
  if (c.ask && ask.s.length < 12 && !/\s/.test(ask.s)) return;
  c.ask = ask; c.files = []; c.fileN = 0;
}
function touchFile(c, file) {
  if (!file) return;
  const name = path.basename(String(file));
  c.files = [name, ...c.files.filter(x => x !== name)].slice(0, 6);
  c.fileN++;
}

/** Balasan sekata ("menunggu") tidak menimpa laporan terakhir yang lebih berguna. */
function keepReply(c, text, at) {
  const s = clip(plain(text), 280), q = closingQuestion(text);
  if (s && (q || s.length >= 12 || !c.reply)) c.reply = { s, q, at: at || null };
}

function eat(c, d) {
  if (d.type === 'ai-title') { c.ai = d.aiTitle || c.ai; return; }
  if (d.type === 'custom-title') { c.custom = d.customTitle || c.custom; return; }
  // pesan yang dikirim saat agen sedang bekerja masuk antrean dulu, bukan record user biasa
  if (d.type === 'queue-operation') { if (d.operation === 'enqueue') { const ask = askOf(d.content, d.timestamp); if (ask) setAsk(c, ask); } return; }
  if (d.isSidechain) return;
  if (d.gitBranch) c.branch = d.gitBranch;
  const content = d.message?.content;
  if (d.type === 'user') {
    if (d.isCompactSummary) return;
    const text = textOf(content);
    if (/^\s*\[Request interrupted/.test(text)) { c.stop = true; return; }
    if (d.isMeta) return;
    const ask = askOf(text, d.timestamp);
    if (text.trim() && !/^\s*</.test(text)) { c.stop = false; c.err = null; }
    if (ask) setAsk(c, ask);
  } else if (d.type === 'assistant') {
    if (d.isApiErrorMessage) { c.err = clip(textOf(content) || 'Permintaan ke model gagal', 200); return; }
    if (d.message?.model === '<synthetic>') return;
    c.stop = false; c.err = null;
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && b.text?.trim()) {
        keepReply(c, b.text, d.timestamp);
      }
      if (b?.type === 'tool_use' && b.name === 'SendFeedback') c.draft = { title: clip(b.input?.title, 200), details: String(b.input?.details || '').slice(0, 4000), at: d.timestamp || null };
      if (b?.type === 'tool_use' && EDITS.has(b.name)) touchFile(c, b.input?.file_path || b.input?.notebook_path);
    }
  }
}

function scanClaude(file) {
  let c = states.get(file);
  if (!c) {
    const st = fs.statSync(file);
    c = { ...fresh(), ino: st.ino, offset: Math.max(0, st.size - FIRST_SCAN_MAX) };
  }
  // yang baru dipakai pindah ke ujung, supaya yang terbuang adalah yang paling lama diam
  states.delete(file); states.set(file, c);
  if (states.size > 200) states.delete(states.keys().next().value);
  scanAppended(file, c, MARKS, d => eat(c, d), () => Object.assign(c, fresh()));
  return c;
}

/** Codex dan Gemini: item percakapan yang sama dengan tab Chat. */
function fromItems(file) {
  const c = fresh();
  for (const it of readTranscript(file, 2000).items || []) {
    if (it.k === 'user') { const ask = askOf(it.s, it.at); if (ask) setAsk(c, ask); }
    else if (it.k === 'text') keepReply(c, it.s, it.at);
    else if (it.k === 'tool' && EDITS.has(it.name)) touchFile(c, String(it.s || '').replace(/^\S+\s*/, ''));
  }
  return c;
}

function activeCard(s) {
  if (!s.office || !s.role) return null;
  try {
    const c = one(officeDb(s.office), "SELECT id, title FROM cards WHERE who = ? AND kind = 'dikerjakan' AND archived = 0 ORDER BY updated_at DESC LIMIT 1", s.role);
    return c ? { id: c.id, title: clip(c.title, 120) } : null;
  } catch { return null; }
}

/* ---------------- laporan agen sendiri (tool kerjaan_set) ---------------- */
const kerjaanKey = sid => `kerjaan.${sid}`;
function kerjaanOf(s) {
  if (s.kerjaan !== undefined) return s.kerjaan;
  try { s.kerjaan = JSON.parse(one(globalDb(), 'SELECT value FROM kv WHERE key = ?', kerjaanKey(s.sid))?.value || 'null'); } catch { s.kerjaan = null; }
  return s.kerjaan;
}
/** Simpan laporan agen. `langkah`/`persen` saja memperbarui judul yang sudah ada; `selesai` menghapus laporannya. */
export function setKerjaan(s, { judul, langkah, persen, selesai } = {}) {
  const key = kerjaanKey(s.sid);
  if (selesai) { s.kerjaan = null; run(globalDb(), 'DELETE FROM kv WHERE key = ?', key); return null; }
  const prev = kerjaanOf(s), title = clip(judul, 120) || prev?.judul;
  if (!title) throw new Error('Isi `judul` (apa yang sedang kamu kerjakan, satu kalimat pendek); tadi kosong.');
  const pct = Number(persen);
  const next = { judul: title, langkah: clip(langkah, 200) || null, persen: persen != null && persen !== '' && pct >= 0 && pct <= 100 ? Math.round(pct) : null, at: nowIso() };
  s.kerjaan = next;
  run(globalDb(), 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(next));
  return next;
}

/** Keadaan sesi dalam bahasa pemilik. `k`: izin|tanya|jalan|tunggu|gagal|henti|selesai|kosong|tutup */
export function stateOf(s, c) {
  if (s.status === 'ended') return { k: 'tutup', label: 'Sesi ditutup' };
  if (s.waiting || s.status === 'waiting') return s.waiting?.tool === 'AskUserQuestion' ? { k: 'tanya', label: 'Nunggu jawabanmu' } : { k: 'izin', label: 'Nunggu izinmu' };
  if (s.compacting) return { k: 'jalan', label: 'Merapikan konteks' };
  if (s.status === 'working') return { k: 'jalan', label: 'Lagi jalan' };
  if (s.status === 'starting') return { k: 'jalan', label: 'Baru mulai' };
  if ((s.subs instanceof Map ? [...s.subs.values()] : s.subs || []).some(x => x.status !== 'done')) return { k: 'jalan', label: 'Subagent masih jalan' };
  if (s.tunggu) return { k: 'tunggu', label: s.tunggu.label || 'Menunggu kejadian' };
  if (c?.err) return { k: 'gagal', label: 'Berhenti karena galat' };
  if (c?.stop) return { k: 'henti', label: 'Dihentikan' };
  if (c?.reply?.q) return { k: 'tanya', label: 'Nunggu jawabanmu' };
  if (c?.reply) return { k: 'selesai', label: 'Selesai, nunggu arahan' };
  return { k: 'kosong', label: 'Belum ada obrolan' };
}

/** {topic, kerjaan:{judul,langkah,persen,at}, ask:{s,at,from}, reply:{s,q,at}, err, files:{names,n}, card:{id,title}, branch, state:{k,label}}; bagian yang belum diketahui bernilai null. */
export function sessionKonteks(s) {
  let c = null;
  if (s.transcript) {
    try { c = (s.engine || 'claude') === 'claude' ? scanClaude(s.transcript) : fromItems(s.transcript); } catch { c = null; }
  }
  const card = activeCard(s);
  // judul bawaan shift ("Zora · 168Railway") hanya mengulang nama role, bukan pekerjaannya
  const real = t => t && t !== 'Sesi belum terhubung' && !(s.role && / · /.test(t)) ? t : null;
  // laporan agen kalah oleh permintaan yang datang sesudahnya: mungkin sudah tidak berlaku
  const lapor = kerjaanOf(s), kerjaan = lapor && !(Date.parse(c?.ask?.at || 0) > Date.parse(lapor.at)) ? lapor : null;
  const topic = kerjaan?.judul || real(c?.custom) || c?.ai || card?.title || real(s.title) || c?.ask?.s || null;
  return {
    topic: topic ? clip(topic, 120) : null, kerjaan,
    ask: c?.ask || null, reply: c?.reply || null, err: c?.err || null,
    files: c?.fileN ? { names: c.files, n: c.fileN } : null,
    // draf laporan ke Anthropic yang sedang menunggu keputusan di terminal; judulnya dari layar, isinya dari transcript
    draft: s.draftState && (s.draftState.siap || c?.draft?.title) ? { title: s.draftState.title || c?.draft?.title || 'Draf laporan', siap: s.draftState.siap, details: c?.draft?.details || null, at: c?.draft?.at || null } : null,
    card, branch: c?.branch && !['main', 'master', 'HEAD'].includes(c.branch) ? c.branch : null,
    state: stateOf(s, c),
  };
}
