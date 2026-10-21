// npm 11 blocks node-pty's postinstall, which normally makes spawn-helper executable.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
for (const plat of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  const helper = path.join(dir, plat, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
