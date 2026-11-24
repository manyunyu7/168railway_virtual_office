// OpenCode (sst/opencode v2, `opencode` CLI) as Kantor's fourth engine (docs/OPENCODE.md).
// The daemon side: binary, models catalog, the shift spec read by hooks/opencode-run.cjs, the per-shift private
// server's API (interrupt, prompt, model, permissions) and the Chat transcript reader.
// Credentials stay with OpenCode; ~/.config/opencode is never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { config, ROOT_DIR, RUN_DIR } from './config.js';
import { scanAppended } from './jsonl.js';
import { resetTranscript, appendTranscript, transcriptResponse } from './transcript-delta.js';
import { OC_MODES, ocMode, ocPermissions, ocModelRef, parseOcModels, ocTranscriptItems, isOcTranscript } from './opencode-events.js';

export { OC_MODES, ocMode, ocPermissions, ocModelRef, parseOcModels, isOcTranscript };

let BIN;
export function opencodeBin({ fresh = false } = {}) {
  if (BIN !== undefined && !fresh) return BIN;
  const custom = config().opencode?.bin;
  BIN = [custom, ...String(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'opencode')),
    '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', path.join(os.homedir(), '.opencode/bin/opencode'), path.join(os.homedir(), '.local/bin/opencode')]
    .find(p => p && path.isAbsolute(p) && fs.existsSync(p)) || null;
  if (!BIN) try { BIN = execFileSync('/bin/zsh', ['-lc', 'command -v opencode'], { encoding: 'utf8', timeout: 5000 }).trim() || null; } catch { BIN = null; }
  if (BIN && !path.isAbsolute(BIN)) BIN = null;
  return BIN;
}
/** Mode used when a shift asks for none: config.opencode.defaultMode, else ask first. */
export const ocDefaultMode = () => ocMode(config().opencode?.defaultMode, 'default');
export const ocShiftMode = mode => ocMode(mode, ocDefaultMode());

/* ---------------- models ---------------- */
let modelsCache = null;
/** `opencode models` through a private (--standalone) server, so the owner's background service is never started by Kantor. */
export function ocModels({ fresh = false } = {}) {
  const bin = opencodeBin();
  if (!bin) return Promise.resolve({ available: false, models: [], modes: OC_MODES });
  if (!fresh && modelsCache && Date.now() - modelsCache.at < 600e3) return Promise.resolve(modelsCache.value);
  return new Promise(resolve => execFile(bin, ['models', '--standalone'], { timeout: 30000, maxBuffer: 4 << 20, cwd: os.homedir() }, (err, stdout) => {
    const models = parseOcModels(stdout);
    const value = { available: true, models, modes: OC_MODES,
      ...(models.length ? {} : { error: 'Daftar model OpenCode belum terbaca. Jalankan `opencode` sekali di Mac ini dan login (opencode auth).' }) };
    if (models.length && !err) modelsCache = { at: Date.now(), value };
    resolve(value);
  }));
}
/** A model slug is usable when OpenCode lists it (or the list could not be read; then OpenCode itself reports the error). */
export async function checkOcModel(slug) {
  if (!slug) return null;
  if (!ocModelRef(slug)) throw new Error(`Model OpenCode harus berbentuk provider/model, misalnya opencode-go/glm-5.3. Diterima: ${slug}`);
  const { models } = await ocModels();
  if (models.length && !models.some(m => m.slug === slug.replace(/#.*$/, ''))) throw new Error(`Model ${slug} tidak ada di daftar \`opencode models\` Mac ini.`);
  return slug;
}

/* ---------------- shift launch ---------------- */
/** Deny rules from the owner's own OpenCode config files; Kantor re-appends them so no Kantor mode loosens them. */
export function userDenyRules(dir = path.join(os.homedir(), '.config/opencode')) {
  const out = [];
  for (const name of ['opencode.json', 'opencode.jsonc', 'config.json']) {
    let text; try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    try {
      const cfg = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
      for (const r of Array.isArray(cfg?.permissions) ? cfg.permissions : []) if (r?.effect === 'deny') out.push(r);
    } catch {}
  }
  return out;
}
export const newOcSessionId = () => `ses_kc${crypto.randomBytes(12).toString('hex')}`;
export const isOcSessionId = sid => /^ses[\w-]{6,}$/.test(String(sid || ''));
export const ocFiles = sid => ({ spec: path.join(RUN_DIR, `${sid}.opencode-spec.json`), state: path.join(RUN_DIR, `${sid}.opencode.json`),
  transcript: path.join(RUN_DIR, `${sid}.opencode.jsonl`), log: path.join(RUN_DIR, `${sid}.opencode.log`), prompt: path.join(RUN_DIR, `${sid}.prompt.md`) });

/**
 * The private spec for hooks/opencode-run.cjs. OpenCode reads OPENCODE_CONFIG_CONTENT only in a server it starts
 * itself (not in the background service), which is why every shift runs its own server.
 */
export function ocSpec({ sid, cwd, officeId, roleId, task = '', model = '', mode = 'default', resume = false, title = '', kantorHome = process.env.KANTOR_HOME || null, bin = opencodeBin(), node = process.execPath, root = ROOT_DIR, userDeny = userDenyRules() }) {
  const f = ocFiles(sid);
  const mcpEnv = { KANTOR_OFFICE: officeId, KANTOR_ROLE: roleId || '', KANTOR_SID: sid, KANTOR_ENGINE: 'opencode', ...(kantorHome ? { KANTOR_HOME: kantorHome } : {}) };
  const cfg = {
    instructions: [f.prompt],
    mcp: { servers: { kantor: { type: 'local', command: [node, path.join(root, 'server', 'mcp-stdio.js')], environment: mcpEnv, codemode: false, timeout: { execution: 960000 } } } },
    update: 'disable', share: 'disabled',
    ...(model ? { model } : {}),
  };
  return { sid, bin, cwd, task, model: model || '', mode: ocMode(mode), resume: !!resume, title, permissions: ocPermissions(mode, userDeny), config: cfg,
    password: crypto.randomBytes(24).toString('base64url'), kantorHome, transcript: f.transcript, state: f.state, log: f.log };
}

/* ---------------- talking to a shift's private server ---------------- */
export function ocState(sid) {
  try { const st = JSON.parse(fs.readFileSync(ocFiles(sid).state, 'utf8')); return st?.url && st.password ? st : null; } catch { return null; }
}
export async function ocApi(sid, method, p, body) {
  const st = ocState(sid);
  if (!st) { const e = new Error('Server OpenCode sesi ini tidak berjalan. Buka tab Terminal, atau mulai ulang shift-nya.'); e.code = 409; throw e; }
  const res = await fetch(new URL(p, st.url), { method, signal: AbortSignal.timeout(20000), headers: {
    Authorization: 'Basic ' + Buffer.from(`opencode:${st.password}`).toString('base64'), 'x-opencode-directory': st.cwd,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) { const e = new Error(`OpenCode menolak: ${json?.message || json?.error?.message || res.status}`); e.code = 409; throw e; }
  return json;
}
const enc = encodeURIComponent;
export const ocPrompt = (sid, text) => ocApi(sid, 'POST', `/api/session/${enc(sid)}/prompt`, { text });
export const ocInterrupt = sid => ocApi(sid, 'POST', `/api/session/${enc(sid)}/interrupt`).then(r => !!r?.interrupted);
export const ocCompact = sid => ocApi(sid, 'POST', `/api/session/${enc(sid)}/compact`, {});
export async function ocSetModel(sid, slug) {
  const ref = ocModelRef(slug);
  if (!ref) throw new Error('Model OpenCode harus berbentuk provider/model');
  await checkOcModel(slug);
  await ocApi(sid, 'POST', `/api/session/${enc(sid)}/model`, { model: ref });
  return slug;
}
export async function ocSetMode(sid, mode) {
  if (!OC_MODES.includes(mode)) throw new Error(`Mode izin OpenCode: ${OC_MODES.join(', ')}`);
  await ocApi(sid, 'PATCH', `/api/session/${enc(sid)}`, { permissions: ocPermissions(mode, userDenyRules()) });
  try { // remembered for the next daemon start (the sessions table has no column for it)
    const f = ocFiles(sid).spec, spec = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...spec, mode, permissions: ocPermissions(mode, userDenyRules()) }), { mode: 0o600 });
  } catch {}
  return mode;
}
/** Permission mode a shift was started (or last switched) with, from its spec. */
export function ocSavedMode(sid) {
  try { const m = JSON.parse(fs.readFileSync(ocFiles(sid).spec, 'utf8')).mode; return OC_MODES.includes(m) ? m : null; } catch { return null; }
}
/** Stop a shift's private server if its supervisor died without doing so (pane killed hard). Only our own pid. */
export function reapOcServer(sid) {
  const st = ocState(sid);
  if (!st) return false;
  for (const pid of [st.supervisor, st.pid]) {
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
      if (/opencode(-run\.cjs)?\b/.test(cmd)) process.kill(pid, 'SIGTERM');
    } catch {}
  }
  try { fs.rmSync(ocFiles(sid).state, { force: true }); } catch {}
  return true;
}

/* ---------------- transcript ---------------- */
const cache = new Map();
export function readOcTranscript(file, n = 120, options, toolLabel) {
  if (!file || !fs.existsSync(file)) return { items: [], missing: true };
  const c = cache.get(file) || { ino: null, offset: 0, items: [] };
  const stat = scanAppended(file, c, null, d => { appendTranscript(c, ocTranscriptItems(d, toolLabel)); }, () => { resetTranscript(c); }, true);
  cache.set(file, c);
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return transcriptResponse(c, stat, n, options);
}
