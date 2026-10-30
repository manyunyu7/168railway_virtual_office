// Adapter for Antigravity's camelCase hook protocol. No credentials are read or copied.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
(async () => {
  if (process.env.KANTOR_ENGINE !== 'antigravity') return;
  const event = process.argv[2];
  let input = ''; for await (const c of process.stdin) input += c;
  const data = JSON.parse(input);
  if (!data.conversationId) return;
  const root = path.resolve(__dirname, '..');
  const { normalizeAgyHook } = await import(path.join(root, 'server/antigravity.js'));
  const p = normalizeAgyHook(event, { ...data, kantor_sid: process.env.KANTOR_SID });
  // A Stop with background work still running is not an idle session.
  if (event === 'Stop' && data.fullyIdle === false) return;
  const home = process.env.KANTOR_HOME || path.join(os.homedir(), '.kantor-claude');
  const server = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
  const body = JSON.stringify(p);
  const response = await new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port: server.port, path: '/api/hook', method: 'POST', timeout: 1800,
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end(body);
  });
  const texts = [];
  if ((event === 'SessionStart' || event === 'PreInvocation' && process.env.KANTOR_RESUME === '1' && data.invocationNum === 0) && process.env.KANTOR_PROMPT_FILE)
    texts.push(fs.readFileSync(process.env.KANTOR_PROMPT_FILE, 'utf8'));
  const context = response?.hookSpecificOutput?.additionalContext;
  if (context && ['PreInvocation', 'SessionStart'].includes(event)) texts.push(context);
  if (texts.length) process.stdout.write(JSON.stringify({ injectSteps: texts.map(systemMessage => ({ systemMessage: { systemMessage } })) }));
})().catch(() => {}).finally(() => process.exit(0));
