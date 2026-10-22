import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = os.homedir();
export const DATA_DIR = process.env.KANTOR_HOME || path.join(HOME, '.kantor-claude');
export const OFFICE_DIR = path.join(DATA_DIR, 'offices');
export const RUN_DIR = path.join(DATA_DIR, 'run');
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const ROOT_DIR = path.resolve(import.meta.dirname, '..');
export const SERVER_JSON = path.join(DATA_DIR, 'server.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  port: 4317,
  host: '127.0.0.1',
  // Extra addresses to listen on, e.g. a Tailscale IP. Never 0.0.0.0 by default.
  extraHosts: [],
  roots: [path.join(HOME, 'Developer')],
  token: null,
  // How long a PermissionRequest hook waits for a decision from the inbox before
  // falling back to the normal prompt in the terminal.
  approvals: { holdKantorSec: 90, holdManualSec: 0 },
  // permission mode for shifts started from the office ('' = follow Claude Code's own setting)
  defaultPermissionMode: '',
  idleHomeHours: 0,
  payroll: { scanDays: 60, currency: 'USD' },
  claudeBin: 'claude',
  // folder scanned by the office music player ("Folder musikmu")
  musicDir: path.join(HOME, 'Music'),
  // Optional HTTPS listener, e.g. on the Tailscale IP with a real domain pointing at it:
  // { host: '100.x.y.z', port: 443, cert: '/path/fullchain.crt', key: '/path/key', names: ['office.example.com'] }
  tls: null,
  // Push to Ghina when something needs you: url = https://<ghina>/api/kantor/notify, token = its KANTOR_NOTIFY_TOKEN.
  // The token stays in config.json (never in the repo). Off unless enabled and both url and token are set.
  // events: permission (new inbox item), question (agent asks), meeting (rapat done/failed)
  // file (agent sent a file to the owner) is on unless ghinaNotify.file is false, whatever the events list says
  // office location for prayer times (Kemenag method): tz is an IANA zone
  location: { name: 'Jakarta', lat: -6.2, lng: 106.8, tz: 'Asia/Jakarta' },
  // attachments in the agent chat: maxBytes per file, chunkBytes = suggested upload chunk, staleHours = drop unfinished uploads after
  attachments: { maxBytes: 4 * 1024 ** 3, chunkBytes: 4 * 1024 ** 2, staleHours: 48 },
  ghinaNotify: { enabled: true, url: '', token: '', events: ['permission', 'question', 'meeting'], debounceSec: 30 },
  // pesan langsung antaragen: autoStart = mulai shift penerima yang belum jalan; maks `maxPerPair` pesan per pasangan dalam `windowMin` menit
  // Performa PC (server/sysmon.js): sampling cepat hanya saat ada klien melihat; alerts = batas % (tempC null: butuh sudo)
  sysmon: { enabled: true, intervalSec: 5, idleSec: 60, activeSec: 60, historyMin: 60, alerts: { cpu: 90, ram: 92, disk: 95, swapPct: 90, tempC: null, sustainSec: 120, cooldownMin: 30 } },
  dm: { autoStart: false, maxPerPair: 20, windowMin: 10, maxPerTurn: 8, midTurn: true },
  // shared office (docs/AKUN.md): members sign in with username + password + 2FA instead of the one token.
  // names = public host names a reverse proxy sends (e.g. "kantor.example.com"); trustProxy = read X-Real-IP / X-Forwarded-Proto.
  // In this mode the config token still works for hooks and MCP, but only from loopback.
  akun: { enabled: false, names: [], trustProxy: false, sessionDays: 14 },
};

export function ensureDirs() {
  for (const d of [DATA_DIR, OFFICE_DIR, RUN_DIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

let cached = null;
export function loadConfig() {
  ensureDirs();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  cfg = { ...DEFAULTS, ...cfg, approvals: { ...DEFAULTS.approvals, ...(cfg.approvals || {}) }, payroll: { ...DEFAULTS.payroll, ...(cfg.payroll || {}) }, ghinaNotify: { ...DEFAULTS.ghinaNotify, ...(cfg.ghinaNotify || {}) }, attachments: { ...DEFAULTS.attachments, ...(cfg.attachments || {}) }, location: { ...DEFAULTS.location, ...(cfg.location || {}) }, dm: { ...DEFAULTS.dm, ...(cfg.dm || {}) }, akun: { ...DEFAULTS.akun, ...(cfg.akun || {}) }, sysmon: { ...DEFAULTS.sysmon, ...(cfg.sysmon || {}), alerts: { ...DEFAULTS.sysmon.alerts, ...(cfg.sysmon?.alerts || {}) } } };
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(24).toString('base64url');
    saveConfig(cfg);
  }
  cached = cfg;
  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  cached = cfg;
}

export function config() {
  return cached || loadConfig();
}
