/* Pemutar musik kantor. Radio kantor dibuat di browser dengan Web Audio (tanpa file, tanpa jaringan);
 * "Lagu & playlist" memutar file milik user lewat /api/music (library, playlist, unggah).
 *
 * API (semua dari `music`, juga export bernama):
 *   play(stationId?) pause() toggle() next() prev()   transport; play harus dari event klik, tidak pernah autoplay
 *   setVolume(0..1)  seek(detik)  setRepeat('off'|'all'|'one')  toggleRepeat()  setShuffle(bool)
 *   select(value)           'lofi'|'chip'|'hujan'|'fokus' (radio) atau 'lib:all' | 'lib:<playlistId>'
 *   playTrack(path, src?)   putar lagu dari library/playlist (src = 'all' | playlistId)
 *   refreshLibrary()  library()  -> { files, playlists, loaded }
 *   uploadFiles(FileList|File[]) createPlaylist(name, paths?) renamePlaylist(id, name) deletePlaylist(id)
 *   addToPlaylist(id, paths) setPlaylistItems(id, paths) removeFromPlaylist(id, path)
 *   state()  -> { playing, station, title, volume, error, source, repeat, shuffle, track, index, queue, time, duration, stations }
 *   on(fn)   langganan perubahan state (bukan tiap detik); onTime(fn(t, dur)) untuk seek bar
 *   mountPlayer(el)   pemutar ringkas (popover ~280px);  mountLibrary(el)   panel penuh: library, playlist, antrean, drop zone
 * Efek samping: document.body.dataset.music = 'on' | 'off', window event 'kantor-music' (detail = state), Media Session.
 */

export const STATIONS = [
  { id: 'lofi', name: 'Lo-fi Kantor', desc: 'Rhodes hangat, drum santai, kresek vinyl' },
  { id: 'chip', name: 'Chiptune 8-bit', desc: 'Arpeggio kotak dan bass segitiga' },
  { id: 'hujan', name: 'Hujan & Piano', desc: 'Hujan di jendela, piano jarang-jarang' },
  { id: 'fokus', name: 'Fokus', desc: 'Pad tenang dan noise cokelat' },
  { id: 'folder', name: 'Lagu & playlist', desc: 'File audio dari folder musik di Mac ini' },
];
const KEY = 'kc.music';
const LOOK = 1.5, TICK = 200; // lookahead (detik) dan interval scheduler (ms); lebar supaya tab di latar belakang tidak putus

/* ---------- state ---------- */
const S = { playing: false, station: 'lofi', volume: 0.6, title: '', error: '' };
const L = { files: null, lists: [], source: 'all', repeat: 'off', shuffle: false, base: [], order: [], pos: 0, audio: null, node: null, errors: 0, t: 0, d: 0, ready: false, start: null, loaded: false };
const timeSubs = new Set();
const subs = new Set();
try { const p = JSON.parse(localStorage.getItem(KEY) || '{}'); if (STATIONS.some(s => s.id === p.station)) S.station = p.station; if (p.volume >= 0 && p.volume <= 1) S.volume = p.volume; if (typeof p.source === 'string') L.source = p.source; if (['off', 'all', 'one'].includes(p.repeat)) L.repeat = p.repeat; L.shuffle = !!p.shuffle; } catch {}
const stationOf = id => STATIONS.find(s => s.id === id);
S.title = stationOf(S.station).name;
if (typeof document !== 'undefined' && document.body) document.body.dataset.music = 'off';

function emit() {
  document.body.dataset.music = S.playing ? 'on' : 'off';
  const st = state();
  window.dispatchEvent(new CustomEvent('kantor-music', { detail: st }));
  for (const f of subs) { try { f(st); } catch {} }
  mediaSession();
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify({ station: S.station, volume: S.volume, source: L.source, repeat: L.repeat, shuffle: L.shuffle })); } catch {} }
const curTrack = () => L.base[L.order[L.pos]] || null;
function upcoming(n = 8) {
  const out = [], len = L.order.length;
  for (let i = 1; i <= Math.min(n, len - 1 + (L.repeat === 'all' ? 1 : 0)); i++) { const p = L.pos + i; if (p >= len && L.repeat !== 'all') break; const t = L.base[L.order[p % len]]; if (t) out.push(t); }
  return out;
}
export function state() {
  const f = S.station === 'folder';
  return { playing: S.playing, station: S.station, title: S.title, volume: S.volume, error: S.error, source: L.source, repeat: L.repeat, shuffle: L.shuffle,
    track: f ? curTrack() : null, index: L.pos, queue: f ? upcoming() : [], time: L.t, duration: L.d, stations: STATIONS };
}
function mediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: S.title, artist: 'Kantor Claude', album: stationOf(S.station).name });
    navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
  } catch {}
}

/* ---------- audio graph ---------- */
let ctx, fader, volNode, rev, white, brown;
let cur = null; // { id, inst, bus, timer }
let gen = 0, offTimer = 0;

function rngOf(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const mtof = m => 440 * 2 ** ((m - 69) / 12);

// make a noise buffer loop without a click by crossfading its tail into its head
function loopable(data, fade) {
  const n = data.length - fade, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = i < fade ? data[i] * (i / fade) + data[n + i] * (1 - i / fade) : data[i];
  return out;
}
function makeBuffer(c, seconds, fill) {
  const fade = Math.floor(c.sampleRate * 0.15), len = Math.floor(c.sampleRate * seconds) + fade;
  const raw = new Float32Array(len); fill(raw);
  const out = loopable(raw, fade), b = c.createBuffer(1, out.length, c.sampleRate);
  b.copyToChannel(out, 0); return b;
}
function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  if ('mediaSession' in navigator) for (const [k, fn] of [['play', () => play()], ['pause', pause], ['nexttrack', next], ['previoustrack', prev], ['seekto', d => seek(d.seekTime)]]) { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 24; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.25;
  volNode = ctx.createGain(); volNode.gain.value = S.volume ** 2 * 0.9;
  fader = ctx.createGain(); fader.gain.value = 0;
  fader.connect(volNode); volNode.connect(comp); comp.connect(ctx.destination);
  // reverb: generated impulse, 2.8s of darkening stereo noise
  const len = Math.floor(ctx.sampleRate * 2.8), ir = ctx.createBuffer(2, len, ctx.sampleRate), r = rngOf(7);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); let lp = 0; for (let i = 0; i < len; i++) { lp += ((r() * 2 - 1) - lp) * (0.6 - 0.5 * i / len); d[i] = lp * (1 - i / len) ** 3 * 2.2; } }
  rev = ctx.createConvolver(); rev.buffer = ir; rev.connect(fader);
  const r2 = rngOf(11);
  white = makeBuffer(ctx, 2, d => { for (let i = 0; i < d.length; i++) d[i] = r2() * 2 - 1; });
  brown = makeBuffer(ctx, 8, d => { let x = 0; for (let i = 0; i < d.length; i++) { x = (x + 0.02 * (r2() * 2 - 1)) / 1.02; d[i] = x * 3.5; } });
}

const filt = (type, f, q = 0.7) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
const gainNode = v => { const g = ctx.createGain(); g.gain.value = v; return g; };

/** One enveloped voice: linear attack a, hold, then exponential-ish decay with time constant tau. */
function voice(out, { type = 'sine', f, t, a = 0.005, hold = 0, tau = 0.3, peak = 0.2, wave, detune = 0 }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  if (wave) o.setPeriodicWave(wave); else o.type = type;
  o.frequency.value = f; if (detune) o.detune.value = detune;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.setTargetAtTime(0, t + a + hold, tau);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + a + hold + tau * 7);
  o.onended = () => { o.disconnect(); g.disconnect(); };
  return g;
}
function noiseHit(out, { t, f, type = 'highpass', q = 0.7, tau = 0.05, peak = 0.1, buf }) {
  const s = ctx.createBufferSource(), fl = filt(type, f, q), g = ctx.createGain();
  s.buffer = buf || white;
  g.gain.setValueAtTime(peak, t); g.gain.setTargetAtTime(0, t + 0.002, tau);
  s.connect(fl); fl.connect(g); g.connect(out);
  s.start(t, Math.random() * 1.5); s.stop(t + tau * 7 + 0.05);
  s.onended = () => { s.disconnect(); fl.disconnect(); g.disconnect(); };
}
function kick(out, t, peak = 0.5, base = 46) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(base, t + 0.12);
  g.gain.setValueAtTime(peak, t); g.gain.setTargetAtTime(0, t + 0.02, 0.09);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.7); o.onended = () => { o.disconnect(); g.disconnect(); };
}
// continuous looped source; returns a stop function
function loopSrc(buf, chain, gain) {
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true;
  let n = s; for (const x of chain) { n.connect(x); n = x; }
  const g = gainNode(gain); n.connect(g);
  s.start(0, Math.random() * (buf.duration - 1));
  return { out: g, stop() { try { s.stop(); } catch {} } };
}
function lfo(rate, depth, target) {
  const o = ctx.createOscillator(), g = gainNode(depth);
  o.frequency.value = rate; o.connect(g); g.connect(target); o.start();
  return { stop() { try { o.stop(); } catch {} } };
}
function pulseWave(d) {
  const N = 32, re = new Float32Array(N), im = new Float32Array(N);
  for (let n = 1; n < N; n++) { re[n] = 2 / (n * Math.PI) * Math.sin(n * Math.PI * d); im[n] = 2 / (n * Math.PI) * (1 - Math.cos(n * Math.PI * d)); }
  return ctx.createPeriodicWave(re, im);
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

/* ---------- stations: (io, rng) -> { bpm, sub, step(n, t), stop() } ---------- */
// io.out = bus tujuan, io.send = bus ke reverb
const MAKERS = {
  lofi(io, r) {
    const keys = ctx.createGain(), keysLp = filt('lowpass', 2600, 0.5), drums = filt('lowpass', 6500), warm = filt('lowpass', 5200, 0.4);
    keys.connect(keysLp); keysLp.connect(warm); drums.connect(warm); warm.connect(io.out);
    const send = gainNode(0.18); keysLp.connect(send); send.connect(io.send);
    const crackle = makeBuffer(ctx, 5, d => { for (let i = 0; i < d.length; i++) { d[i] = (r() * 2 - 1) * 0.012; if (r() < 22 / ctx.sampleRate) d[i] += (r() < 0.5 ? -1 : 1) * r() ** 3 * 0.9; } });
    const vinyl = loopSrc(crackle, [filt('highpass', 1400)], 0.5); vinyl.out.connect(io.out);
    const C = { Dm9: [38, [53, 57, 60, 64]], G13: [43, [53, 59, 64, 69]], Cm9: [36, [52, 59, 62, 67]], Am9: [45, [55, 59, 60, 64]], Fm9: [41, [52, 57, 60, 67]], Em7: [40, [55, 59, 62, 67]] };
    const PROGS = [['Dm9', 'G13', 'Cm9', 'Am9'], ['Fm9', 'Em7', 'Dm9', 'G13'], ['Cm9', 'Am9', 'Dm9', 'G13'], ['Am9', 'Dm9', 'G13', 'Cm9']];
    let prog = pick(r, PROGS), lastMel = 4;
    const SC = [69, 72, 74, 76, 79, 81];
    const rhodes = (t, m, v, tau = 1.3) => {
      const f = mtof(m);
      voice(keys, { f, t, peak: 0.075 * v, tau, detune: -4 }); voice(keys, { f, t, peak: 0.06 * v, tau, detune: 5 });
      voice(keys, { f: f * 2, t, peak: 0.035 * v, tau: 0.25 }); voice(keys, { f: f * 7, t, peak: 0.012 * v, tau: 0.04 });
    };
    return {
      bpm: 80, sub: 4,
      step(n, t) {
        const sd = 60 / 80 / 4, bar = Math.floor(n / 16), s = n % 16, tt = t + (s & 1 ? sd * 0.22 : 0) + (r() - 0.5) * 0.012;
        if (s === 0 && bar % 8 === 0 && n > 0) prog = pick(r, PROGS);
        const [bass, notes] = C[prog[Math.floor(bar / 2) % 4]];
        if (s === 0 && bar % 2 === 0) {
          notes.forEach((m, i) => rhodes(tt + i * 0.018, m, 0.9 - i * 0.05));
          voice(keys, { type: 'sine', f: mtof(bass + 12), t: tt, peak: 0.16, a: 0.01, tau: 0.5 });
        } else if (s === 10 && bar % 2 === 1 && r() < 0.6) notes.slice(1).forEach((m, i) => rhodes(tt + i * 0.02, m, 0.5));
        if ((s === 0 || s === 11) && bar % 2 === 1 && r() < 0.8) voice(keys, { f: mtof(bass + 12), t: tt, peak: 0.12, tau: 0.4 });
        if (s % 2 === 0 && r() < (bar % 4 === 3 ? 0.45 : 0.2)) { lastMel = Math.max(0, Math.min(SC.length - 1, lastMel + pick(r, [-2, -1, -1, 1, 1, 2]))); rhodes(tt, SC[lastMel], 0.55, 0.9); }
        // drums
        if (s === 0 || (s === 10 && r() < 0.8) || (s === 7 && r() < 0.25)) kick(drums, tt, s ? 0.3 : 0.42, 48);
        if (s === 4 || s === 12) { noiseHit(drums, { t: tt, f: 1800, type: 'bandpass', q: 0.8, tau: 0.08, peak: 0.2 }); voice(drums, { f: 190, t: tt, peak: 0.1, tau: 0.04 }); }
        else if ((s === 15 || s === 7) && r() < 0.15) noiseHit(drums, { t: tt, f: 1800, type: 'bandpass', q: 0.8, tau: 0.04, peak: 0.06 });
        if (s % 2 === 0) noiseHit(drums, { t: tt, f: 7500, tau: s % 4 === 2 && r() < 0.15 ? 0.09 : 0.02, peak: 0.05 + r() * 0.035 });
      },
      stop() { vinyl.stop(); },
    };
  },

  chip(io, r) {
    const sq = pulseWave(0.25), sq2 = pulseWave(0.5), mix = ctx.createGain(), lp = filt('lowpass', 7000, 0.3), dr = ctx.createGain();
    mix.connect(lp); dr.connect(lp); lp.connect(io.out);
    const send = gainNode(0.08); lp.connect(send); send.connect(io.send);
    const P = [{ r: 45, c: [57, 60, 64] }, { r: 41, c: [57, 60, 65] }, { r: 48, c: [60, 64, 67] }, { r: 43, c: [59, 62, 67] }];
    const PENT = [57, 60, 62, 64, 67, 69, 72, 74, 76];
    const motif = () => Array.from({ length: 16 }, (_, i) => (i % 2 === 0 && r() < 0.55) || r() < 0.12 ? pick(r, PENT) : 0);
    let mo = motif(), leadOn = false;
    return {
      bpm: 128, sub: 4,
      step(n, t) {
        const s = n % 16, bar = Math.floor(n / 16), ch = P[bar % 4];
        if (s === 0 && bar % 8 === 0) { leadOn = bar % 16 >= 8 || r() < 0.4; if (bar % 16 === 0) mo = motif(); else if (r() < 0.5) mo[Math.floor(r() * 16)] = pick(r, PENT); }
        // bass (triangle, 8ths)
        if (s % 2 === 0) { const i = s / 2, off = [0, 0, 12, 0, 0, 7, 12, 7][i]; voice(mix, { type: 'triangle', f: mtof(ch.r + off), t, peak: 0.2, a: 0.004, tau: 0.07 }); }
        // arpeggio (25% pulse)
        const arp = [ch.c[0], ch.c[1], ch.c[2], ch.c[1] + 12][s % 4] + (s >= 8 && s % 8 >= 4 ? 12 : 0);
        voice(mix, { wave: sq, f: mtof(arp), t, peak: 0.032, a: 0.003, tau: 0.045 });
        // lead (50% pulse)
        if (leadOn && mo[s]) voice(mix, { wave: sq2, f: mtof(mo[s]), t, peak: 0.04, a: 0.006, hold: 0.07, tau: 0.06 });
        // noise-channel drums
        if (s === 0 || s === 8 || (s === 10 && bar % 2)) kick(dr, t, 0.4, 52);
        if (s === 4 || s === 12) noiseHit(dr, { t, f: 2200, type: 'bandpass', q: 0.6, tau: 0.05, peak: 0.12 });
        if (s % 2 === 0) noiseHit(dr, { t, f: 9000, tau: 0.018, peak: 0.035 });
      },
      stop() {},
    };
  },

  hujan(io, r) {
    const rain = loopSrc(white, [filt('highpass', 700), filt('lowpass', 7500)], 0.16);
    const far = loopSrc(brown, [filt('lowpass', 380)], 0.45);
    const lf = lfo(0.06, 0.05, rain.out.gain);
    rain.out.connect(io.out); far.out.connect(io.out);
    const pno = filt('lowpass', 4200, 0.4), dry = gainNode(0.7), send = gainNode(0.65);
    pno.connect(dry); pno.connect(send); dry.connect(io.out); send.connect(io.send);
    const SC = [50, 53, 55, 57, 60, 62, 65, 67, 69, 72, 74];
    let idx = 5;
    const key = (t, m, v) => {
      const f = mtof(m);
      voice(pno, { f, t, peak: 0.13 * v, a: 0.004, tau: 1.5 }); voice(pno, { type: 'triangle', f: f * 2, t, peak: 0.04 * v, a: 0.003, tau: 0.5 });
      voice(pno, { f: f * 3, t, peak: 0.015 * v, a: 0.002, tau: 0.25 }); noiseHit(pno, { t, f: 1500, type: 'bandpass', tau: 0.012, peak: 0.01 * v });
    };
    return {
      bpm: 52, sub: 1,
      step(n, t) {
        if (r() < 0.55 || n === 0) {
          idx = Math.max(0, Math.min(SC.length - 1, idx + pick(r, [-3, -2, -1, -1, 1, 1, 2, 3])));
          const tt = t + r() * 0.25, v = 0.6 + r() * 0.5;
          key(tt, SC[idx], v);
          if (r() < 0.25) key(tt + 0.04, SC[Math.max(0, idx - 2)], v * 0.7);
          if (r() < 0.12) key(tt, SC[0] - 12 + pick(r, [0, 5, 7]), 0.8);
        }
        if (r() < 0.3) voice(send, { f: 2600 + r() * 2400, t: t + r() * 0.9, peak: 0.012, a: 0.001, tau: 0.012 }); // tetes air
      },
      stop() { rain.stop(); far.stop(); lf.stop(); },
    };
  },

  fokus(io, r) {
    const pad = filt('lowpass', 800, 0.5), send = gainNode(0.5);
    pad.connect(io.out); pad.connect(send); send.connect(io.send);
    const lf = lfo(0.05, 260, pad.frequency);
    const bed = loopSrc(brown, [filt('lowpass', 520)], 0.1); bed.out.connect(io.out);
    const CH = [[50, 57, 62, 64], [53, 57, 64, 69], [48, 55, 62, 67], [52, 57, 59, 66], [50, 55, 60, 64]];
    let last = 0;
    return {
      bpm: 15, sub: 1,
      step(n, t) {
        if (n % 4 === 0) {
          let i; do { i = Math.floor(r() * CH.length); } while (i === last); last = i;
          CH[i].forEach((m, k) => {
            const f = mtof(m);
            voice(pad, { type: 'triangle', f, t, a: 5, hold: 10, tau: 3, peak: 0.07, detune: -6 });
            voice(pad, { type: 'sine', f: f * 1.004, t, a: 6, hold: 9, tau: 3, peak: 0.06 });
            if (k === 0) voice(pad, { type: 'sine', f: f / 2, t, a: 6, hold: 10, tau: 3, peak: 0.1 });
          });
        }
        if (r() < 0.2) { const m = pick(r, [74, 76, 81, 86]); voice(send, { f: mtof(m), t: t + r() * 2, a: 0.01, tau: 1.2, peak: 0.018 }); }
      },
      stop() { lf.stop(); bed.stop(); },
    };
  },
};

/* ---------- lagu & playlist ---------- */
window.addEventListener('kantor-music-dir', () => { refreshLibrary(); });
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function jfetch(url, opt = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opt });
  let d = null; try { d = await res.json(); } catch {}
  if (!res.ok) throw new Error(d?.error || `Gagal (${res.status})`);
  return d;
}
export async function refreshLibrary() {
  const [lib, lists] = await Promise.all([jfetch('/api/music'), jfetch('/api/music/playlists')]);
  L.files = lib.files || []; L.lists = lists || []; L.loaded = true;
  if (L.source !== 'all' && !L.lists.some(p => p.id === L.source)) L.source = 'all';
  if (L.ready) { const cp = curTrack()?.path; buildQueue(cp); }
  emit();
}
export const library = () => ({ files: L.files || [], playlists: L.lists, loaded: L.loaded, dir: null });
const srcTracks = () => (L.source === 'all' ? L.files || [] : L.lists.find(p => p.id === L.source)?.items.filter(t => !t.missing) || []);
function buildQueue(startPath) {
  L.base = srcTracks();
  const idx = L.base.map((_, i) => i);
  let pos = startPath ? idx.findIndex(i => L.base[i].path === startPath) : 0;
  if (pos < 0) pos = 0;
  if (L.shuffle) { shuffleArr(idx); if (startPath) { const k = idx.findIndex(i => L.base[i].path === startPath); if (k > 0) [idx[0], idx[k]] = [idx[k], idx[0]]; pos = 0; } }
  L.order = idx; L.pos = pos;
}
function playCurrent() {
  const a = L.audio, t = curTrack();
  if (!t) { S.error = L.source === 'all' ? 'Belum ada lagu. Unggah atau atur folder musik di Pengaturan.' : 'Playlist ini kosong atau filenya hilang.'; S.playing = false; stopStation(true); fader.gain.setTargetAtTime(0, ctx.currentTime, 0.05); emit(); return; }
  S.error = ''; S.title = t.name; L.t = 0; L.d = 0;
  a.src = `/api/music/file?path=${encodeURIComponent(t.path)}`;
  emit();
  return a.play().catch(() => { if (S.playing && S.station === 'folder') trackFail(); });
}
function trackFail() {
  if (++L.errors >= L.base.length) { S.error = 'File musik tidak bisa diputar'; S.playing = false; stopStation(true); fader.gain.setTargetAtTime(0, ctx.currentTime, 0.05); emit(); }
  else step(1, false);
}
function step(dir, auto) {
  const n = L.order.length; if (!n) return;
  if (auto && L.repeat === 'one') { L.audio.currentTime = 0; L.audio.play().catch(() => {}); return; }
  let p = L.pos + dir;
  if (p >= n || p < 0) {
    if (auto && L.repeat === 'off') { L.pos = 0; L.t = 0; pause(); return; }
    if (L.shuffle && dir > 0) { const last = L.order[n - 1]; shuffleArr(L.order); if (n > 1 && L.order[0] === last) [L.order[0], L.order[1]] = [L.order[1], L.order[0]]; }
    p = dir > 0 ? 0 : n - 1;
  }
  L.pos = p; playCurrent();
}
function applyStart() {
  if (L.start) { const st = L.start; L.start = null; buildQueue(st); playCurrent(); }
  else if (L.audio.src && L.audio.paused && L.audio.currentTime > 0 && !L.audio.ended && curTrack()) { S.title = curTrack().name; L.audio.play().catch(() => {}); emit(); }
  else { buildQueue(); playCurrent(); }
}
function folderInst(bus, myGen) {
  if (!L.audio) {
    const a = L.audio = new Audio(); a.preload = 'auto';
    L.node = ctx.createMediaElementSource(a);
    a.addEventListener('ended', () => { if (S.playing && S.station === 'folder') step(1, true); });
    a.addEventListener('error', () => { if (S.playing && S.station === 'folder' && a.src) trackFail(); });
    a.addEventListener('playing', () => { L.errors = 0; });
    a.addEventListener('loadedmetadata', () => { L.d = a.duration || 0; for (const f of timeSubs) f(a.currentTime, L.d); emit(); });
    a.addEventListener('timeupdate', () => { L.t = a.currentTime; for (const f of timeSubs) f(L.t, L.d); });
  }
  L.node.disconnect(); L.node.connect(bus); L.ready = false;
  refreshLibrary().then(() => {
    if (myGen !== gen) return;
    L.ready = true; applyStart();
  }).catch(e => { if (myGen !== gen) return; S.error = e.message; S.playing = false; stopStation(true); emit(); });
  return { stop() { L.audio.pause(); L.ready = false; } };
}

/** Play one track from the library ('all') or a playlist id. */
export function playTrack(path, src) {
  if (src) L.source = src;
  L.start = path; persist();
  if (S.station === 'folder' && cur && L.ready) { play('folder'); applyStart(); }
  else play('folder');
}
export function select(value) {
  if (String(value).startsWith('lib:')) {
    L.source = value.slice(4); persist(); L.start = null;
    if (S.station === 'folder' && cur && L.ready) { buildQueue(); if (S.playing) playCurrent(); else { S.title = curTrack()?.name || stationOf('folder').name; emit(); } }
    else if (S.playing) play('folder');
    else { S.station = 'folder'; S.title = stationOf('folder').name; S.error = ''; persist(); emit(); }
  } else if (S.playing) play(value);
  else { S.station = value; S.title = stationOf(value).name; S.error = ''; persist(); emit(); }
}
export function seek(sec) { if (L.audio && S.station === 'folder' && isFinite(sec)) { L.audio.currentTime = Math.max(0, Math.min(sec, L.d || sec)); L.t = L.audio.currentTime; } }
export function setRepeat(m) { L.repeat = ['off', 'all', 'one'].includes(m) ? m : 'off'; persist(); emit(); }
export const toggleRepeat = () => setRepeat({ off: 'all', all: 'one', one: 'off' }[L.repeat]);
export function setShuffle(v) {
  L.shuffle = !!v; persist();
  if (L.ready) { const cp = curTrack()?.path; buildQueue(cp); }
  emit();
}
const lib = async (fn) => { const r = await fn(); await refreshLibrary(); return r; };
export const createPlaylist = (name, paths = []) => lib(() => jfetch('/api/music/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, paths }) }));
const patchPl = (id, b) => lib(() => jfetch(`/api/music/playlists/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }));
export const renamePlaylist = (id, name) => patchPl(id, { name });
export const addToPlaylist = (id, paths) => patchPl(id, { add: paths });
export const setPlaylistItems = (id, paths) => patchPl(id, { items: paths });
export const removeFromPlaylist = (id, path) => patchPl(id, { items: (L.lists.find(p => p.id === id)?.items || []).map(i => i.path).filter(x => x !== path) });
export const deletePlaylist = id => lib(() => jfetch(`/api/music/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' }));
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i;
/** Upload audio files one by one; returns { ok:[...], fail:[{name, error}] }. */
export async function uploadFiles(files, onProgress) {
  const list = [...files], res = { ok: [], fail: [] };
  for (const [i, f] of list.entries()) {
    onProgress?.(i + 1, list.length, f.name);
    if (!AUDIO_RE.test(f.name)) { res.fail.push({ name: f.name, error: 'Bukan file audio' }); continue; }
    try { res.ok.push(await jfetch(`/api/music/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f })); }
    catch (e) { res.fail.push({ name: f.name, error: e.message }); }
  }
  if (res.ok.length) await refreshLibrary();
  return res;
}

/* ---------- transport ---------- */
function startStation(id) {
  const bus = gainNode(0), myGen = ++gen;
  bus.connect(fader); bus.gain.setTargetAtTime(1, ctx.currentTime, 0.25);
  const send = gainNode(1); send.connect(rev);
  cur = { id, bus, send };
  if (id === 'folder') { S.title = stationOf(id).name; cur.inst = folderInst(bus, myGen); return; }
  L.ready = false;
  const r = rngOf(Date.now() & 0xffffffff), io = { out: bus, send };
  const inst = cur.inst = MAKERS[id](io, r);
  let n = 0, nextT = ctx.currentTime + 0.12;
  const dt = 60 / inst.bpm / inst.sub;
  const pump = () => { while (nextT < ctx.currentTime + LOOK) { inst.step(n++, nextT); nextT += dt; } };
  pump(); cur.timer = setInterval(pump, TICK);
  S.title = stationOf(id).name;
}
// fade the running station out and release it once its tails are done
function stopStation(now) {
  if (!cur) return;
  const c = cur; cur = null; gen++;
  clearInterval(c.timer);
  c.bus.gain.cancelScheduledValues(ctx.currentTime); c.bus.gain.setTargetAtTime(0, ctx.currentTime, now ? 0.02 : 0.15);
  setTimeout(() => { try { c.inst?.stop(); } catch {} c.bus.disconnect(); c.send.disconnect(); }, now ? 150 : 1400);
}

export function play(id) {
  ensureCtx();
  clearTimeout(offTimer);
  ctx.resume();
  if (id && !stationOf(id)) id = null;
  S.error = '';
  const now = ctx.currentTime;
  fader.gain.cancelScheduledValues(now); fader.gain.setTargetAtTime(1, now, 0.12);
  if (id && id !== S.station) { S.station = id; persist(); stopStation(); }
  if (!cur) startStation(S.station);
  S.playing = true; emit();
}
export function pause() {
  if (!ctx || !S.playing) return;
  S.playing = false; emit();
  const now = ctx.currentTime;
  fader.gain.cancelScheduledValues(now); fader.gain.setTargetAtTime(0, now, 0.08);
  clearTimeout(offTimer);
  offTimer = setTimeout(() => { if (S.playing) return; stopStation(true); ctx.suspend(); }, 450);
}
export const toggle = () => (S.playing ? pause() : play());
export function next() {
  if (S.station === 'folder' && cur && L.ready) { step(1, false); return; }
  hop(1);
}
export function prev() {
  if (S.station === 'folder' && cur && L.ready) { if (L.audio.currentTime > 3) L.audio.currentTime = 0; else step(-1, false); return; }
  hop(-1);
}
function hop(d) {
  const i = STATIONS.findIndex(s => s.id === S.station), id = STATIONS[(i + d + STATIONS.length) % STATIONS.length].id;
  if (S.playing) play(id); else { S.station = id; S.title = stationOf(id).name; S.error = ''; persist(); emit(); }
}
export function setVolume(v) {
  S.volume = Math.max(0, Math.min(1, Number(v) || 0)); persist();
  if (volNode) volNode.gain.setTargetAtTime(S.volume ** 2 * 0.9, ctx.currentTime, 0.05);
  emit();
}
export const on = fn => { subs.add(fn); return () => subs.delete(fn); };
export const onTime = fn => { timeSubs.add(fn); return () => timeSubs.delete(fn); };
export const music = { play, pause, toggle, next, prev, setVolume, seek, setRepeat, toggleRepeat, setShuffle, select, playTrack, refreshLibrary, library, uploadFiles, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, setPlaylistItems, removeFromPlaylist, state, on, onTime };
export default music;

/* ---------- UI ---------- */
const ic = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  play: ic('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/>'),
  pause: ic('<rect x="6" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" fill="currentColor"/>'),
  next: ic('<path d="M6 6.2v11.6a.8.8 0 0 0 1.25.66l8-5.8a.8.8 0 0 0 0-1.32l-8-5.8A.8.8 0 0 0 6 6.2z" fill="currentColor"/><rect x="16.5" y="5.5" width="2.5" height="13" rx="1" fill="currentColor"/>'),
  prev: ic('<path d="M18 6.2v11.6a.8.8 0 0 1-1.25.66l-8-5.8a.8.8 0 0 1 0-1.32l8-5.8A.8.8 0 0 1 18 6.2z" fill="currentColor"/><rect x="5" y="5.5" width="2.5" height="13" rx="1" fill="currentColor"/>'),
  vol: ic('<path d="M4 9.5v5h3.5l4.5 3.8V5.7L7.5 9.5H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M17.8 6.5a7.6 7.6 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  shuffle: ic('<path d="M4 7h3.5c4 0 5 10 9 10H20M4 17h3.5c1.5 0 2.600-1.200 3.600-2.800M13 9.200C14 7.900 15 7 16.500 7H20M18 4.500 20.500 7 18 9.500M18 14.500l2.500 2.500-2.500 2.500" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  repeat: ic('<path d="M5 11V9.500A2.500 2.500 0 0 1 7.500 7H19M16 4l3 3-3 3M19 13v1.500a2.500 2.500 0 0 1-2.500 2.500H5M8 20l-3-3 3-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  one: '<b class="kc-one">1</b>',
  up: ic('<path d="M12 16V5M7.500 9.500 12 5l4.500 4.500M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  grip: ic('<g fill="currentColor"><circle cx="9" cy="6" r="1.500"/><circle cx="15" cy="6" r="1.500"/><circle cx="9" cy="12" r="1.500"/><circle cx="15" cy="12" r="1.500"/><circle cx="9" cy="18" r="1.500"/><circle cx="15" cy="18" r="1.500"/></g>'),
  x: ic('<path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
};
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = t => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const sizeOf = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const srcName = id => (id === 'all' ? 'Semua lagu' : L.lists.find(p => p.id === id)?.name || 'Semua lagu');
const sourceOptions = st => `<optgroup label="Radio kantor">${STATIONS.filter(s => s.id !== 'folder').map(s => `<option value="${s.id}">${escH(s.name)}</option>`).join('')}</optgroup>
  <optgroup label="Lagu &amp; playlist"><option value="lib:all">Semua lagu${L.files ? ` (${L.files.length})` : ''}</option>${L.lists.map(p => `<option value="lib:${escH(p.id)}">${escH(p.name)} (${p.items.length})</option>`).join('')}</optgroup>`;
const selValue = st => (st.station === 'folder' ? 'lib:' + st.source : st.station);
const repeatTitle = { off: 'Ulangi: mati', all: 'Ulangi semua (loop)', one: 'Ulangi satu lagu' };

// keeps a range input and its time labels in sync without re-rendering
function seekBinder(root) {
  const bar = root.querySelector('.kc-m-seekbar'), t1 = root.querySelector('.kc-m-t1'), t2 = root.querySelector('.kc-m-t2');
  const paint = (t, d) => { t1.textContent = mmss(t); t2.textContent = mmss(d); if (document.activeElement !== bar) bar.value = d ? Math.round(t / d * 1000) : 0; bar.disabled = !d; };
  bar.addEventListener('input', () => seek(bar.value / 1000 * (L.d || 0)));
  const off = onTime(paint); paint(L.t, L.d);
  return () => off();
}
const seekHtml = '<div class="kc-m-seek"><span class="kc-m-t1">0:00</span><input class="kc-m-seekbar" type="range" min="0" max="1000" step="1" value="0" aria-label="Posisi lagu"><span class="kc-m-t2">0:00</span></div>';
const modeBtns = '<button type="button" class="kc-m-mode" data-m="shuffle" aria-label="Acak" title="Acak"></button><button type="button" class="kc-m-mode" data-m="repeat" aria-label="Ulangi"></button>';
function paintModes(root, st) {
  const sh = root.querySelector('[data-m="shuffle"]'), rp = root.querySelector('[data-m="repeat"]');
  sh.innerHTML = I.shuffle; sh.classList.toggle('on', st.shuffle); sh.setAttribute('aria-pressed', st.shuffle);
  rp.innerHTML = st.repeat === 'one' ? I.repeat + I.one : I.repeat; rp.classList.toggle('on', st.repeat !== 'off'); rp.title = repeatTitle[st.repeat]; rp.setAttribute('aria-label', repeatTitle[st.repeat]);
}
function modeClick(b) {
  const m = b.dataset.m;
  if (m === 'shuffle') setShuffle(!L.shuffle); else if (m === 'repeat') toggleRepeat();
  else if (m === 'next') next(); else if (m === 'prev') prev(); else if (m === 'toggle') toggle();
}

export function mountPlayer(el) {
  el.innerHTML = `<div class="kc-music">
    <div class="kc-m-main">
      <button type="button" class="kc-m-play" data-m="toggle" aria-label="Putar">${I.play}</button>
      <div class="kc-m-info"><div class="kc-m-title"></div><div class="kc-m-sub"></div></div>
      <div class="kc-m-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    </div>
    ${seekHtml}
    <div class="kc-m-row">
      <select class="kc-m-sel" aria-label="Sumber musik"></select>
      <button type="button" class="kc-m-next" data-m="prev" aria-label="Sebelumnya" title="Sebelumnya">${I.prev}</button>
      <button type="button" class="kc-m-next" data-m="next" aria-label="Berikutnya" title="Berikutnya">${I.next}</button>
    </div>
    <div class="kc-m-vol"><span class="kc-m-vi" title="Volume">${I.vol}</span><input class="kc-m-volbar" type="range" min="0" max="100" step="1" aria-label="Volume">${modeBtns}</div>
  </div>`;
  const root = el.firstElementChild, $ = s => root.querySelector(s);
  const btn = $('.kc-m-play'), sel = $('.kc-m-sel'), vol = $('.kc-m-volbar'), title = $('.kc-m-title'), sub = $('.kc-m-sub');
  let optSig = '';
  const paint = st => {
    root.dataset.on = st.playing ? '1' : ''; root.dataset.mode = st.station === 'folder' ? 'lib' : 'radio';
    btn.innerHTML = st.playing ? I.pause : I.play; btn.setAttribute('aria-label', st.playing ? 'Jeda' : 'Putar');
    const sig = JSON.stringify([L.files?.length, L.lists.map(p => [p.id, p.name, p.items.length])]);
    if (sig !== optSig) { optSig = sig; sel.innerHTML = sourceOptions(st); }
    sel.value = selValue(st);
    if (document.activeElement !== vol) vol.value = Math.round(st.volume * 100);
    title.textContent = st.title; title.title = st.title;
    sub.textContent = st.error || (st.station === 'folder' ? `${srcName(st.source)}${st.track ? ` · ${st.index + 1}/${L.order.length}` : ''}` : st.playing ? stationOf(st.station).desc : 'Jeda'); sub.classList.toggle('err', !!st.error);
    paintModes(root, st);
  };
  root.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b) modeClick(b); });
  sel.addEventListener('change', () => select(sel.value));
  vol.addEventListener('input', () => setVolume(vol.value / 100));
  const offSeek = seekBinder(root), off = on(paint);
  paint(state());
  if (!L.loaded) refreshLibrary().catch(() => {}); // fills the playlist options; harmless if the music dir is empty
  return () => { off(); offSeek(); el.innerHTML = ''; };
}

export function mountLibrary(el) {
  el.innerHTML = `<div class="kc-lib">
    <aside class="kc-l-side">
      <h3>Radio kantor</h3><ul class="kc-l-radio"></ul>
      <h3>Lagu &amp; playlist</h3><ul class="kc-l-lists"></ul>
      <button type="button" class="kc-l-btn" data-l="newpl">+ Playlist baru</button>
    </aside>
    <section class="kc-l-main">
      <div class="kc-l-now">
        <div class="kc-m-main"><button type="button" class="kc-m-play" data-m="toggle" aria-label="Putar">${I.play}</button>
          <div class="kc-m-info"><div class="kc-m-title"></div><div class="kc-m-sub"></div></div><div class="kc-m-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></div>
        ${seekHtml}
        <div class="kc-l-ctl"><button type="button" class="kc-m-next" data-m="prev" aria-label="Sebelumnya">${I.prev}</button><button type="button" class="kc-m-next" data-m="next" aria-label="Berikutnya">${I.next}</button>
          <div class="kc-m-vol"><span class="kc-m-vi">${I.vol}</span><input class="kc-m-volbar" type="range" min="0" max="100" aria-label="Volume">${modeBtns}</div></div>
      </div>
      <div class="kc-l-bar"><input class="kc-l-search" type="search" placeholder="Cari lagu" aria-label="Cari lagu">
        <button type="button" class="kc-l-btn" data-l="playall">Putar semua</button>
        <button type="button" class="kc-l-btn" data-l="upload">${I.up} Unggah lagu</button>
        <span class="kc-l-pl-actions"><button type="button" class="kc-l-btn" data-l="rename">Ganti nama</button><button type="button" class="kc-l-btn danger" data-l="delpl">Hapus playlist</button></span>
        <input type="file" class="kc-l-file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.flac,.opus" multiple hidden></div>
      <div class="kc-l-msg" role="status"></div>
      <ol class="kc-l-tracks"></ol>
      <div class="kc-l-drop" aria-hidden="true"><div>Lepaskan file audio untuk mengunggah</div></div>
      <h3 class="kc-l-qh">Berikutnya</h3><ol class="kc-l-queue"></ol>
    </section></div>`;
  const root = el.firstElementChild, $ = s => root.querySelector(s);
  let view = L.source, q = '', msgT = 0, dragPath = null;
  const msg = (t, bad) => { const m = $('.kc-l-msg'); m.textContent = t; m.classList.toggle('err', !!bad); clearTimeout(msgT); if (t) msgT = setTimeout(() => { m.textContent = ''; }, 8000); };
  const viewTracks = () => (view === 'all' ? (L.files || []).map(f => ({ ...f, missing: false })) : L.lists.find(p => p.id === view)?.items || []);
  const playingHere = st => st.station === 'folder' && st.track;

  const drawSide = st => {
    $('.kc-l-radio').innerHTML = STATIONS.filter(s => s.id !== 'folder').map(s => `<li><button type="button" class="kc-l-item${st.station === s.id ? ' act' : ''}" data-l="radio" data-id="${s.id}"><span>${escH(s.name)}</span>${st.station === s.id && st.playing ? '<i class="kc-l-dot"></i>' : ''}</button></li>`).join('');
    $('.kc-l-lists').innerHTML = [['all', 'Semua lagu', (L.files || []).length], ...L.lists.map(p => [p.id, p.name, p.items.length])].map(([id, n, c]) =>
      `<li data-drop="${escH(id)}"><button type="button" class="kc-l-item${view === id ? ' sel' : ''}${st.station === 'folder' && st.source === id ? ' act' : ''}" data-l="view" data-id="${escH(id)}"><span>${escH(n)}</span><b>${c}</b></button></li>`).join('');
    $('.kc-l-pl-actions').style.display = view === 'all' ? 'none' : '';
  };
  const drawTracks = st => {
    const cp = playingHere(st) && st.source === view ? st.track.path : null, needle = q.trim().toLowerCase();
    const rows = viewTracks().map((t, i) => ({ t, i })).filter(({ t }) => !needle || t.name.toLowerCase().includes(needle) || t.path.toLowerCase().includes(needle));
    const addOpts = `<option value="">+</option>${L.lists.filter(p => p.id !== view).map(p => `<option value="${escH(p.id)}">${escH(p.name)}</option>`).join('')}<option value="__new">Playlist baru…</option>`;
    $('.kc-l-tracks').innerHTML = rows.length ? rows.map(({ t, i }) => `<li class="kc-l-row${t.missing ? ' miss' : ''}${t.path === cp ? ' cur' : ''}" data-path="${escH(t.path)}" ${view !== 'all' && !needle ? 'draggable="true"' : 'draggable="true"'}>
      ${view !== 'all' ? `<span class="kc-l-grip" title="Seret untuk mengurutkan">${I.grip}</span>` : ''}
      <button type="button" class="kc-l-name" data-l="playtrack" ${t.missing ? 'disabled' : ''}><span class="kc-l-n">${t.path === cp && st.playing ? '<i class="kc-l-dot"></i>' : i + 1}</span><span class="kc-l-t">${escH(t.name)}</span>${t.missing ? '<em>file hilang</em>' : `<small>${t.size ? sizeOf(t.size) : escH(t.path.includes('/') ? t.path.split('/').slice(0, -1).join('/') : '')}</small>`}</button>
      ${t.missing ? '' : `<select class="kc-l-add" data-l="addto" aria-label="Tambah ke playlist" title="Tambah ke playlist">${addOpts}</select>`}
      ${view !== 'all' ? `<button type="button" class="kc-l-x" data-l="rm" aria-label="Hapus dari playlist" title="Hapus dari playlist">${I.x}</button>` : ''}</li>`).join('')
      : `<li class="kc-l-empty">${!L.loaded ? 'Memuat…' : needle ? 'Tidak ada yang cocok.' : view === 'all' ? 'Belum ada lagu. Seret file audio ke sini atau klik Unggah lagu.' : 'Playlist kosong. Tambahkan lagu dari Semua lagu (tombol +) atau seret ke nama playlist.'}</li>`;
  };
  const drawQueue = st => {
    const qs = st.queue;
    $('.kc-l-qh').hidden = $('.kc-l-queue').hidden = st.station !== 'folder';
    $('.kc-l-queue').innerHTML = qs.length ? qs.map(t => `<li>${escH(t.name)}</li>`).join('') : '<li class="kc-l-empty">Antrean habis.</li>';
  };
  const btn = $('.kc-m-play'), vol = $('.kc-m-volbar'), title = $('.kc-m-title'), sub = $('.kc-m-sub');
  const paint = st => {
    if (view !== 'all' && !L.lists.some(p => p.id === view)) view = 'all';
    $('.kc-l-now').dataset.on = st.playing ? '1' : ''; $('.kc-l-now').dataset.mode = st.station === 'folder' ? 'lib' : 'radio';
    btn.innerHTML = st.playing ? I.pause : I.play;
    if (document.activeElement !== vol) vol.value = Math.round(st.volume * 100);
    title.textContent = st.title;
    sub.textContent = st.error || (st.station === 'folder' ? `${srcName(st.source)}${st.track ? ` · ${st.index + 1}/${L.order.length}` : ''}` : stationOf(st.station).desc); sub.classList.toggle('err', !!st.error);
    paintModes(root, st);
    drawSide(st); drawTracks(st); drawQueue(st);
  };

  const doUpload = async files => {
    files = [...files]; if (!files.length) return;
    const r = await uploadFiles(files, (i, n, name) => msg(`Mengunggah ${i}/${n}: ${name}`));
    const f = r.fail.map(x => `${x.name} (${x.error})`).join('; ');
    msg(`${r.ok.length ? `${r.ok.length} lagu diunggah.` : ''}${f ? ` Gagal: ${f}` : ''}`.trim(), !!r.fail.length);
    if (r.ok.length && view !== 'all') { try { await addToPlaylist(view, r.ok.map(x => x.path)); } catch {} }
  };
  const newPlaylist = async paths => {
    const name = (window.prompt('Nama playlist baru') || '').trim(); if (!name) return null;
    try { const p = await createPlaylist(name, paths || []); return p; } catch (e) { msg(e.message, true); return null; }
  };
  root.addEventListener('click', async e => {
    const mb = e.target.closest('[data-m]'); if (mb) { modeClick(mb); return; }
    const b = e.target.closest('[data-l]'); if (!b || b.tagName === 'SELECT') return;
    const act = b.dataset.l, row = b.closest('.kc-l-row'), st = state();
    try {
      if (act === 'radio') { st.station === b.dataset.id && st.playing ? pause() : play(b.dataset.id); }
      else if (act === 'view') { view = b.dataset.id; paint(state()); }
      else if (act === 'newpl') { const p = await newPlaylist(); if (p) { view = p.id; paint(state()); } }
      else if (act === 'playtrack') playTrack(row.dataset.path, view);
      else if (act === 'playall') { const f = viewTracks().find(t => !t.missing); if (f) playTrack(f.path, view); else msg('Tidak ada lagu yang bisa diputar.', true); }
      else if (act === 'upload') $('.kc-l-file').click();
      else if (act === 'rm') await removeFromPlaylist(view, row.dataset.path);
      else if (act === 'rename') { const cur = L.lists.find(p => p.id === view); const n = (window.prompt('Nama baru playlist', cur?.name || '') || '').trim(); if (n) await renamePlaylist(view, n); }
      else if (act === 'delpl') { if (window.confirm('Hapus playlist ini? File lagunya tetap ada.')) { await deletePlaylist(view); view = 'all'; } }
    } catch (err) { msg(err.message, true); }
  });
  root.addEventListener('change', async e => {
    const t = e.target;
    if (t.classList.contains('kc-l-file')) { const fs = t.files; await doUpload(fs); t.value = ''; }
    else if (t.dataset.l === 'addto') {
      const path = t.closest('.kc-l-row').dataset.path, v = t.value; t.value = ''; if (!v) return;
      try { if (v === '__new') { const p = await newPlaylist([path]); if (p) msg(`Dibuat playlist "${p.name}".`); } else { await addToPlaylist(v, [path]); msg('Ditambahkan ke playlist.'); } } catch (err) { msg(err.message, true); }
    }
  });
  $('.kc-l-search').addEventListener('input', e => { q = e.target.value; drawTracks(state()); });
  $('.kc-m-volbar').addEventListener('input', e => setVolume(e.target.value / 100));

  // drag & drop: files from Finder upload; rows reorder inside a playlist or drop on a playlist name to add
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  root.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; root.classList.add('dropping'); } });
  root.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; root.classList.remove('dropping'); } });
  root.addEventListener('dragover', e => {
    if (hasFiles(e)) { e.preventDefault(); return; }
    if (!dragPath) return;
    const li = e.target.closest('[data-drop]'), row = e.target.closest('.kc-l-row');
    if (li && li.dataset.drop !== 'all' && li.dataset.drop !== view) { e.preventDefault(); li.classList.add('over'); }
    else if (row && view !== 'all' && !q) { e.preventDefault(); root.querySelectorAll('.over').forEach(x => x.classList.remove('over')); row.classList.add('over'); }
  });
  root.addEventListener('dragstart', e => { const row = e.target.closest?.('.kc-l-row'); if (!row) return; dragPath = row.dataset.path; e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', dragPath); row.classList.add('drag'); });
  root.addEventListener('dragend', () => { dragPath = null; root.querySelectorAll('.over,.drag').forEach(x => x.classList.remove('over', 'drag')); });
  root.addEventListener('drop', async e => {
    depth = 0; root.classList.remove('dropping');
    if (hasFiles(e)) { e.preventDefault(); await doUpload(e.dataTransfer.files); return; }
    if (!dragPath) return;
    e.preventDefault();
    const li = e.target.closest('[data-drop]'), row = e.target.closest('.kc-l-row'), path = dragPath;
    dragPath = null; root.querySelectorAll('.over,.drag').forEach(x => x.classList.remove('over', 'drag'));
    try {
      if (li && li.dataset.drop !== 'all' && li.dataset.drop !== view) { await addToPlaylist(li.dataset.drop, [path]); msg('Ditambahkan ke playlist.'); }
      else if (row && view !== 'all' && !q && row.dataset.path !== path) {
        const items = viewTracks().map(t => t.path).filter(x => x !== path), at = items.indexOf(row.dataset.path);
        items.splice(at, 0, path); await setPlaylistItems(view, items);
      }
    } catch (err) { msg(err.message, true); }
  });

  const offSeek = seekBinder(root), off = on(paint);
  paint(state());
  refreshLibrary().catch(err => msg(err.message, true));
  return () => { off(); offSeek(); el.innerHTML = ''; };
}
