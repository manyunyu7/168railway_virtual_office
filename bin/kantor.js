#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOME_DIR = process.env.KANTOR_HOME || path.join(os.homedir(), '.kantor-claude');
const SERVER_JSON = path.join(HOME_DIR, 'server.json');
const CONFIG = path.join(HOME_DIR, 'config.json');
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents/com.kantor-claude.plist');
// Homebrew's versioned Cellar path breaks on upgrade; prefer the stable symlink.
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(p => fs.existsSync(p)) || process.execPath;

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = s => { try { process.kill(s.pid, 0); return true; } catch { return false; } };

async function api(p, method = 'POST') {
  const s = readJson(SERVER_JSON);
  if (!s || !alive(s)) throw new Error('Kantor Claude belum jalan. Jalankan: kantor start');
  const r = await fetch(`http://127.0.0.1:${s.port}${p}`, { method, headers: { Authorization: `Bearer ${s.token}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
}

const cmds = {
  start() {
    const s = readJson(SERVER_JSON);
    if (s && alive(s)) return console.log(`Sudah jalan di http://127.0.0.1:${s.port}`);
    const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { stdio: 'inherit' });
    child.on('exit', c => process.exit(c ?? 0));
  },
  open() {
    const s = readJson(SERVER_JSON), c = readJson(CONFIG);
    if (!s || !alive(s)) return console.log('Kantor Claude belum jalan. Jalankan: kantor start');
    const url = `http://127.0.0.1:${s.port}/?token=${c.token}`;
    console.log(url);
    try { execFileSync('open', [url]); } catch {}
  },
  status() {
    const s = readJson(SERVER_JSON);
    console.log(s && alive(s) ? `Jalan (pid ${s.pid}) di port ${s.port}` : 'Tidak jalan');
    const settings = readJson(path.join(os.homedir(), '.claude/settings.json'));
    console.log(`Hooks global: ${JSON.stringify(settings?.hooks || {}).includes('kantor-hook.cjs') ? 'terpasang' : 'belum'}`);
    console.log(`Layanan login (launchd): ${fs.existsSync(PLIST) ? 'terpasang' : 'belum'}`);
  },
  async 'hooks'(sub) {
    if (sub === 'install') { await api('/api/hooks/install'); console.log('Hooks dipasang di ~/.claude/settings.json (cadangan dibuat di sebelahnya). Sesi Claude baru akan muncul di kantor.'); }
    else if (sub === 'uninstall') { await api('/api/hooks/uninstall'); console.log('Hooks Kantor Claude dilepas.'); }
    else console.log('Pakai: kantor hooks install | uninstall');
  },
  'mcp'(sub) {
    if (sub === 'install') {
      execFileSync('claude', ['mcp', 'add', '-s', 'user', 'kantor', '--', NODE, path.join(ROOT, 'server/mcp-stdio.js')], { stdio: 'inherit' });
      console.log('MCP kantor dipasang untuk semua sesi (kantor ditentukan dari folder kerja).');
    } else if (sub === 'uninstall') execFileSync('claude', ['mcp', 'remove', '-s', 'user', 'kantor'], { stdio: 'inherit' });
    else console.log('Pakai: kantor mcp install | uninstall');
  },
  'shell-init'() {
    console.log(`# Tambahkan ke ~/.zshrc supaya "kc" menjalankan claude di dalam tmux (bisa dikontrol dari kantor)
kc() {
  local name="kcm-$(basename "$PWD" | tr -c 'A-Za-z0-9_-' '-')-$(date +%H%M%S)"
  tmux new-session -s "$name" -c "$PWD" "claude $*"
}`);
  },
  service(sub) {
    if (sub === 'install') {
      const node = NODE;
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kantor-claude</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${path.join(ROOT, 'server/index.js')}</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${path.join(os.homedir(), ".local/bin")}:${path.dirname(node)}</string></dict>
  <key>StandardOutPath</key><string>${path.join(HOME_DIR, 'kantor.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(HOME_DIR, 'kantor.log')}</string>
</dict></plist>`;
      fs.mkdirSync(path.dirname(PLIST), { recursive: true });
      fs.writeFileSync(PLIST, plist);
      try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
      execFileSync('launchctl', ['load', PLIST]);
      console.log('Kantor Claude akan jalan otomatis setiap login.');
    } else if (sub === 'uninstall') {
      try { execFileSync('launchctl', ['unload', PLIST]); } catch {}
      fs.rmSync(PLIST, { force: true });
      console.log('Layanan login dilepas.');
    } else console.log('Pakai: kantor service install | uninstall');
  },
};

const [cmd = 'start', ...args] = process.argv.slice(2);
if (!cmds[cmd]) { console.log(`Perintah: ${Object.keys(cmds).join(', ')}`); process.exit(1); }
Promise.resolve(cmds[cmd](...args)).catch(e => { console.error(e.message); process.exit(1); });
