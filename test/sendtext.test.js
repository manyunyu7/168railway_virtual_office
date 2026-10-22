import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-st-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));
const tm = await import('../server/tmux.js');

const CLAUDE_IDLE = `✻ Churned for 2m 25s · done 10:29 AM
─────────────────────────────────── Henry · repo ─
❯ 
──────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents
`;
const CLAUDE_STUCK = CLAUDE_IDLE.replace('❯ \n', '❯ oke lanjut beresin tiga sisanya\n');

test('pendingInput: empty prompt is never pending', () => {
  assert.equal(tm.pendingInput(CLAUDE_IDLE, 'oke lanjut beresin tiga sisanya'), false);
  assert.equal(tm.pendingInput('', 'x'), false);
  assert.equal(tm.pendingInput('no prompt here', 'no prompt here'), false);
});
test('pendingInput: our text or a paste placeholder still in the box', () => {
  assert.equal(tm.pendingInput(CLAUDE_STUCK, 'oke lanjut beresin tiga sisanya'), true);
  assert.equal(tm.pendingInput(CLAUDE_IDLE.replace('❯ \n', '❯ [Pasted text #1 +12 lines]\n'), 'a\nb'), true);
  // wrapped over two lines
  assert.equal(tm.pendingInput(CLAUDE_IDLE.replace('❯ \n', '❯ halo semua ini pesan yang\n  panjang sekali\n'), 'halo semua ini pesan yang panjang sekali'), true);
});
test('pendingInput: other text in the box (suggestion / earlier history) does not count', () => {
  assert.equal(tm.pendingInput(CLAUDE_IDLE.replace('❯ \n', '❯ Try "fix lint errors"\n'), 'kirim laporan'), false);
  const hist = `› kirim laporan\n\nhasilnya...\n\n› \n`; // Codex: history line above, empty input below
  assert.equal(tm.pendingInput(hist, 'kirim laporan'), false);
});
test('enterDelay grows with length and is capped', () => {
  assert.equal(tm.usePaste('pendek'), false);
  assert.equal(tm.usePaste('a\nb'), true);
  assert.ok(tm.enterDelay('a\nb') >= 350);
  assert.ok(tm.enterDelay('x'.repeat(4000)) > tm.enterDelay('x'.repeat(400)));
  assert.equal(tm.enterDelay('x'.repeat(100000)), 2000);
});

// stand-in for Claude Code's input box: a paste is folded into "[Pasted text …]" and an Enter right after it is swallowed
const fake = path.join(tmp, 'fake-input.js');
fs.writeFileSync(fake, `
const fs = require('fs'); const log = process.env.LOG; const swallow = +process.env.SWALLOW;
let buf = '', pasted = null, busyUntil = 0, inPaste = false, raw = '';
function draw() {
  process.stdout.write('\\x1b[2J\\x1b[H' + 'chat\\n' + '-'.repeat(30) + '\\n\\u276f ' + (pasted ? '[Pasted text #1 +' + pasted.split('\\n').length + ' lines]' : buf) + '\\n' + '\\u2500'.repeat(30) + '\\n  status\\n');
}
process.stdout.write('\\x1b[?2004h');
process.stdin.setRawMode(true); process.stdin.resume();
process.stdin.on('data', d => { raw += d.toString('utf8');
  for (;;) {
    if (inPaste) { const e = raw.indexOf('\\x1b[201~'); if (e < 0) return; pasted = raw.slice(0, e); raw = raw.slice(e + 6); inPaste = false; busyUntil = Date.now() + swallow; continue; }
    const s = raw.indexOf('\\x1b[200~'); if (s === 0) { raw = raw.slice(6); inPaste = true; continue; }
    if (!raw) break;
    const ch = raw[0]; raw = raw.slice(1);
    if (ch === '\\r') { if (Date.now() < busyUntil) continue; const t = pasted ?? buf; if (t) fs.appendFileSync(log, JSON.stringify(t) + '\\n'); buf = ''; pasted = null; }
    else buf += ch;
  }
  draw(); });
draw();
`);
const wait = ms => new Promise(r => setTimeout(r, ms));
const kill = name => { try { tm.tmux(['kill-session', '-t', name]); } catch {} };
async function run(name, log, swallow) {
  tm.tmux(['new-session', '-d', '-s', name, '-x', '100', '-y', '20', `env LOG=${log} SWALLOW=${swallow} ${process.execPath} ${fake}`]);
  await wait(800);
}
const sent = log => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

test('sendText: a paste whose first Enter is swallowed still gets submitted, exactly once', async () => {
  const name = 'st-paste-' + process.pid, log = path.join(tmp, 'paste.log');
  await run(name, log, 1200);
  try {
    const text = 'baris satu\nbaris dua\nbaris tiga';
    await tm.sendText(name, text);
    await wait(300);
    assert.deepEqual(sent(log).map(t => t.replace(/\r/g, '\n')), [text]); // tmux pastes newlines as CR
  } finally { kill(name); }
});

test('sendText: a short line that goes through first time is not submitted twice', async () => {
  const name = 'st-line-' + process.pid, log = path.join(tmp, 'line.log');
  await run(name, log, 0);
  try {
    await tm.sendText(name, 'halo');
    await wait(300);
    assert.deepEqual(sent(log), ['halo']);
  } finally { kill(name); }
});
