import os from 'node:os';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { bus } from './live.js';
import { pushGhina } from './notify.js';

/** Performa PC: one shared, lazy sampler. Full rate only while a client asked recently; otherwise a slow idle tick.
 *  Every probe has its own cadence, a timeout, and never overlaps itself. No sudo anywhere. */

export const DEFAULTS = { enabled: true, intervalSec: 5, idleSec: 60, activeSec: 60, historyMin: 60,
  alerts: { cpu: 90, ram: 92, disk: 95, swapPct: 90, sustainSec: 120, cooldownMin: 30 } };

export function conf() {
  const c = config().sysmon || {};
  return { ...DEFAULTS, ...c, alerts: { ...DEFAULTS.alerts, ...(c.alerts || {}) } };
}

const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;

/* ---------------- parsers (pure, tested) ---------------- */

export function parseVmStat(s) {
  const page = Number(/page size of (\d+)/.exec(s)?.[1]) || 4096;
  const v = {};
  for (const m of s.matchAll(/^"?([^":]+)"?:\s+(\d+)\.?$/gm)) v[m[1].trim()] = Number(m[2]);
  const p = k => (v[k] || 0) * page;
  return { page, free: p('Pages free'), active: p('Pages active'), inactive: p('Pages inactive'), wired: p('Pages wired down'),
    speculative: p('Pages speculative'), compressed: p('Pages occupied by compressor'), anon: p('Anonymous pages'), purgeable: p('Pages purgeable'), file: p('File-backed pages'),
    pageins: v.Pageins || 0, pageouts: v.Pageouts || 0, swapins: v.Swapins || 0, swapouts: v.Swapouts || 0 };
}

const MB = x => Math.round(parseFloat(x) * 1024 * 1024);
export function parseSysctl(s) {
  const r = {};
  const sw = /vm\.swapusage:\s*total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M/.exec(s);
  if (sw) r.swap = { total: MB(sw[1]), used: MB(sw[2]), free: MB(sw[3]) };
  const lvl = /kern\.memorystatus_level:\s*(\d+)/.exec(s);
  if (lvl) r.freePct = Number(lvl[1]);
  const pl = /kern\.memorystatus_vm_pressure_level:\s*(\d+)/.exec(s);
  if (pl) r.pressure = { 1: 'normal', 2: 'waspada', 4: 'kritis' }[pl[1]] || 'normal';
  return r;
}

/** static `sysctl` facts: model, chip, P/E cores, boot time */
export function parseSysInfo(s) {
  const g = k => new RegExp(`^${k.replace(/\./g, '\\.')}:\\s*(.+)$`, 'm').exec(s)?.[1].trim() ?? null;
  const levels = [];
  for (let i = 0; i < 4; i++) {
    const n = g(`hw.perflevel${i}.logicalcpu`);
    if (n == null) break;
    const name = g(`hw.perflevel${i}.name`) || (i === 0 ? 'Performance' : 'Efficiency');
    levels.push({ name, cores: Number(n), kind: /effic/i.test(name) ? 'E' : 'P' });
  }
  const bt = /sec = (\d+)/.exec(g('kern.boottime') || '');
  const freq = Number(g('hw.cpufrequency_max') || g('hw.cpufrequency')) || null;
  return { model: g('hw.model'), chip: g('machdep.cpu.brand_string'), levels, bootAt: bt ? Number(bt[1]) * 1000 : null,
    memsize: Number(g('hw.memsize')) || null, freqMHz: freq ? Math.round(freq / 1e6) : null };
}

/** df -kl: keeps the user-visible volumes (Data volume as "Macintosh HD", /Volumes/*), skips the APFS system helpers. */
export function parseDf(s) {
  const out = [];
  for (const line of s.split('\n').slice(1)) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(?:\d+\s+\d+\s+\d+%\s+)?(\/.*)$/.exec(line.trim());
    if (!m) continue;
    const mount = m[6];
    if (mount.startsWith('/System/Volumes/') && mount !== '/System/Volumes/Data') continue;
    if (mount.startsWith('/private/') || mount.startsWith('/Library/Developer/CoreSimulator')) continue;
    const total = Number(m[2]) * 1024, avail = Number(m[4]) * 1024;
    out.push({ mount, dev: m[1], name: mount === '/System/Volumes/Data' ? 'Macintosh HD' : mount === '/' ? 'Sistem' : mount.replace(/^\/Volumes\//, ''),
      total, used: total - avail, free: avail, pct: total ? Math.round((total - avail) / total * 1000) / 10 : 0 });
  }
  // APFS "/" shares the Data container: show only Data when both exist
  return out.some(d => d.mount === '/System/Volumes/Data') ? out.filter(d => d.mount !== '/') : out;
}

export function parseBatt(s) {
  const m = /(\d+)%;\s*([^;]+);\s*([^\s]+)?/.exec(s);
  if (!m) return null;
  const src = /'([^']+)'/.exec(s)?.[1] || null;
  const t = /(\d+):(\d+) remaining/.exec(s);
  const state = m[2].trim();
  return { pct: Number(m[1]), state, charging: /^charging|finishing/.test(state), ac: src === 'AC Power', source: src,
    remainingMin: t && !/no estimate/.test(s) ? Number(t[1]) * 60 + Number(t[2]) : null };
}

/** `"Key" = value` lines of one ioreg entry (top level only). */
export function ioregProps(s) {
  const o = {};
  for (const m of s.matchAll(/^\s*"([^"]+)" = (.+)$/gm)) {
    const v = m[2].trim();
    o[m[1]] = v === 'Yes' ? true : v === 'No' ? false : /^\d{16,}$/.test(v) ? Number(BigInt.asIntN(64, BigInt(v))) : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return o;
}
/** `{"a"=1,"b"="x"}` inline dict → object (numbers and strings only) */
export function ioregDict(s) {
  const o = {};
  if (!s) return o;
  for (const m of s.matchAll(/"([^"]+)"=("([^"]*)"|-?\d+|Yes|No)/g)) o[m[1]] = m[3] != null ? m[3] : m[2] === 'Yes' ? true : m[2] === 'No' ? false : Number(m[2]);
  return o;
}

/** ioreg -rn AppleSmartBattery: health, cycles, temperature, watts, adapter */
export function parseSmartBattery(s) {
  if (!/AppleSmartBattery|CycleCount/.test(s)) return null;
  const p = ioregProps(s);
  if (p.CurrentCapacity == null) return null;
  const ad = ioregDict(/"AdapterDetails" = (\{[^\n]*\})/.exec(s)?.[1]);
  const signed = x => (x > 2 ** 31 && x < 2 ** 32 ? x - 2 ** 32 : x);
  const amp = signed(Number(p.InstantAmperage ?? p.Amperage ?? 0)), volt = Number(p.Voltage || 0);
  const design = Number(p.DesignCapacity) || null, rawMax = Number(p.AppleRawMaxCapacity || p.NominalChargeCapacity) || null;
  const health = design && rawMax ? Math.round(rawMax / design * 1000) / 10 : null;
  const ac = !!p.ExternalConnected, charging = !!p.IsCharging, full = !!p.FullyCharged;
  const tr = Number(p.TimeRemaining);
  const temp = Number(p.Temperature);
  return {
    pct: Number(p.CurrentCapacity), ac, charging, full, state: full ? 'penuh' : charging ? 'mengisi' : ac ? 'terhubung' : 'baterai',
    remainingMin: tr > 0 && tr < 65535 ? tr : null, cycles: p.CycleCount ?? null, designCycles: p.DesignCycleCount9C ?? 1000,
    health, condition: p.PermanentFailureStatus ? 'servis' : health == null ? null : health >= 80 ? 'normal' : 'servis disarankan',
    capacityMah: rawMax, designMah: design, tempC: temp > 0 ? Math.round(temp / 10) / 10 : null,
    watts: volt ? r1(amp * volt / 1e6) : null, voltage: volt ? r2(volt / 1000) : null,
    adapter: ac && (ad.Watts || ad.Name) ? { watts: ad.Watts ?? null, name: (ad.Name || ad.Description || '').trim() || null } : null };
}

export function parseTherm(s) {
  const lvl = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(s);
  const warn = /thermal warning level[^\n]*?(\d+)/i.exec(s);
  const none = /No thermal warning level has been recorded/i.test(s);
  return { speedLimit: lvl ? Number(lvl[1]) : null, state: none ? 'normal' : warn ? (Number(warn[1]) === 0 ? 'normal' : 'panas') : (lvl && Number(lvl[1]) < 100 ? 'dibatasi' : 'normal') };
}

/** ioreg -r -c IOAccelerator: GPU busy % and memory in use (Apple Silicon, no sudo) */
export function parseGpu(s) {
  const d = ioregDict(/"PerformanceStatistics" = (\{[^\n]*\})/.exec(s)?.[1]);
  if (d['Device Utilization %'] == null) return null;
  return { util: d['Device Utilization %'], renderer: d['Renderer Utilization %'] ?? null, tiler: d['Tiler Utilization %'] ?? null,
    mem: d['In use system memory'] ?? null, alloc: d['Alloc system memory'] ?? null,
    name: /"model" = "([^"]+)"/.exec(s)?.[1] || null, cores: Number(/"gpu-core-count" = (\d+)/.exec(s)?.[1]) || null };
}

/** ioreg -r -c IOBlockStorageDriver: cumulative bytes/ops summed over drives */
export function parseDiskIO(s) {
  let rb = 0, wb = 0, ro = 0, wo = 0, n = 0;
  for (const m of s.matchAll(/"Statistics" = (\{[^\n]*\})/g)) {
    const d = ioregDict(m[1]);
    rb += d['Bytes (Read)'] || 0; wb += d['Bytes (Write)'] || 0; ro += d['Operations (Read)'] || 0; wo += d['Operations (Write)'] || 0; n++;
  }
  return n ? { rb, wb, ro, wo } : null;
}

const SKIP_IF = /^(lo|gif|stf|anpi|bridge|utun|awdl|llw|ap\d|XHC|vmenet|ipsec)/;
/** netstat -ibn: bytes on the <Link#> rows of real interfaces, plus their IPv4 address. */
export function parseNetstat(s) {
  let rx = 0, tx = 0;
  const ifaces = {};
  for (const line of s.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[0].replace(/\*$/, '');
    if (SKIP_IF.test(name)) continue;
    if (/^<Link#/.test(f[2])) {
      const ib = Number(f[f.length - 5]), ob = Number(f[f.length - 2]);
      if (!Number.isFinite(ib) || !Number.isFinite(ob)) continue;
      rx += ib; tx += ob;
      ifaces[name] = { ...(ifaces[name] || {}), rx: ib, tx: ob };
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(f[3]) && ifaces[name]) ifaces[name].ip = f[3];
  }
  return { rx, tx, ifaces };
}

/** Group a raw executable name into an app: "Google Chrome Helper (Renderer)" → "Google Chrome" */
export function appName(n) {
  return n.replace(/ Helper( \([^)]*\))?$/, '').replace(/ \([^)]*\)$/, '').replace(/^com\.apple\./, '') || n;
}
export const AGENT_RE = { claude: /^claude$|^claude-/i, codex: /^codex/i, node: /^node$/i, tmux: /^tmux/i };
export function agentKind(n) { for (const k in AGENT_RE) if (AGENT_RE[k].test(n)) return k; return null; }

/** ps -Aceo pid,pcpu,rss,comm (ppid optional, 5 columns) */
export function parsePs(s, n = 8) {
  const rows = [];
  for (const line of s.split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+(?:(\d+)\s+)?([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: m[2] != null ? Number(m[2]) : null, cpu: Number(m[3]), rss: Number(m[4]) * 1024, name: m[5].trim() });
  }
  const byCpu = [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, n);
  const byRam = [...rows].sort((a, b) => b.rss - a.rss).slice(0, n);
  const g = new Map();
  const agents = { cpu: 0, rss: 0, n: 0, kinds: {} };
  for (const r of rows) {
    const a = appName(r.name);
    const e = g.get(a) || { name: a, cpu: 0, rss: 0, n: 0, procs: [] };
    e.cpu += r.cpu; e.rss += r.rss; e.n++; e.procs.push(r);
    g.set(a, e);
    const k = agentKind(r.name);
    if (k) {
      const kk = agents.kinds[k] || (agents.kinds[k] = { cpu: 0, rss: 0, n: 0 });
      kk.cpu += r.cpu; kk.rss += r.rss; kk.n++;
      agents.cpu += r.cpu; agents.rss += r.rss; agents.n++;
      r.agent = k;
    }
  }
  const groups = [...g.values()].map(e => ({ name: e.name, cpu: r1(e.cpu), rss: e.rss, n: e.n, agent: agentKind(e.name),
    procs: e.procs.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss).slice(0, 12).map(p => ({ pid: p.pid, cpu: p.cpu, rss: p.rss, name: p.name })) }));
  agents.cpu = r1(agents.cpu);
  for (const k in agents.kinds) agents.kinds[k].cpu = r1(agents.kinds[k].cpu);
  return { byCpu, byRam, count: rows.length, groups, agents, rows };
}

/** nettop -P -L 1 -J bytes_in,bytes_out -x: cumulative bytes per process ("name.pid,in,out,") */
export function parseNettop(s) {
  const out = [];
  for (const l of s.split('\n')) {
    const m = /^(.*)\.(\d+),(\d+),(\d+),?$/.exec(l.trim());
    if (m) out.push({ pid: Number(m[2]), name: m[1], rin: Number(m[3]), rout: Number(m[4]) });
  }
  return out;
}

/** ioreg -r -c IOAccelerator -l: accumulated GPU ns per client pid */
export function parseGpuClients(s) {
  const by = new Map();
  for (const b of s.split(/\+-o /)) {
    const cr = /"IOUserClientCreator" = "pid (\d+), ([^"]*)"/.exec(b);
    if (!cr) continue;
    let ns = 0;
    for (const m of b.matchAll(/"accumulatedGPUTime"=(\d+)/g)) ns += Number(m[1]);
    const pid = Number(cr[1]);
    const e = by.get(pid) || { pid, name: cr[2], ns: 0 };
    e.ns += ns;
    by.set(pid, e);
  }
  return [...by.values()];
}

/** top -l 2 -stats pid,command,power: header counts + the second (real) sample's energy impact */
export function parseTopPower(s) {
  const parts = s.split(/^PID\s+COMMAND\s+POWER\s*$/m);
  const rows = [];
  for (const l of (parts[parts.length - 1] || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s+([\d.]+)\s*$/.exec(l);
    if (m && parts.length > 1) rows.push({ pid: Number(m[1]), name: m[2], power: Number(m[3]) });
  }
  const heads = s.split(/(?=Processes:)/).filter(x => x.startsWith('Processes:'));
  return { counts: parseTopHead(heads[heads.length - 1] || ''), rows };
}

/** sum per app, top n: [{name, value, n}] */
export function topApps(rows, key, n = 5) {
  const g = new Map();
  for (const r of rows) {
    if (!(r[key] > 0)) continue;
    const a = appName(r.name);
    const e = g.get(a) || { name: a, value: 0, n: 0 };
    e.value += r[key]; e.n++;
    g.set(a, e);
  }
  return [...g.values()].sort((a, b) => b.value - a.value).slice(0, n).map(e => ({ ...e, value: Math.round(e.value * 10) / 10 }));
}

/** top -l 1 -n 0 header: process/thread counts */
export function parseTopHead(s) {
  const m = /Processes:\s*(\d+) total(?:, (\d+) running)?.*?(\d+) threads/.exec(s);
  return m ? { procs: Number(m[1]), running: m[2] ? Number(m[2]) : null, threads: Number(m[3]) } : null;
}

export function parseConns(s) {
  let est = 0, listen = 0;
  for (const l of s.split('\n')) { if (/ESTABLISHED/.test(l)) est++; else if (/LISTEN/.test(l)) listen++; }
  return { established: est, listen };
}

/** ipconfig getsummary <if>: SSID unless macOS redacted it */
export function parseWifi(s) {
  const ssid = /^\s*SSID : (.+)$/m.exec(s)?.[1]?.trim();
  if (!ssid) return null;
  return { ssid: /redacted/i.test(ssid) ? null : ssid, security: /^\s*Security : (.+)$/m.exec(s)?.[1]?.trim() || null };
}

/* ---------------- exec without overlap ---------------- */

const running = new Set();
let execMs = 0;
function run(cmd, args, timeout = 3000) {
  const key = cmd + ' ' + args.join(' ');
  if (running.has(key)) return Promise.resolve(null);
  running.add(key);
  const t0 = performance.now();
  return new Promise(res => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (e, out) => {
      running.delete(key);
      execMs += performance.now() - t0;
      res(e && !(out && String(out).trim() && e.code !== 'ETIMEDOUT' && !e.killed) ? null : String(out));
    });
  });
}

/* ---------------- history: Float32 rings (1h raw + 24h of 1-min means) ---------------- */

export const SERIES = ['cpu', 'user', 'sys', 'ram', 'swap', 'comp', 'rx', 'tx', 'dr', 'dw', 'gpu', 'batt', 'agents', 'load', 'score'];

class Ring {
  constructor(cap, names) { this.cap = cap; this.n = 0; this.i = 0; this.t = new Float64Array(cap); this.s = {}; for (const k of names) this.s[k] = new Float32Array(cap).fill(NaN); }
  push(t, v) {
    this.t[this.i] = t;
    for (const k in this.s) this.s[k][this.i] = v[k] == null ? NaN : v[k];
    this.i = (this.i + 1) % this.cap; this.n = Math.min(this.n + 1, this.cap);
  }
  ensure(k) { if (!this.s[k]) this.s[k] = new Float32Array(this.cap).fill(NaN); }
  read(from, keys, maxPts) {
    const idx = [];
    for (let j = 0; j < this.n; j++) { const k = (this.i - this.n + j + this.cap) % this.cap; if (this.t[k] >= from) idx.push(k); }
    const bucket = Math.max(1, Math.ceil(idx.length / Math.max(10, maxPts || idx.length || 1)));
    const out = { t: [] };
    for (const k of keys) out[k] = [];
    for (let b = 0; b < idx.length; b += bucket) {
      const sl = idx.slice(b, b + bucket);
      out.t.push(this.t[sl[sl.length - 1]]);
      for (const k of keys) {
        const a = this.s[k];
        if (!a) { out[k].push(null); continue; }
        let sum = 0, c = 0;
        for (const q of sl) if (!Number.isNaN(a[q])) { sum += a[q]; c++; }
        out[k].push(c ? Math.round(sum / c * 100) / 100 : null);
      }
    }
    return out;
  }
}

let raw = null, day = null, minAcc = null;
function rings() {
  const c = conf(), cap = Math.max(10, Math.round(c.historyMin * 60 / Math.max(1, c.intervalSec)));
  const cores = os.cpus().length, names = [...SERIES, ...Array.from({ length: cores }, (_, i) => `c${i}`)];
  if (!raw || raw.cap !== cap) raw = new Ring(cap, names);
  if (!day) day = new Ring(1440, names);
  return raw;
}
function pushHist(t, v) {
  rings().push(t, v);
  const m = Math.floor(t / 60e3);
  if (minAcc && minAcc.m !== m) {
    const avg = {};
    for (const k in minAcc.sum) avg[k] = minAcc.c[k] ? minAcc.sum[k] / minAcc.c[k] : null;
    day.push(minAcc.m * 60e3 + 59e3, avg);
    minAcc = null;
  }
  if (!minAcc) minAcc = { m, sum: {}, c: {} };
  for (const k in v) if (v[k] != null && Number.isFinite(v[k])) { minAcc.sum[k] = (minAcc.sum[k] || 0) + v[k]; minAcc.c[k] = (minAcc.c[k] || 0) + 1; }
}

/** history(min, {series, points}) → {t[], step, <series>[]} parallel arrays; >60 min reads the 24h 1-min ring */
export function history(min = 60, { series, points } = {}) {
  rings();
  min = Math.max(1, Math.min(1440, Number(min) || 60));
  const keys = series?.length ? series.filter(k => SERIES.includes(k) || k === 'cores' || /^c\d+$/.test(k)) : ['cpu', 'ram', 'rx', 'tx', 'load'];
  const ks = keys.flatMap(k => (k === 'cores' ? Object.keys(raw.s).filter(x => /^c\d+$/.test(x)) : [k]));
  const useDay = min > conf().historyMin;
  const out = (useDay ? day : raw).read(Date.now() - min * 60e3, ks, points);
  out.step = useDay ? 60 : conf().intervalSec;
  out.min = min;
  return out;
}

/* ---------------- events log ---------------- */

const EVENTS_MAX = 200;
const events = [];
function logEvent(kind, level, text, now = Date.now()) {
  events.push({ at: now, kind, level, text });
  if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
}
export function eventsList(limit = 100) { return events.slice(-limit).reverse(); }

/* ---------------- health score ---------------- */

export function healthScore(s, limits = DEFAULTS.alerts) {
  let score = 100;
  const reasons = [];
  const hit = (pts, text, level = 'warn') => { if (pts >= 1) { score -= pts; reasons.push({ text, pts: Math.round(pts), level }); } };
  if (s.cpu != null && s.cpu > 70) hit((s.cpu - 70) * 0.8, `CPU sibuk ${Math.round(s.cpu)}%`, s.cpu >= limits.cpu ? 'bad' : 'warn');
  if (s.load != null && s.cores && s.load > s.cores * 1.5) hit(Math.min(15, (s.load / s.cores - 1.5) * 10), `Beban ${s.load.toFixed(1)} untuk ${s.cores} core`);
  if (s.pressure === 'waspada') hit(15, 'Tekanan memori waspada');
  if (s.pressure === 'kritis') hit(35, 'Tekanan memori kritis', 'bad');
  if (s.ram != null && s.ram > 85) hit((s.ram - 85) * 1.2, `RAM terpakai ${Math.round(s.ram)}%`);
  if (s.swapPct != null && s.swapPct > 50) hit((s.swapPct - 50) * 0.3, `Swap ${Math.round(s.swapPct)}% terpakai`);
  if (s.swapRate != null && s.swapRate > 50) hit(Math.min(15, s.swapRate / 20), `Swap aktif ${Math.round(s.swapRate)} hal/dtk`);
  if (s.diskPct != null && s.diskPct > 85) hit((s.diskPct - 85) * 2, `Disk ${Math.round(s.diskPct)}% penuh`, s.diskPct >= limits.disk ? 'bad' : 'warn');
  if (s.thermal && s.thermal !== 'normal') hit(20, `Termal ${s.thermal}`, 'bad');
  if (s.battHealth != null && s.battHealth < 80) hit(5, `Kesehatan baterai ${s.battHealth}%`);
  if (s.battPct != null && !s.ac && s.battPct < 20) hit(10, `Baterai tinggal ${s.battPct}%`, 'bad');
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, status: score >= 80 ? 'baik' : score >= 55 ? 'waspada' : 'buruk', reasons: reasons.sort((a, b) => b.pts - a.pts) };
}

/* ---------------- state ---------------- */

const MAC = process.platform === 'darwin';
let lastSeen = 0, timer = null, prevCpu = null, prev = {}, ticking = false, osVersion = null, sysInfo = null, gpuName = null;
const due = {};
const st = { cpu: null, cpuSplit: null, cores: [], mem: null, memx: null, disks: [], diskio: null, battery: null, thermal: null, net: null, gpu: null,
  procs: null, agents: null, top: {}, pidName: new Map(), counts: null, conns: null, wifi: null, users: null, health: null, at: 0, tickMs: 0, self: null };
const alertState = {}; // key -> { since, firedAt }
export const alertsActive = new Map(); // key -> { key, label, value, since }
const cost = { ticks: 0, ms: 0, cpuUs: 0, since: Date.now(), cpu0: process.cpuUsage() };

function cpuSample() {
  const cpus = os.cpus();
  const cur = cpus.map(c => { const t = c.times; return { user: t.user + t.nice, sys: t.sys + t.irq, idle: t.idle }; });
  let res = null;
  if (prevCpu && prevCpu.length === cur.length) {
    let tu = 0, ts = 0, ti = 0;
    const cores = cur.map((c, i) => {
      const du = c.user - prevCpu[i].user, ds = c.sys - prevCpu[i].sys, di = c.idle - prevCpu[i].idle, dt = du + ds + di;
      tu += du; ts += ds; ti += di;
      return dt > 0 ? r1((du + ds) / dt * 100) : 0;
    });
    const tt = tu + ts + ti;
    res = tt > 0 ? { total: r1((tu + ts) / tt * 100), user: r1(tu / tt * 100), sys: r1(ts / tt * 100), idle: r1(ti / tt * 100), cores } : null;
  }
  prevCpu = cur;
  return res;
}

const isDue = (k, sec, now) => { if (now - (due[k] || 0) >= sec * 1000 - 500) { due[k] = now; return true; } return false; };
const rate = (key, cur, now, fields) => {
  const p = prev[key];
  prev[key] = { ...cur, at: now };
  if (!p) return null;
  const dt = (now - p.at) / 1000;
  if (dt <= 0) return null;
  const o = {};
  for (const f of fields) o[f] = Math.max(0, Math.round((cur[f] - p[f]) / dt));
  return o;
};

export function touch() {
  const was = isActive();
  lastSeen = Date.now();
  if (!was) schedule(0);
}
export function isActive() { return Date.now() - lastSeen < conf().activeSec * 1000; }

async function tick() {
  if (ticking) return;
  ticking = true;
  const t0 = performance.now(), now = Date.now(), active = isActive();
  try {
    const c = cpuSample();
    if (c) { st.cpu = c.total; st.cores = c.cores; st.cpuSplit = { user: c.user, sys: c.sys, idle: c.idle }; }
    const jobs = [];
    if (MAC) {
      if (!sysInfo) jobs.push(run('sysctl', ['hw.model', 'machdep.cpu.brand_string', 'kern.boottime', 'hw.memsize', 'hw.cpufrequency_max', 'hw.cpufrequency',
        ...[0, 1, 2].flatMap(i => [`hw.perflevel${i}.logicalcpu`, `hw.perflevel${i}.name`])]).then(o => { sysInfo = o ? parseSysInfo(o) : {}; }));
      if (!osVersion) jobs.push(run('sw_vers', ['-productVersion']).then(o => { osVersion = o ? `macOS ${o.trim()}` : `${os.type()} ${os.release()}`; }));
      // rate probes only while watched (idle ticks would just be 60 s averages); prev reset so the first watched tick isn't a huge window
      if (active) {
        jobs.push(run('netstat', ['-ibn']).then(o => {
          if (!o) return;
          const n = parseNetstat(o);
          const r = rate('net', n, now, ['rx', 'tx']);
          const ifs = {};
          const pif = prev.netIf || {};
          for (const [k, v] of Object.entries(n.ifaces)) {
            const p = pif[k], dt = prev.netIfAt ? (now - prev.netIfAt) / 1000 : 0;
            if (!v.ip && !(v.rx || v.tx)) continue;
            ifs[k] = { ip: v.ip || null, rx: p && dt > 0 ? Math.max(0, Math.round((v.rx - p.rx) / dt)) : 0, tx: p && dt > 0 ? Math.max(0, Math.round((v.tx - p.tx) / dt)) : 0, rxTotal: v.rx, txTotal: v.tx };
          }
          prev.netIf = n.ifaces; prev.netIfAt = now;
          st.net = { ...(st.net || {}), rx: r?.rx ?? 0, tx: r?.tx ?? 0, rxTotal: n.rx, txTotal: n.tx, ifaces: ifs };
        }));
        jobs.push(run('ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-d', '1']).then(o => {
          const d = o && parseDiskIO(o);
          if (!d) return;
          const r = rate('dio', d, now, ['rb', 'wb', 'ro', 'wo']);
          st.diskio = { read: r?.rb ?? 0, write: r?.wb ?? 0, rIops: r?.ro ?? 0, wIops: r?.wo ?? 0, readTotal: d.rb, writeTotal: d.wb };
        }));
        jobs.push(run('ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1']).then(o => { const g = o && parseGpu(o); if (g) { gpuName = g.name || gpuName; st.gpu = g; } }));
        if (isDue('procs', 10, now)) jobs.push(sampleProcs(now));
        if (isDue('conns', 60, now)) jobs.push(run('netstat', ['-an', '-p', 'tcp']).then(o => { if (o) st.conns = parseConns(o); }));
        if (isDue('route', 60, now)) jobs.push(run('route', ['-n', 'get', 'default']).then(async o => {
          const iface = o && /interface: (\S+)/.exec(o)?.[1];
          if (st.net) st.net.active = iface || null;
          if (iface && /^en/.test(iface)) { const w = await run('ipconfig', ['getsummary', iface]); st.wifi = w ? parseWifi(w) : null; } else st.wifi = null;
        }));
        // energy impact needs two top samples (~0.8 s CPU) → only every 5 min; it also gives the thread count
        if (isDue('top', 300, now)) jobs.push(run('top', ['-l', '2', '-n', '10', '-o', 'power', '-stats', 'pid,command,power', '-s', '1'], 8000).then(o => {
          if (!o) return;
          const t = parseTopPower(o);
          if (t.counts) st.counts = t.counts;
          st.top.power = topApps(t.rows.map(r => ({ ...r, name: st.pidName.get(r.pid) || r.name })), 'power');
          st.topAt = { ...(st.topAt || {}), power: now };
        }));
        if (isDue('pnet', 10, now)) jobs.push(run('nettop', ['-P', '-L', '1', '-J', 'bytes_in,bytes_out', '-x'], 9000).then(o => {
          if (!o) return;
          const rows = parseNettop(o), p = prev.pnet, dt = p ? (now - p.at) / 1000 : 0;
          if (p && dt > 0) {
            const r = rows.map(x => { const q = p.m.get(x.pid); return { name: st.pidName.get(x.pid) || x.name, rx: q ? Math.max(0, (x.rin - q.rin) / dt) : 0, tx: q ? Math.max(0, (x.rout - q.rout) / dt) : 0 }; })
              .map(x => ({ ...x, net: x.rx + x.tx }));
            const top = topApps(r, 'net');
            for (const e of top) { e.rx = Math.round(r.filter(x => appName(x.name) === e.name).reduce((a, x) => a + x.rx, 0)); e.tx = Math.round(r.filter(x => appName(x.name) === e.name).reduce((a, x) => a + x.tx, 0)); e.value = Math.round(e.value); }
            st.top.net = top;
          }
          prev.pnet = { at: now, m: new Map(rows.map(x => [x.pid, x])) };
        }));
        if (isDue('pgpu', 10, now)) jobs.push(run('ioreg', ['-r', '-c', 'IOAccelerator', '-l']).then(o => {
          if (!o) return;
          const rows = parseGpuClients(o), p = prev.pgpu, dt = p ? (now - p.at) / 1000 : 0;
          if (p && dt > 0) st.top.gpu = topApps(rows.map(x => { const q = p.m.get(x.pid); return { name: st.pidName.get(x.pid) || x.name, gpu: q ? Math.max(0, (x.ns - q.ns) / 1e7 / dt) : 0 }; }), 'gpu');
          prev.pgpu = { at: now, m: new Map(rows.map(x => [x.pid, x])) };
        }));
        if (isDue('users', 300, now)) jobs.push(run('who', []).then(o => { if (o) st.users = [...new Set(o.split('\n').filter(Boolean).map(l => l.split(/\s+/)[0]))]; }));
      } else { delete prev.pnet; delete prev.pgpu; delete prev.net; delete prev.dio; delete prev.netIf; delete prev.netIfAt; delete prev.vm; }
      if (isDue('mem', 10, now)) jobs.push(Promise.all([run('vm_stat', []), run('sysctl', ['vm.swapusage', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'])]).then(([v, s]) => {
        const vm = v ? parseVmStat(v) : null, sy = s ? parseSysctl(s) : {};
        const r = vm && active ? rate('vm', vm, now, ['pageins', 'pageouts', 'swapins', 'swapouts']) : null;
        st.memx = { vm, ...sy, rates: r || st.memx?.rates || null };
      }));
      if (isDue('disk', 60, now)) jobs.push(run('df', ['-kl']).then(o => { if (o) st.disks = parseDf(o); }));
      if (isDue('batt', 30, now)) jobs.push(run('ioreg', ['-rn', 'AppleSmartBattery']).then(o => { st.battery = o ? parseSmartBattery(o) : st.battery; }));
      if (isDue('therm', 60, now)) jobs.push(run('pmset', ['-g', 'therm']).then(o => { if (o) st.thermal = parseTherm(o); }));
    } else {
      if (!osVersion) osVersion = `${os.type()} ${os.release()}`;
      if (active && isDue('procs', 10, now)) jobs.push(sampleProcs(now));
    }
    await Promise.all(jobs);
    const total = os.totalmem();
    const vm = st.memx?.vm;
    // Activity Monitor style: app = anonymous - purgeable, used = app + wired + compressed, cached = file-backed + purgeable
    const app = vm ? Math.max(0, vm.anon - vm.purgeable) : null;
    const used = vm ? Math.min(total, app + vm.wired + vm.compressed) : total - os.freemem();
    st.mem = { total, used, free: total - used, pct: r1(used / total * 100), app, cached: vm ? vm.file + vm.purgeable : null,
      compressed: vm ? vm.compressed : null, wired: vm ? vm.wired : null, unused: vm ? vm.free + vm.speculative : null,
      pressure: st.memx?.pressure || null, freePct: st.memx?.freePct ?? null, swap: st.memx?.swap || null, rates: st.memx?.rates || null };
    const la = os.loadavg();
    const swapPct = st.mem.swap?.total ? st.mem.swap.used / st.mem.swap.total * 100 : null;
    const mainDisk = st.disks.find(d => d.mount === '/System/Volumes/Data' || d.mount === '/') || st.disks[0];
    st.health = healthScore({ cpu: st.cpu, load: la[0], cores: os.cpus().length, pressure: st.mem.pressure, ram: st.mem.pct, swapPct,
      swapRate: st.mem.rates ? st.mem.rates.swapins + st.mem.rates.swapouts : null, diskPct: mainDisk?.pct, thermal: st.thermal?.state,
      battHealth: st.battery?.health, battPct: st.battery?.pct, ac: st.battery?.ac ?? true }, conf().alerts);
    trackChanges(now);
    st.at = now;
    const hv = { cpu: st.cpu, user: st.cpuSplit?.user, sys: st.cpuSplit?.sys, ram: st.mem.pct, swap: st.mem.swap ? st.mem.swap.used / 1048576 : null,
      comp: st.mem.compressed != null ? st.mem.compressed / 1048576 : null, rx: active ? st.net?.rx ?? null : null, tx: active ? st.net?.tx ?? null : null,
      dr: active ? st.diskio?.read ?? null : null, dw: active ? st.diskio?.write ?? null : null, gpu: active ? st.gpu?.util ?? null : null,
      batt: st.battery?.pct ?? null, agents: active ? st.agents?.cpu ?? null : null, load: r2(la[0]), score: st.health.score };
    st.cores.forEach((v, i) => { hv[`c${i}`] = v; });
    pushHist(now, hv);
    checkAlerts(now);
    st.tickMs = r1(performance.now() - t0);
    cost.ticks++; cost.ms += st.tickMs;
    if (active) bus.emit('msg', { t: 'sysmon', ...brief() });
  } catch (e) {
    console.error('sysmon:', e.message);
  } finally {
    ticking = false;
  }
}

async function sampleProcs(now) {
  const o = await run('ps', ['-Aceo', 'pid,ppid,pcpu,rss,comm', '-r'], 4000);
  if (!o) return;
  const p = parsePs(o);
  st.pidName = new Map(p.rows.map(r => [r.pid, r.name]));
  st.top.cpu = topApps(p.rows, 'cpu');
  st.top.ram = topApps(p.rows, 'rss');
  delete p.rows;
  st.procs = { at: now, ...p };
  st.agents = p.agents;
}

const lastSeenState = {};
function trackChanges(now) {
  const ch = (key, val, fmt) => {
    if (val == null) return;
    const was = lastSeenState[key];
    lastSeenState[key] = val;
    if (was !== undefined && was !== val) { const [lvl, text] = fmt(val, was); logEvent(key, lvl, text, now); }
  };
  ch('pressure', st.mem?.pressure, v => [v === 'normal' ? 'ok' : v === 'kritis' ? 'bad' : 'warn', `Tekanan memori ${v}`]);
  ch('thermal', st.thermal?.state, v => [v === 'normal' ? 'ok' : 'bad', `Termal ${v}`]);
  ch('ac', st.battery ? st.battery.ac : null, v => ['info', v ? 'Charger dicolok' : 'Charger dicabut, pakai baterai']);
  ch('health', st.health?.status, (v, w) => [v === 'baik' ? 'ok' : v === 'buruk' ? 'bad' : 'warn', `Kesehatan ${w} → ${v} (${st.health.score})`]);
  if (st.battery && !st.battery.ac) ch('battLow', st.battery.pct <= 10 ? 'kritis' : st.battery.pct <= 20 ? 'rendah' : 'ok', v => [v === 'ok' ? 'ok' : 'bad', `Baterai ${v === 'ok' ? 'aman' : v} (${st.battery.pct}%)`]);
}

function checkAlerts(now) {
  const a = conf().alerts;
  const swapPct = st.mem?.swap?.total ? st.mem.swap.used / st.mem.swap.total * 100 : null;
  const checks = [
    ['cpu', 'CPU', st.cpu, a.cpu, '%'],
    ['ram', 'RAM', st.mem?.pct, a.ram, '%'],
    ['swap', 'Swap', swapPct, a.swapPct, '%'],
    ...st.disks.map(d => [`disk:${d.mount}`, `Disk ${d.name}`, d.pct, a.disk, '%']),
    ['tempC', 'Suhu', null, a.tempC, '°C'],
    ['thermal', 'Termal', st.thermal && st.thermal.state !== 'normal' ? 1 : 0, st.thermal ? 0.5 : null, ''],
  ];
  for (const [key, label, val, lim, unit] of checks) {
    const s = alertState[key] || (alertState[key] = { since: 0, firedAt: 0 });
    if (val == null || lim == null || !(val > lim)) {
      if (s.since) logEvent(`alert:${key}`, 'ok', `${label} kembali normal`, now);
      s.since = 0; alertsActive.delete(key); continue;
    }
    const v = r1(val);
    if (!s.since) { s.since = now; if (key !== 'thermal') logEvent(`alert:${key}`, 'warn', `${label} ${v}${unit} melewati batas ${lim}${unit}`, now); }
    alertsActive.set(key, { key, label, value: v, limit: lim, since: s.since, sustained: now - s.since >= a.sustainSec * 1000 });
    if (now - s.since >= a.sustainSec * 1000 && now - s.firedAt >= a.cooldownMin * 60e3) {
      s.firedAt = now;
      const text = key === 'thermal' ? `Mac kepanasan (${st.thermal.state}${st.thermal.speedLimit != null ? `, CPU dibatasi ${st.thermal.speedLimit}%` : ''})` : `${label} ${v}${unit} melewati batas ${lim}${unit} selama ${Math.round((now - s.since) / 1000)} detik`;
      console.log(`sysmon peringatan: ${text}`);
      logEvent(`push:${key}`, 'bad', `Peringatan dikirim: ${text}`, now);
      pushGhina({ kind: 'sysmon', dedupe: key, who: `Performa PC: ${label}`, text }).catch(() => {});
    }
  }
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await tick();
    const c = conf();
    schedule((isActive() ? c.intervalSec : c.idleSec) * 1000);
  }, ms);
  timer.unref?.();
}

export function startSysmon() {
  if (!conf().enabled) return;
  logEvent('start', 'info', 'Pemantau dimulai');
  schedule(1000);
}
export function stopSysmon() { clearTimeout(timer); timer = null; }

/** own overhead: daemon-wide CPU % since start and sampler time per tick */
export function costInfo() {
  const u = process.cpuUsage(cost.cpu0), wall = (Date.now() - cost.since) * 1000;
  return { ticks: cost.ticks, avgTickMs: cost.ticks ? r1(cost.ms / cost.ticks) : null, execMs: Math.round(execMs), daemonCpuPct: wall ? r2((u.user + u.system) / wall * 100) : null };
}

const alertsList = () => [...alertsActive.values()];
/** small payload for the live broadcast */
export function brief() {
  const la = os.loadavg();
  return { at: st.at, cpu: st.cpu, split: st.cpuSplit, cores: st.cores, load: la.map(r2),
    mem: st.mem && { pct: st.mem.pct, used: st.mem.used, total: st.mem.total, app: st.mem.app, wired: st.mem.wired, compressed: st.mem.compressed, cached: st.mem.cached,
      pressure: st.mem.pressure, swapUsed: st.mem.swap?.used ?? null, rates: st.mem.rates },
    net: st.net && { rx: st.net.rx, tx: st.net.tx }, disk: st.diskio && { read: st.diskio.read, write: st.diskio.write, rIops: st.diskio.rIops, wIops: st.diskio.wIops },
    gpu: st.gpu && { util: st.gpu.util, mem: st.gpu.mem }, batt: st.battery && { pct: st.battery.pct, charging: st.battery.charging, ac: st.battery.ac, watts: st.battery.watts },
    agents: st.agents && { cpu: st.agents.cpu, rss: st.agents.rss, n: st.agents.n }, health: st.health && { score: st.health.score, status: st.health.status }, top: st.top, alerts: alertsList() };
}

export async function snapshot({ histMin = 10, series } = {}) {
  touch();
  if (!st.at) await tick();
  const si = sysInfo || {};
  const cpus = os.cpus();
  return { enabled: conf().enabled, host: os.hostname(), os: osVersion, arch: os.arch(), model: si.model || null, chip: si.chip || cpus[0]?.model || null,
    uptimeSec: Math.round(os.uptime()), bootAt: si.bootAt || Date.now() - os.uptime() * 1000, users: st.users,
    at: st.at, intervalSec: conf().intervalSec, active: isActive(), tickMs: st.tickMs, cost: costInfo(),
    cpu: { total: st.cpu, ...(st.cpuSplit || {}), cores: st.cores, count: cpus.length, levels: si.levels || [], freqMHz: si.freqMHz ?? (cpus[0]?.speed || null) },
    load: os.loadavg().map(r2), counts: st.counts,
    mem: st.mem, disks: st.disks, diskio: st.diskio, net: st.net && { ...st.net, conns: st.conns, wifi: st.wifi }, battery: st.battery, thermal: st.thermal,
    gpu: st.gpu ? { ...st.gpu, name: st.gpu.name || gpuName } : null, tempC: st.battery?.tempC ?? null, fan: null,
    agents: st.agents, top: st.top, health: st.health, alerts: alertsList(), events: eventsList(20), limits: conf().alerts,
    history: history(histMin, { series }) };
}

let procsAt = 0, procsP = null;
export async function procs({ all = false } = {}) {
  touch();
  if (!(Date.now() - procsAt < 5e3 && st.procs)) {
    if (!procsP) procsP = (async () => {
      if (MAC || process.platform === 'linux') await sampleProcs(Date.now());
      procsAt = Date.now();
    })().finally(() => { procsP = null; });
    await procsP;
  }
  const p = st.procs || { at: 0, byCpu: [], byRam: [], count: 0, groups: [], agents: null };
  const groups = [...(p.groups || [])].sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
  return { ...p, top: st.top, counts: st.counts, groups: all ? groups : groups.filter((g, i) => i < 60 || g.agent) };
}

export const _test = { tick, st, events, logEvent, reset() { raw = null; day = null; minAcc = null; prevCpu = null; prev = {}; for (const k in alertState) delete alertState[k]; alertsActive.clear(); events.length = 0; } };
