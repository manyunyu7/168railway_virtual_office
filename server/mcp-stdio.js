#!/usr/bin/env node
// Minimal MCP server (stdio, JSON-RPC 2.0) that forwards tool calls to the Kantor Claude daemon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';

function server() {
  if (process.env.KANTOR_URL && process.env.KANTOR_TOKEN) return { url: process.env.KANTOR_URL, token: process.env.KANTOR_TOKEN };
  const s = JSON.parse(fs.readFileSync(path.join(process.env.KANTOR_HOME || path.join(os.homedir(), '.kantor-claude'), 'server.json'), 'utf8'));
  return { url: `http://127.0.0.1:${s.port}`, token: s.token };
}
const ident = { office: process.env.KANTOR_OFFICE || null, role: process.env.KANTOR_ROLE || null, sid: process.env.KANTOR_SID || null, cwd: process.cwd() };

// node:http instead of fetch: `tanya` can wait up to 15 minutes, longer than fetch's default response-header timeout
function api(p, body) {
  const s = server();
  const u = new URL(s.url + p);
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(u, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}`, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode >= 400) reject(new Error(json.error || `HTTP ${res.statusCode}`)); else resolve(json);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kantor', version: '0.1.0' }, instructions: 'Board, wiki, notes, dan buku catatan Kantor Claude.' } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') { const r = await api('/api/agent/tools'); return send({ jsonrpc: '2.0', id, result: { tools: r.tools } }); }
    if (method === 'tools/call') {
      try {
        const r = await api('/api/agent/call', { ...ident, tool: params.name, args: params.arguments || {} });
        return send({ jsonrpc: '2.0', id, result: r });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});
