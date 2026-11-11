import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../web/js/konten-lib.js';
import { resolveNav } from '../web/js/nav-memory.js';

const it = (id, o = {}) => ({ id, title: 'T' + id, tahap: 'siap', ...o });

test('tanggal: parse ketat, Senin awal minggu, format', () => {
  assert.equal(L.validDate('2026-11-04'), true);
  assert.equal(L.validDate('2026-02-30'), false);
  assert.equal(L.validDate('04-11-2026'), false);
  assert.equal(L.mondayOf('2026-11-04'), '2026-11-02'); // Rabu
  assert.equal(L.mondayOf('2026-11-08'), '2026-11-02'); // Minggu masuk minggu sebelumnya
  assert.equal(L.mondayOf('2026-11-09'), '2026-11-09');
  assert.equal(L.fmtTanggal('2026-11-04'), '4 Nov');
  assert.equal(L.fmtTanggal('2026-11-04', true), '4 Nov 2026');
  assert.equal(L.fmtTanggal('x'), '');
  assert.equal(L.fmtTanggalPanjang('2026-11-04'), 'Rabu, 4 November 2026');
  assert.equal(L.validJam('19:00'), true); assert.equal(L.validJam('24:00'), false); assert.equal(L.validJam('9:00'), false);
});

test('monthWeeks: tiap minggu 7 hari mulai Senin dan menutup seluruh bulan', () => {
  const w = L.monthWeeks(new Date(2026, 10, 15)); // November 2026
  assert.ok(w.every(x => x.length === 7));
  assert.equal(w[0][0], '2026-10-26'); // 1 Nov 2026 hari Minggu
  assert.equal(w.at(-1)[6], '2026-12-06'); // akhir minggu yang memuat 30 Nov
  const flat = w.flat(); assert.ok(flat.includes('2026-11-01') && flat.includes('2026-11-30'));
  for (const x of w) assert.equal(L.mondayOf(x[0]), x[0]);
  const feb = L.monthWeeks(new Date(2027, 1, 1)); // Feb 2027 mulai Senin, 28 hari
  assert.equal(feb.length, 4); assert.equal(feb[0][0], '2027-02-01');
});

test('byDay: kelompok per tanggal, urut jam, abaikan arsip dan tanggal rusak', () => {
  const m = L.byDay([it('a', { publishAt: '2026-11-04', jam: '19:00' }), it('b', { publishAt: '2026-11-04', jam: '08:00' }), it('c', { publishAt: '2026-11-04' }),
    it('d', { publishAt: '2026-11-05', tahap: 'arsip' }), it('e', { publishAt: 'rusak' }), it('f')]);
  assert.deepEqual(m.get('2026-11-04').map(x => x.id), ['b', 'a', 'c']);
  assert.equal(m.size, 1);
});

test('weekStats: hitung per minggu terhadap target', () => {
  const weeks = L.monthWeeks(new Date(2026, 10, 1));
  const items = [...Array(6)].map((_, i) => it('x' + i, { publishAt: '2026-11-02' })).concat([it('y', { publishAt: '2026-11-10' }), it('z', { publishAt: '2026-11-10', tahap: 'arsip' })]);
  const s = L.weekStats(items, weeks, 5);
  const w1 = s.find(x => x.mulai === '2026-11-02'), w2 = s.find(x => x.mulai === '2026-11-09'), w0 = s[0];
  assert.deepEqual([w1.n, w1.state], [6, 'lebih']);
  assert.deepEqual([w2.n, w2.state], [1, 'kurang']);
  assert.deepEqual([w0.n, w0.state], [0, 'kurang']);
  assert.equal(L.weekStats(items, weeks, 0)[0].state, 'ok');
  const merged = L.mergeWeeks(s, [{ mulai: '2026-11-09', n: 5, target: 5 }]);
  assert.equal(merged.find(x => x.mulai === '2026-11-09').state, 'ok');
  assert.equal(L.mergeWeeks(s, undefined)[1].n, s[1].n);
});

test('gridOrder: terjadwal di atas (terjauh dulu), lalu tayang terbaru; sisanya tidak ikut', () => {
  const list = [
    it('t1', { tahap: 'tayang', platforms: { instagram: { at: '2026-10-01T10:00:00Z' } } }),
    it('t2', { tahap: 'tayang', platforms: { instagram: { at: '2026-10-20T10:00:00Z' } } }),
    it('t0', { tahap: 'tayang' }),
    it('s1', { tahap: 'terjadwal', publishAt: '2026-11-05', jam: '19:00' }),
    it('s2', { tahap: 'terjadwal', publishAt: '2026-11-12' }),
    it('s3', { tahap: 'terjadwal' }),
    it('r', { tahap: 'review' }), it('i', { tahap: 'ide' }),
  ];
  assert.deepEqual(L.gridOrder(list).map(x => x.id), ['s2', 's1', 's3', 't2', 't1', 't0']);
  assert.deepEqual(L.gridOrder(null), []);
});

test('filterItems dan reviewQueue', () => {
  const list = [it('a', { title: 'Kereta Api', seri: 'Sejarah', jenis: 'video' }), it('b', { tahap: 'review', updatedAt: '2026-11-02T00:00:00Z' }), it('c', { tahap: 'review', updatedAt: '2026-11-01T00:00:00Z', seri: 'Sejarah' })];
  assert.deepEqual(L.filterItems(list, { q: ' kereta ' }).map(x => x.id), ['a']);
  assert.deepEqual(L.filterItems(list, { seri: 'Sejarah', tahap: 'review' }).map(x => x.id), ['c']);
  assert.deepEqual(L.filterItems(list, {}).length, 3);
  assert.deepEqual(L.reviewQueue(list).map(x => x.id), ['c', 'b']); // paling lama dulu
});

test('platformsFor: carousel tanpa youtube, hormati platformTarget', () => {
  const conf = { platforms: ['instagram', 'threads', 'tiktok', 'youtube'] };
  assert.deepEqual(L.platformsFor('carousel', conf), ['instagram', 'threads', 'tiktok']);
  assert.deepEqual(L.platformsFor('video', conf), ['instagram', 'threads', 'tiktok', 'youtube']);
  assert.deepEqual(L.platformsFor('video', conf, { platformTarget: ['tiktok', 'bukan-platform'] }), ['tiktok']);
  assert.deepEqual(L.platformsFor('video', null), L.PLAT_ALL);
});

test('sortPerf: kosong selalu di bawah, arah bisa dibalik', () => {
  const rows = [{ it: it('a'), p: { reach: 100 } }, { it: it('b'), p: null }, { it: it('c'), p: { reach: 900 } }];
  assert.deepEqual(L.sortPerf(rows, 'reach', -1).map(r => r.it.id), ['c', 'a', 'b']);
  assert.deepEqual(L.sortPerf(rows, 'reach', 1).map(r => r.it.id), ['a', 'c', 'b']);
  assert.deepEqual(L.perfRows([it('a', { tahap: 'tayang', platforms: { instagram: {} } }), it('b', { tahap: 'tayang', platforms: { threads: {} } }), it('c')], 'instagram').map(r => r.it.id), ['a']);
});

test('format angka, ukuran, tanggal ISO', () => {
  assert.equal(L.fmtNum(null), '-'); assert.equal(L.fmtNum(950), '950'); assert.equal(L.fmtNum(12500), '12,5 rb'); assert.equal(L.fmtNum(2500000), '2,5 jt');
  assert.equal(L.fmtSize(0), ''); assert.equal(L.fmtSize(2048), '2 KB'); assert.equal(L.fmtSize(5 * 1048576), '5,0 MB');
  assert.equal(L.fmtAt('garbage'), ''); assert.match(L.fmtAt('2026-11-04T10:00:00Z'), /^\d+ Nov 2026$/);
  assert.equal(L.num('1.234 x'), 1234); assert.equal(L.num(''), 0);
});

test('jadwal: usulan, siap, pindah tanggal mempertahankan jam', () => {
  const list = [it('a', { jadwalStatus: 'usulan', publishAt: '2026-11-04', tahap: 'terjadwal' }), it('b', { jadwalStatus: 'fix', publishAt: '2026-11-05', tahap: 'terjadwal' }), it('c'), it('d', { publishAt: '2026-11-06' })];
  assert.deepEqual(L.usulanIds(list), ['a']);
  assert.deepEqual(L.siapList(list).map(x => x.id), ['c']);
  assert.deepEqual(L.moveBody({ jam: '08:30' }, '2026-11-09', { jamDefault: '19:00' }), { publishAt: '2026-11-09', jam: '08:30' });
  assert.deepEqual(L.moveBody({}, '2026-11-09', { jamDefault: '20:00' }), { publishAt: '2026-11-09', jam: '20:00' });
  assert.deepEqual(L.moveBody({}, '2026-11-09', null), { publishAt: '2026-11-09', jam: '19:00' });
  assert.match(L.peringatanText({ kode: 'target-kurang', tanggal: '2026-11-02' }), /Kurang dari target.*2 Nov/);
  assert.equal(L.peringatanText({ kode: 'aneh', pesan: 'Pesan server' }), 'Pesan server');
});

test('rute: /konten, /konten/<sub>, /konten/p/<cid>', () => {
  assert.deepEqual(L.parseRoute([]), { sub: '', cid: null });
  assert.deepEqual(L.parseRoute(['kalender']), { sub: 'kalender', cid: null });
  assert.deepEqual(L.parseRoute(['bukan']), { sub: '', cid: null });
  assert.deepEqual(L.parseRoute(['p', 'abc123']), { sub: 'galeri', cid: 'abc123' });
  assert.deepEqual(L.parseRoute(['p']), { sub: '', cid: null });
  assert.equal(L.hashFor('k1', '', 'c 1'), '#/o/k1/konten/p/c%201');
  assert.equal(L.hashFor('k1', 'grid'), '#/o/k1/konten/grid');
  assert.equal(L.hashFor('k1'), '#/o/k1/konten');
});

test('nav-memory: link konten/p/<cid> eksplisit tidak ditimpa ingatan tab; tab konten diingat', () => {
  const ok = { tab: k => k === 'konten' || k === 'board', session: () => false };
  // link eksplisit dengan rest tetap utuh
  assert.equal(resolveNav({ id: 'k1', tab: 'konten', explicit: true, rest: ['p', 'c1'] }, null, { tab: 'board', sid: '' }, ok), null);
  // buka kantor tanpa tab: ikut tab terakhir (konten)
  assert.deepEqual(resolveNav({ id: 'k1', tab: 'kantor', explicit: false, rest: [] }, null, { tab: 'konten', sid: '' }, ok), { tab: 'konten', rest: [], usedPending: false });
});

test('sig dan restoreValue: isian kotor menang atas server, bersih ikut server', () => {
  assert.equal(L.sig({ a: 1 }), L.sig({ a: 1 })); assert.notEqual(L.sig({ a: 1 }), L.sig({ a: 2 }));
  const snap = { 'cap-instagram': { v: 'draf saya', dirty: true }, lagu: { v: 'lama', dirty: false } };
  assert.equal(L.restoreValue(snap, 'cap-instagram', 'dari server'), 'draf saya');
  assert.equal(L.restoreValue(snap, 'lagu', 'baru'), 'baru');
  assert.equal(L.restoreValue(snap, 'tak-ada', 'x'), 'x');
});
