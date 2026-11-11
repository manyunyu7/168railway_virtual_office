#!/usr/bin/env node
// Statusline command for Kantor Claude. Claude Code pipes a JSON document to the statusline command on every update;
// when the account is a claude.ai subscription it carries `rate_limits` (5-hour and weekly windows). This script
// forwards that to the daemon (so the Usage screens can show the remaining quota) and prints one short line.
// It reads no credentials and never fails the statusline: daemon down or slow means nothing is sent.
// Optional: `--then "<command>"` runs your own statusline command with the same input and prints its output after ours.
// Di Mac lain (docs/MULTI-PC.md): env KANTOR_URL + KANTOR_TOKEN → kirim ke hub itu (http/https), tanpa server.json.
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER_JSON = path.join(process.env.KANTOR_HOME || path.join(os.homedir(), '.kantor-claude'), 'server.json');

/** { url, token } atau null. */
// Mac yang dipasangi skrip oleh hub (Pengaturan → Mesin → Pasang) punya <root>/hub.json: { url, token, machine }.
// Dipakai sesi manual di Mac itu (tanpa env KANTOR_URL), supaya tetap tercatat di hub. Tidak ada di repo kantor sendiri.
function readHubJson() {
  try { const h = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hub.json'), 'utf8')); if (h && h.url && h.token) return { url: String(h.url).replace(/\/+$/, ''), token: h.token, remote: true }; } catch {}
  return null;
}
function readServer() {
  if (process.env.KANTOR_URL && process.env.KANTOR_TOKEN) return { url: process.env.KANTOR_URL.replace(/\/+$/, ''), token: process.env.KANTOR_TOKEN };
  const hub = readHubJson();
  if (hub) return { url: hub.url, token: hub.token };
  try {
    const s = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8'));
    if (s && s.port && s.token) { try { process.kill(s.pid, 0); } catch { return null; } return { url: `http://127.0.0.1:${s.port}`, token: s.token }; }
  } catch {}
  return null;
}

function post(server, body) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(server.url + '/api/usage/limits/claude'); } catch { return resolve(); }
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST', timeout: 1200,
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
