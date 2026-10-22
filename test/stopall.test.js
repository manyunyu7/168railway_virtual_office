import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-sa-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));
const tm = await import('../server/tmux.js');

// stand-in for Claude Code: Esc ends "working", Ctrl+X Ctrl+K twice clears the background agents
const fake = path.join(tmp, 'fake-claude-ui.js');
fs.writeFileSync(fake, `
let working = process.env.WORKING === '1', agents = +process.env.AGENTS, ks = 0, buf = '';
function draw() {
  process.stdout.write('\\x1b[2J\\x1b[H');
  console.log('> ' + (working ? 'esc to interrupt' : 'idle'));
  console.log('-'.repeat(40));
  console.log('  ' + (agents ? '\\u2190 ' + agents + ' agents' : 'tidy'));
}
process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', d => { buf += d.toString();
  if (buf.includes('\\x18\\x0b')) { buf = ''; if (++ks >= 2) agents = 0; }
  else if (buf === '\\x1b') { working = false; buf = ''; }
  else if (buf === '\\x18') return;
  else buf = '';
  draw(); });
draw();
`);

const wait = ms => new Promise(r => setTimeout(r, ms));
async function run(name, env) {
  tm.tmux(['new-session', '-d', '-s', name, '-x', '100', '-y', '20', `env ${env} ${process.execPath} ${fake}`]);
  await wait(800);
}
const kill = name => { try { tm.tmux(['kill-session', '-t', name]); } catch {} };

test('screenAgents reads the status bar tail only', () => {
  assert.equal(tm.screenAgents('x\n\n  ← 3 agents'), 3);
  assert.equal(tm.screenAgents('2 agents said hi\na\nb\nc\nd\ne'), 0);
  assert.equal(tm.screenAgents('nothing'), 0);
});

test('stop-all: busy main agent plus background agents are both stopped', async () => {
  const name = 'sa-busy-' + process.pid;
  await run(name, 'WORKING=1 AGENTS=2');
  try {
    const r = await tm.stopAll(name);
    assert.deepEqual(r, { stoppedMain: true, agentsBefore: 2, agentsAfter: 0 });
  } finally { kill(name); }
});

test('stop-all: idle main with no agents sends nothing', async () => {
  const name = 'sa-idle-' + process.pid;
  await run(name, 'WORKING=0 AGENTS=0');
  try {
    assert.deepEqual(await tm.stopAll(name), { stoppedMain: false, agentsBefore: 0, agentsAfter: 0 });
  } finally { kill(name); }
});
