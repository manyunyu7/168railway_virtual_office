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
};

export function ensureDirs() {
  for (const d of [DATA_DIR, OFFICE_DIR, RUN_DIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

let cached = null;
export function loadConfig() {
  ensureDirs();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  cfg = { ...DEFAULTS, ...cfg, approvals: { ...DEFAULTS.approvals, ...(cfg.approvals || {}) }, payroll: { ...DEFAULTS.payroll, ...(cfg.payroll || {}) } };
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
