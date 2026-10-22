// Images in the drawer chat: Codex rollout image items, the transcript tail across a huge base64 line, and the image endpoint's path guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-img-')));
process.env.KANTOR_HOME = path.join(tmp, 'home');
process.env.CODEX_HOME = path.join(tmp, 'codex');
fs.mkdirSync(process.env.KANTOR_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.KANTOR_HOME, 'config.json'), JSON.stringify({ roots: [tmp], token: 'x' }));
const cx = await import('../server/codex.js');
const att = await import('../server/attachments.js');
const { live } = await import('../server/live.js');
const { globalDb, run } = await import('../server/db.js');

// Trimmed from a real rollout (2026-09-14): base64 `result` shortened, prompt shortened.
const GEN = { timestamp: '2026-09-14T06:56:04.614Z', type: 'event_msg', payload: { type: 'item_completed', thread_id: 't', turn_id: 'u',
  item: { type: 'Extension', kind: 'image_gen.generation', id: 'exec-2c67', status: 'completed', revisedPrompt: 'Edit this source photograph into a clean texture crop',
    result: 'iVBORw0KGgoAAAANSUhEUg', transparentBackground: false, failure: null, savedPath: '/Users/x/.codex/generated_images/t/exec-2c67.png' } } };
const VIEW = { timestamp: '2026-10-08T15:04:29.730Z', type: 'event_msg', payload: { type: 'item_completed',
  item: { type: 'ImageView', id: 'exec-0b0d', path: 'file:///Users/x/proj/hp/23%20meja.png' } } };
const USER = { timestamp: '2026-09-14T06:53:45.203Z', type: 'event_msg', payload: { type: 'item_completed',
  item: { type: 'UserMessage', id: 'm', content: [{ type: 'local_image', path: '/var/folders/T/codex-clipboard-A.png' }, { type: 'text', text: 'pakai ini [Image #1]' }] } } };

test('rolloutItems maps Codex image generation, image views and pasted images to {k:image} without base64', () => {
  const g = cx.rolloutItems(GEN, () => '');
  assert.deepEqual(g, [{ k: 'image', src: 'gen', path: '/Users/x/.codex/generated_images/t/exec-2c67.png', name: 'exec-2c67.png', s: 'Edit this source photograph into a clean texture crop', at: GEN.timestamp }]);
  assert.ok(!JSON.stringify(g).includes('iVBOR'));
  assert.deepEqual(cx.rolloutItems(VIEW, () => ''), [{ k: 'image', src: 'view', path: '/Users/x/proj/hp/23 meja.png', name: '23 meja.png', at: VIEW.timestamp }]);
  const u = cx.rolloutItems(USER, () => '');
  assert.equal(u.length, 2);
  assert.deepEqual(u[0], { k: 'image', src: 'user', path: '/var/folders/T/codex-clipboard-A.png', name: 'codex-clipboard-A.png', at: USER.timestamp });
  assert.equal(u[1].k, 'user');
  const failed = cx.rolloutItems({ ...GEN, payload: { ...GEN.payload, item: { ...GEN.payload.item, status: 'failed', savedPath: null, failure: 'kebijakan' } } }, () => '');
  assert.deepEqual(failed.map(i => [i.k, i.err]), [['result', true]]);
  assert.deepEqual(cx.rolloutItems({ ...GEN, payload: { ...GEN.payload, item: { type: 'Extension', kind: 'other' } } }, () => ''), []);
});

test('readRollout keeps an image line that is bigger than the tail window', () => {
  const f = path.join(tmp, 'rollout.jsonl');
  const big = { ...GEN, payload: { ...GEN.payload, item: { ...GEN.payload.item, result: 'A'.repeat(2 * 1024 * 1024) } } };
  const say = { timestamp: '2026-09-14T06:57:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'output_text', text: 'sudah' }] } } };
  fs.writeFileSync(f, [JSON.stringify({ type: 'session_meta' }), JSON.stringify(big), JSON.stringify(say)].join('\n') + '\n');
  const r = cx.readRollout(f, 50, () => '');
  assert.deepEqual(r.items.map(i => i.k), ['image', 'text']);
  assert.equal(r.items[0].src, 'gen');
});

test('resolveImage serves only image files inside the allowed roots', () => {
  const root = path.join(tmp, 'kerja'), out = path.join(tmp, 'luar');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'rahasia.txt'), 'x');
  fs.writeFileSync(path.join(root, 'b.svg'), '<svg/>');
  fs.writeFileSync(path.join(out, 'c.png'), 'x');
  fs.symlinkSync(path.join(out, 'c.png'), path.join(root, 'link.png'));
  fs.symlinkSync(path.join(root, 'rahasia.txt'), path.join(root, 'kedok.png'));
  const roots = [root];
  assert.equal(att.resolveImage(path.join(root, 'a.png'), roots), path.join(root, 'a.png'));
  assert.equal(att.resolveImage('file://' + path.join(root, 'a.png'), roots), path.join(root, 'a.png'));
  const code = (p) => { try { att.resolveImage(p, roots); return 0; } catch (e) { return e.code; } };
  assert.equal(code(path.join(root, 'rahasia.txt')), 400); // not an image
  assert.equal(code(path.join(root, 'b.svg')), 400); // svg can carry script
  assert.equal(code(path.join(out, 'c.png')), 403); // outside the roots
  assert.equal(code(path.join(root, '..', 'luar', 'c.png')), 403); // traversal
  assert.equal(code(path.join(root, 'link.png')), 403); // symlink leading out
  assert.equal(code(path.join(root, 'kedok.png')), 400); // symlink to a non-image
  assert.equal(code('a.png'), 400); // relative
  assert.equal(code(path.join(root, 'tidak-ada.png')), 404);
  assert.ok(att.imageRoots('tidak-dikenal').includes(fs.realpathSync(os.tmpdir())));
});

test('files sent from a Codex shift land on the session id Codex gave it, and older ones still list', () => {
  const at = '2026-10-21T14:15:41.315Z';
  run(globalDb(), 'INSERT INTO sessions (sid, office, cwd, tmux, started_at, last_seen, status, source) VALUES (?,?,?,?,?,?,?,?)', 'launch', null, tmp, 'kc-x', at, at, 'ended', 'kantor');
  run(globalDb(), 'INSERT INTO sessions (sid, office, cwd, tmux, started_at, last_seen, status, source) VALUES (?,?,?,?,?,?,?,?)', 'codex-real', null, tmp, 'kc-x', at, at, 'working', 'kantor');
  live.set('codex-real', { sid: 'codex-real', tmux: 'kc-x', status: 'working' });
  try {
    assert.equal(att.currentSid('launch'), 'codex-real');
    assert.equal(att.currentSid('codex-real'), 'codex-real');
    assert.equal(att.currentSid('lain'), 'lain');
    run(globalDb(), "INSERT INTO attachments (id, sid, office, dir, path, name, mime, size, caption, at, meta) VALUES ('a1', 'launch', null, 'out', ?, 'x.png', 'image/png', 1, '', ?, '{}')", path.join(tmp, 'x.png'), at);
    assert.deepEqual(att.listAttachments('codex-real').items.map(i => i.id), ['a1']);
  } finally { live.delete('codex-real'); }
});
