#!/usr/bin/env node
// Claude Code hook for Kantor Claude. Forwards every hook event to the local daemon.
// It never blocks Claude Code: if the daemon is down or slow it exits 0 with no output.
// For PermissionRequest it may wait for a decision from the inbox, then prints it.
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SERVER_JSON = path.join(process.env.KANTOR_HOME || path.join(os.homedir(), '.kantor-claude'), 'server.json');

function readServer() {
  try {
    const s = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8'));
    if (s && s.port && s.token) { try { process.kill(s.pid, 0); } catch { return null; } return s; }
  } catch {}
  return null;
}

function post(server, body, timeoutMs) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.port, path: '/api/hook', method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${server.token}` },
    }, res => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => { out += c; });
      res.on('end', () => resolve(res.statusCode === 200 ? out : ''));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end(body);
  });
}

(async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let data;
  try { data = JSON.parse(input); } catch { return; }
  const server = readServer();
  if (!server) return;
  if (process.env.KANTOR_SID && !data.kantor_sid) data.kantor_sid = process.env.KANTOR_SID;
  // Codex runs the same script (see server/codex.js); its session ids are its own, so the daemon needs to know
  if (process.env.KANTOR_ENGINE === 'codex' && !data.kantor_engine) data.kantor_engine = 'codex';
  if (['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification'].includes(data.hook_event_name)) {
    // the hook inherits Claude's controlling terminal; knowing it lets the office type into that tab
    try { const t = require('child_process').execFileSync('ps', ['-o', 'tty=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 800 }).trim(); if (t && t !== '??') data.kantor_tty = '/dev/' + t; } catch {}
  }
  const waits = data.hook_event_name === 'PermissionRequest';
  const out = await post(server, JSON.stringify(data), waits ? 590000 : 1500);
  // PermissionRequest answers; PreToolUse / PostToolUse / UserPromptSubmit may return additionalContext (waiting messages, rule changes, repeat warnings)
  const answers = waits || data.hook_event_name === 'PostToolUse' || data.hook_event_name === 'PreToolUse' || data.hook_event_name === 'UserPromptSubmit';
  if (answers && out && out.trim() && out.trim() !== 'null') process.stdout.write(out.trim());
})().catch(() => {}).finally(() => process.exit(0));
