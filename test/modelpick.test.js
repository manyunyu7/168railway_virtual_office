import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-mp-'));
process.env.KANTOR_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));
const mp = await import('../server/modelpick.js');
const tm = await import('../server/tmux.js');

const MODELS = [['Default (recommended)', 'Sonnet 5.5 · Efficient'], ['Opus 5.5', 'For complex work'], ['Fable 5.1', 'Toughest'], ['Sonnet 5.5', 'Efficient', 1], ['Haiku 5.5', 'Fastest'], ['Haiku 4.5', 'Fastest'],
  ['Sonnet 5', 'Routine'], ['Opus 5', 'Complex'], ['Fable 5', 'Hardest'], ['Opus 4.8', 'Complex'], ['Opus 4.6', 'Complex'], ['Sonnet 4.6', 'Routine'], ['Sonnet 4.5', 'Routine']];

// a stand-in for the real picker: window of 10, wrap-around arrows, `s` = this session only, digits = save as default
const fake = path.join(tmp, 'fake-picker.js');
fs.writeFileSync(fake, `
const M = ${JSON.stringify(MODELS)}; let cur = M.findIndex(m => m[2]), active = cur, open = false, msg = '';
const W = 10;
function draw() {
  process.stdout.write('\\x1b[2J\\x1b[H');
  if (!open) { console.log('> ' + msg); console.log('─'.repeat(60)); console.log('  ⏵⏵ auto mode on (shift+tab to cycle)'); return; }
  console.log('─'.repeat(60)); console.log('   Select model'); console.log('   Switch between Claude models.');
  const top = Math.max(0, Math.min(M.length - W, cur - 5));
  M.slice(top, top + W).forEach((m, k) => { const i = top + k;
    const mark = k === 0 && top > 0 ? '↑' : k === W - 1 && top + W < M.length ? '↓' : ' ';
    console.log((i === cur ? '   ❯ ' : '   ' + mark + ' ') + (String(i + 1) + '.').padEnd(4) + m[0] + (i === active ? ' ✔' : '') + '          ' + m[1]); });
  if (top + W < M.length) console.log('      … +' + (M.length - top - W) + ' models');
  console.log('   Enter to set as default · s to use this session only · Esc to cancel');
}
process.stdin.setRawMode(true); process.stdin.resume(); let buf = '';
process.stdin.on('data', d => { buf += d.toString();
  if (!open) { if (buf.includes('\\r')) { if (/\\/model/.test(buf)) open = true; buf = ''; draw(); } return; }
  if (buf === '\\x1b') { setTimeout(() => { if (buf === '\\x1b') { open = false; msg = 'Kept model as ' + M[active][0]; buf = ''; draw(); } }, 80); return; }
  if (buf === '\\x1b[B') cur = (cur + 1) % M.length; else if (buf === '\\x1b[A') cur = (cur - 1 + M.length) % M.length;
  else if (buf === 's') { active = cur; open = false; msg = 'Set model to ' + M[cur][0] + ' for this session only'; }
  else if (/^\\d$/.test(buf)) { active = +buf - 1; open = false; msg = 'SAVED DEFAULT'; }
  else if (buf.startsWith('\\x1b')) return;
  buf = ''; draw(); });
draw();
`);

const NAME = 'mp-test-' + process.pid;
const start = () => { tm.tmux(['new-session', '-d', '-s', NAME, '-x', '160', '-y', '40', `${process.execPath} ${fake}`]); };
const stop = () => { try { tm.tmux(['kill-session', '-t', NAME]); } catch {} };
const wait = ms => new Promise(r => setTimeout(r, ms));

test('parsePicker reads rows, cursor, active and scroll arrows', () => {
  const rows = mp.parsePicker(`junk
   Select model
     1.  Default (recommended)  Sonnet 5.5 · Efficient for routine tasks
   ❯ 4.  Sonnet 5.5 ✔           Most efficient for simpler tasks
   ↓ 10. Opus 4.8               Best for everyday
      … +3 models
   Enter to set as default · s to use this session only · Esc to cancel`);
  assert.deepEqual(rows.map(r => r.index), [1, 4, 10]);
  assert.equal(rows[0].label, 'Default (recommended)');
  assert.equal(rows[0].desc, 'Sonnet 5.5 · Efficient for routine tasks');
  assert.equal(rows[1].cursor, true); assert.equal(rows[1].current, true); assert.equal(rows[1].label, 'Sonnet 5.5');
  assert.equal(mp.parsePicker('no picker here'), null);
});

test('open lists all rows past the scroll window, select moves with wrap and uses session-only', async () => {
  start();
  try {
    await wait(1200);
    const { options } = await mp.openPicker(NAME);
    assert.equal(options.length, MODELS.length);
    assert.equal(options.find(o => o.current).label, 'Sonnet 5.5');
    assert.equal(options.at(-1).label, 'Sonnet 4.5');
    // far target: wraps backward
    const r = await mp.selectOption(NAME, 13);
    assert.equal(r.model, 'Sonnet 4.5');
    assert.ok(!/SAVED DEFAULT/.test(tm.tmux(['capture-pane', '-p', '-t', NAME])));
    // reopen, pick a middle one, then check cancel path
    const again = await mp.openPicker(NAME);
    assert.equal(again.options.find(o => o.current).label, 'Sonnet 4.5');
    assert.equal((await mp.selectOption(NAME, 2)).model, 'Opus 5.5');
    await mp.openPicker(NAME);
    await mp.cancelPicker(NAME);
    await wait(300);
    assert.match(tm.tmux(['capture-pane', '-p', '-t', NAME]), /Kept model as Opus 5\.5/);
    await assert.rejects(() => mp.selectOption(NAME, 3), /sudah tertutup/);
  } finally { stop(); }
});
