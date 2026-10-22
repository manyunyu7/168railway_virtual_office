#!/usr/bin/env node
// Statusline command for Kantor Claude. Claude Code pipes a JSON document to the statusline command on every update;
// when the account is a claude.ai subscription it carries `rate_limits` (5-hour and weekly windows). This script
// forwards that to the daemon (so the Usage screens can show the remaining quota) and prints one short line.
// It reads no credentials and never fails the statusline: daemon down or slow means nothing is sent.
// Optional: `--then "<command>"` runs your own statusline command with the same input and prints its output after ours.
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER_JSON = path.join(process.env.KANTOR_HOME || path.join(os.homedir(), '.kantor-claude'), 'server.json');

function readServer() {
  try {
    const s = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8'));
    if (s && s.port && s.token) { try { process.kill(s.pid, 0); } catch { return null; } return s; }
  } catch {}
  return null;
}

function post(server, body) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.port, path: '/api/usage/limits/claude', method: 'POST', timeout: 1200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${server.token}` },
    }, res => { res.resume(); res.on('end', () => resolve()); });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

const pct = w => (w && typeof w.used_percentage === 'number' ? Math.round(w.used_percentage) + '%' : null);

(async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let data = null;
  try { data = JSON.parse(input); } catch {}
  const rl = data && data.rate_limits;
  const parts = [];
  if (rl) {
    const a = pct(rl.five_hour), b = pct(rl.seven_day);
    if (a) parts.push('5j ' + a);
    if (b) parts.push('7h ' + b);
    const server = readServer();
    if (server) await post(server, JSON.stringify({ rate_limits: rl, model: data.model }));
  }
  let line = parts.join(' · ');
  const i = process.argv.indexOf('--then');
  if (i > 0 && process.argv[i + 1]) {
    const r = spawnSync(process.argv[i + 1], { shell: true, input, encoding: 'utf8', timeout: 3000 });
    const out = (r.stdout || '').trim();
    if (out) line = line ? line + ' | ' + out : out;
  }
  if (line) process.stdout.write(line + '\n');
})().catch(() => {}).finally(() => process.exit(0));
