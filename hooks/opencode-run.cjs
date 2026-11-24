#!/usr/bin/env node
// Supervisor of one Kantor shift on OpenCode (docs/OPENCODE.md). Runs inside the shift's tmux pane:
//   1. a private `opencode serve` on 127.0.0.1 with a random password and this shift's config (MCP kantor with the
//      shift's identity, persona as instructions, model) — the owner's background service and global config are untouched;
//   2. creates or reopens the OpenCode session (id = Kantor sid) with the shift's permission rules and sends the first task;
//   3. forwards the server's event stream to the daemon's /api/hook as Claude-shaped hook payloads, answers permission
//      requests decided in Kantor's inbox, and keeps a JSONL snapshot of the conversation for the Chat tab;
//   4. hosts the OpenCode TUI (attached with --server) in the foreground. When the TUI exits, everything stops.
// Usage: node opencode-run.cjs <spec.json>   (the spec is a private 0600 file written by server/tmux.js)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = msg => process.stderr.write(`\x1b[33m[kantor] ${msg}\x1b[0m\n`);
let server = null, tui = null, url = null, ending = false, events = null;

/* ---------- the private OpenCode server ---------- */
function api(method, p, body, { timeout = 30000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, url);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(u, { method, timeout, headers: {
      Authorization: 'Basic ' + Buffer.from(`opencode:${spec.password}`).toString('base64'),
      'x-opencode-directory': spec.cwd, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      if (raw) return resolve(res);
      let out = ''; res.setEncoding('utf8');
      res.on('data', c => { out += c; });
      res.on('end', () => {
        let json = null; try { json = out ? JSON.parse(out) : null; } catch {}
        if (res.statusCode >= 400) { const e = new Error(json?.message || json?.error?.message || `HTTP ${res.statusCode} ${p}`); e.status = res.statusCode; return reject(e); }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout ${p}`)));
    req.end(data || undefined);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(spec.log, 'a', 0o600);
    // PWD: OpenCode resolves its project folder from PWD rather than the process cwd
    const env = { ...process.env, PWD: spec.cwd, OPENCODE_CONFIG_CONTENT: JSON.stringify(spec.config), OPENCODE_SERVER_PASSWORD: spec.password };
    delete env.OPENCODE_PASSWORD;
    server = spawn(spec.bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server OpenCode tidak siap dalam 45 detik')), 45000);
    const onData = chunk => {
      fs.writeSync(log, chunk);
      if (url) return;
      buf = (buf + chunk).slice(-4000);
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
      if (m) { url = m[1]; clearTimeout(timer); resolve(url); }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('error', e => { clearTimeout(timer); reject(e); });
    server.on('exit', code => {
      clearTimeout(timer);
      if (!url) reject(new Error(`server OpenCode berhenti (exit ${code}). Log: ${spec.log}`));
      else if (!ending) { say(`server OpenCode berhenti (exit ${code}). Log: ${spec.log}`); finish(1); }
    });
  });
}

/* ---------- Kantor daemon ---------- */
function daemon() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(spec.kantorHome || path.join(os.homedir(), '.kantor-claude'), 'server.json'), 'utf8'));
    if (s && s.port && s.token) return { url: `http://127.0.0.1:${s.port}`, token: s.token };
  } catch {}
  return null;
}
function hook(payload, timeoutMs = 4000) {
  const d = daemon();
  if (!d) return Promise.resolve(null);
  return new Promise(resolve => {
    const body = JSON.stringify(payload), u = new URL('/api/hook', d.url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', timeout: timeoutMs,
      headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', c => { out += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(out) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}
// Hook events keep their order; a permission request waits for its decision on its own, so a reply typed in the
// terminal (or the tool finishing) still reaches the daemon meanwhile.
let queue = Promise.resolve();
const send = payload => { queue = queue.then(() => hook(payload)).then(res => afterHook(payload, res)).catch(() => {}); return queue; };

async function afterHook(payload, res) {
  const ctx = res?.hookSpecificOutput?.additionalContext;
  if (!ctx || !['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure'].includes(payload.hook_event_name) || payload.agent_id) return;
  // messages waiting in Kantor (pesan_ke, rule changes, ...) join the running turn as a synthetic note, like Claude's additionalContext
  try { await api('POST', `/api/session/${encodeURIComponent(spec.sid)}/synthetic`, { text: ctx, description: 'Kantor', delivery: 'steer', resume: false }); } catch {}
}

const pending = new Map(); // permission id → true while Kantor holds it
const decided = new Set(); // permission ids answered from Kantor (their permission.replied needs no action)
async function permission(payload) {
  const id = payload.kantor_permission_id;
  pending.set(id, payload.tool_use_id || true);
  const res = await hook(payload, 600000);
  if (!pending.has(id)) return; // answered in the terminal meanwhile
  pending.delete(id);
  const dec = res?.hookSpecificOutput?.decision;
  if (!dec) return; // nobody answered in Kantor: the prompt stays in the terminal
  decided.add(id);
  const reply = dec.behavior === 'allow' ? { decision: 'once' } : { decision: 'reject', message: dec.message || 'Ditolak dari kotak masuk Kantor.' };
  const owner = payload.kantor_permission_session || spec.sid; // a subagent's request is answered on its own session
  try { await api('POST', `/api/session/${encodeURIComponent(owner)}/permission/${encodeURIComponent(id)}/reply`, reply); } catch {}
  if (dec.behavior !== 'allow' && dec.interrupt) { try { await api('POST', `/api/session/${encodeURIComponent(spec.sid)}/interrupt`); } catch {} }
}

/* ---------- conversation snapshot for the Chat tab ---------- */
// Append-only JSONL of finished messages (an assistant step is written once it completed), so the Chat keeps its
// cursor. Only when the history itself changed (revert, a message gone) is the file replaced, which resets the Chat.
let snapTimer = null, snapping = false, snapAgain = false, written = null;
const finished = m => m && (m.type !== 'assistant' || !!m.time?.completed);
function writtenIds() {
  try { return fs.readFileSync(spec.transcript, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).id; } catch { return null; } }); } catch { return []; }
}
async function snapshot() {
  if (snapping) { snapAgain = true; return; }
  snapping = true;
  try {
    const all = [];
    let cursor = null, guard = 0;
    do {
      const q = cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=asc&limit=200';
      const r = await api('GET', `/api/session/${encodeURIComponent(spec.sid)}/message?${q}`);
      const page = Array.isArray(r?.data) ? r.data : [];
      all.push(...page);
      const next = r?.cursor?.next;
      cursor = page.length && next && next !== cursor ? next : null;
    } while (cursor && ++guard < 200);
    const stop = all.findIndex(m => !finished(m));
    const done = stop < 0 ? all : all.slice(0, stop);
    if (!fs.existsSync(spec.transcript)) fs.writeFileSync(spec.transcript, '', { mode: 0o600 });
    written ||= writtenIds();
    const line = m => JSON.stringify(m) + '\n';
    if (written.length <= done.length && written.every((id, i) => done[i].id === id)) {
      const add = done.slice(written.length);
      if (add.length) fs.appendFileSync(spec.transcript, add.map(line).join(''), { mode: 0o600 });
    } else {
      const tmp = `${spec.transcript}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, done.map(line).join(''), { mode: 0o600 });
      fs.renameSync(tmp, spec.transcript);
    }
    written = done.map(m => m.id);
  } catch {} finally {
    snapping = false;
    if (snapAgain) { snapAgain = false; scheduleSnapshot(); }
  }
}
function scheduleSnapshot(ms = 600) { if (!snapTimer) snapTimer = setTimeout(() => { snapTimer = null; snapshot(); }, ms); }

/* ---------- event stream ---------- */
let busy = false;
async function stream(mod, st) {
  let backoff = 500, first = true;
  while (!ending) {
    try {
      const res = await api('GET', '/api/event', undefined, { raw: true, timeout: 0 });
      if (res.statusCode !== 200) throw new Error(`event ${res.statusCode}`);
      events = res;
      if (!first) { // reconnected: catch up on what happened meanwhile
        scheduleSnapshot(0);
        try {
          const act = await api('GET', '/api/session/active');
          if (busy && !act?.data?.[spec.sid]) { busy = false; send({ ...mod.mapOcEvent({ type: 'session.execution.succeeded', data: { sessionID: spec.sid } }, st).hooks[0] }); }
        } catch {}
      }
      first = false; backoff = 500;
      let buf = '';
      res.setEncoding('utf8');
      await new Promise(resolve => {
        res.on('data', chunk => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            onEvent(mod, st, ev);
          }
        });
        res.on('end', resolve); res.on('error', resolve); res.on('close', resolve);
      });
    } catch {}
    if (ending) return;
    await sleep(backoff); backoff = Math.min(5000, backoff * 2);
  }
}
function onEvent(mod, st, ev) {
  if (ev.type === 'permission.replied') {
    const id = ev.data.requestID;
    if (pending.has(id)) { const tool = pending.get(id); pending.delete(id); send({ session_id: spec.sid, hook_event_name: 'PermissionResolved', kantor_engine: 'opencode', kantor_sid: spec.sid, kantor_permission_id: id, tool_use_id: typeof tool === 'string' ? tool : null, reply: ev.data.reply }); }
    decided.delete(id);
    return;
  }
  const out = mod.mapOcEvent(ev, st);
  for (const p of out.hooks) {
    if (p.hook_event_name === 'UserPromptSubmit') busy = true;
    if ((p.hook_event_name === 'Stop' || p.hook_event_name === 'Interrupt') && !p.agent_id) busy = false;
    if (p.hook_event_name === 'PermissionRequest') { const tool = p.tool_use_id; pending.set(p.kantor_permission_id, tool); permission(p); }
    else send(p);
  }
  if (out.snapshot) scheduleSnapshot();
}

/* ---------- lifecycle ---------- */
async function prepare(mod) {
  const sid = encodeURIComponent(spec.sid);
  let existing = null;
  try { existing = (await api('GET', `/api/session/${sid}`))?.data || null; } catch (e) { if (e.status !== 404) throw e; }
  const model = mod.ocModelRef(spec.model);
  if (!existing) {
    await api('POST', '/api/session', { id: spec.sid, permissions: spec.permissions, ...(model ? { model } : {}), ...(spec.title ? { title: spec.title } : {}) });
  } else {
    await api('PATCH', `/api/session/${sid}`, { permissions: spec.permissions });
    if (model) await api('POST', `/api/session/${sid}/model`, { model });
  }
  return existing;
}

async function finish(code = 0) {
  if (ending) return;
  ending = true;
  try { events?.destroy(); } catch {}
  if (url) await Promise.race([snapshot(), sleep(3000)]);
  await Promise.race([queue, sleep(2000)]);
  await hook({ session_id: spec.sid, hook_event_name: 'SessionEnd', reason: 'exit', kantor_engine: 'opencode', kantor_sid: spec.sid }, 1500);
  try { fs.rmSync(spec.state, { force: true }); } catch {}
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(3000)]);
    if (server.exitCode === null) try { server.kill('SIGKILL'); } catch {}
  }
  process.exit(code);
}
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(sig, () => { try { tui?.kill('SIGTERM'); } catch {} finish(0); });

(async () => {
  const mod = await import(path.join(ROOT, 'server', 'opencode-events.js'));
  try {
    await startServer();
    fs.writeFileSync(spec.state, JSON.stringify({ url, password: spec.password, pid: server.pid, supervisor: process.pid, cwd: spec.cwd, sid: spec.sid }), { mode: 0o600 });
    const existing = await prepare(mod);
    const st = mod.createOcState({ sid: spec.sid, cwd: spec.cwd, transcript: spec.transcript, model: spec.model || (existing?.model ? mod.ocModelSlug(existing.model) : null) });
    stream(mod, st);
    await snapshot();
    send({ session_id: spec.sid, hook_event_name: 'SessionStart', source: spec.resume ? 'resume' : 'startup', cwd: spec.cwd, transcript_path: spec.transcript,
      ...(st.model ? { model: st.model } : {}), kantor_engine: 'opencode', kantor_sid: spec.sid });
    for (let i = 0; i < 40 && !events; i++) await sleep(100); // subscribe before the first prompt, so its events are not missed
    if (spec.task) await api('POST', `/api/session/${encodeURIComponent(spec.sid)}/prompt`, { text: spec.task });
  } catch (e) {
    say(`OpenCode gagal dimulai: ${e.message}`);
    say('Panel ini menutup sendiri dalam 60 detik.');
    await sleep(60000);
    return finish(1);
  }
  const env = { ...process.env, PWD: spec.cwd, OPENCODE_PASSWORD: spec.password };
  delete env.OPENCODE_CONFIG_CONTENT; delete env.OPENCODE_SERVER_PASSWORD;
  tui = spawn(spec.bin, ['--server', url, '--session', spec.sid, spec.cwd], { cwd: spec.cwd, env, stdio: 'inherit' });
  tui.on('exit', code => finish(code || 0));
  tui.on('error', e => { say(`TUI OpenCode gagal: ${e.message}`); finish(1); });
})();
