import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrefs, chatVars, stepPref, TERM_THEMES, TERM_FACES, CHAT_WALLS, spriteUri } from '../web/js/view-prefs.js';

test('nilai rusak kembali ke bawaan, nilai sah dipakai', () => {
  const p = cleanPrefs({ chatFs: 99, chatCode: '13', chatLh: 3, chatW: 'x', termFs: 16, termLh: 1.3 });
  assert.deepEqual(p, { chatFs: 0, chatCode: 13, chatLh: 1.5, chatW: 'normal', termFs: 16, termLh: 1.3, termTheme: 'kantor', termFace: 'jetbrains', chatWall: 'polos', chatBub: 'kantor', chatMe: 'hijau', chatPeek: 'none' });
});

test('bawaan tidak mengisi variabel CSS supaya ukuran HP dan desktop tetap', () => {
  assert.ok(Object.values(chatVars(cleanPrefs())).every(v => v === ''));
  const v = chatVars(cleanPrefs({ chatFs: 16, chatW: 'lebar' }));
  assert.equal(v['--ch-fs'], '16px');
  assert.equal(v['--ch-col'], '1100px');
});

test('langkah mulai dari ukuran yang terlihat dan berhenti di batas', () => {
  assert.equal(stepPref('chatFs', 0, 14.5, 1), 15);
  assert.equal(stepPref('chatFs', 22, 14.5, 1), 22);
  assert.equal(stepPref('termFs', 9, 9, -1), 9);
});

test('preset tema terminal: nama tak dikenal kembali ke Kantor, tiap preset lengkap 16 warna ANSI', () => {
  assert.equal(cleanPrefs({ termTheme: 'dracula' }).termTheme, 'dracula');
  assert.equal(cleanPrefs({ termTheme: 'toString' }).termTheme, 'kantor');
  for (const [k, t] of Object.entries(TERM_THEMES)) {
    for (const c of ['background', 'foreground', 'cursor', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightWhite']) assert.match(t.theme[c], /^#[0-9A-F]{6}$/i, `${k}.${c}`);
  }
});

test('font terminal: pilihan sah dipakai, sisanya kembali ke JetBrains Mono', () => {
  assert.equal(cleanPrefs({ termFace: 'ubuntu' }).termFace, 'ubuntu');
  assert.equal(cleanPrefs({ termFace: 'comic' }).termFace, 'jetbrains');
  for (const [k, f] of Object.entries(TERM_FACES)) if (k !== 'jetbrains') assert.match(f.gf, /^[A-Za-z+]+:wght@[\d;]+$/, k);
});

test('tampilan chat: pilihan sah dipakai, maskot jadi SVG pixel', () => {
  const p = cleanPrefs({ chatWall: 'malam', chatBub: 'pixel', chatMe: 'gradasi', chatPeek: 'kodok' });
  assert.deepEqual([p.chatWall, p.chatBub, p.chatMe, p.chatPeek], ['malam', 'pixel', 'gradasi', 'kodok']);
  const q = cleanPrefs({ chatWall: 'hutan', chatBub: 'x', chatMe: 'merah', chatPeek: 'naga' });
  assert.deepEqual([q.chatWall, q.chatBub, q.chatMe, q.chatPeek], ['polos', 'kantor', 'hijau', 'none']);
  assert.ok(Object.keys(CHAT_WALLS).includes('foto'));
  assert.match(spriteUri('kucing'), /^url\("data:image\/svg\+xml,/);
  assert.equal(spriteUri('none'), '');
  assert.ok(Object.keys(TERM_THEMES).length >= 15);
});
