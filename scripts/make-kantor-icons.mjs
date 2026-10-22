// Generate ikon PWA Kantor Claude (PNG) dari logo pixel di web/index.html, tanpa dependensi.
// Jalankan: node scripts/make-kantor-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(import.meta.dirname, '..', 'web', 'icons');
const BG = [0xFB, 0xF4, 0xEA];
const ORANGE = [0xF5, 0x9A, 0x3C];
const ROOF = [0x1F, 0x16, 0x28];
const CREAM = [0xFF, 0xFC, 0xF7];

// Logo asli dalam grid 16x16 (sama dengan favicon di web/index.html).
const RECTS = [
  { x: 2, y: 5, w: 12, h: 10, c: ORANGE },
  { x: 0, y: 3, w: 16, h: 3, c: ROOF },
  { x: 4, y: 8, w: 3, h: 3, c: CREAM },
  { x: 9, y: 8, w: 3, h: 3, c: CREAM },
];

// Logo dalam grid 16 unit, tinggi 12 unit (y 3..15). Ukuran lebar logo = frac * sisi ikon.
// "any" boleh memenuhi ~78%; maskable harus di dalam zona aman lingkaran 80%, jadi lebih kecil.
function render(size, frac) {
  const unit = (size * frac) / 16;
  const ox = (size - 16 * unit) / 2;
  const oy = (size - 12 * unit) / 2 - 3 * unit;
  const SS = 3; // supersampling per sisi untuk tepi yang halus
  const px = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let pX = 0; pX < size; pX++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = pX + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          let c = BG;
          for (const r of [...RECTS].reverse()) { // yang terakhir digambar di atas
            const rx = ox + r.x * unit, ry = oy + r.y * unit;
            if (x >= rx && x < rx + r.w * unit && y >= ry && y < ry + r.h * unit) { c = r.c; break; }
          }
          acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
      }
      const n = SS * SS, i = (py * size + pX) * 3;
      px[i] = Math.round(acc[0] / n); px[i + 1] = Math.round(acc[1] / n); px[i + 2] = Math.round(acc[2] / n);
    }
  }
  return px;
}

function encodePng(size, rgb) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const targets = [
  { name: 'icon-192.png', size: 192, frac: 0.78 },
  { name: 'icon-512.png', size: 512, frac: 0.78 },
  { name: 'icon-maskable-192.png', size: 192, frac: 0.6 },
  { name: 'icon-maskable-512.png', size: 512, frac: 0.6 },
  { name: 'apple-touch-icon.png', size: 180, frac: 0.78 },
];
for (const t of targets) {
  fs.writeFileSync(path.join(OUT, t.name), encodePng(t.size, render(t.size, t.frac)));
  console.log(`tulis web/icons/${t.name} (${t.size}x${t.size})`);
}
