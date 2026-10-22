// Kosakata tampilan karakter + template + acak. Dipakai editor role, wizard, dan avatar.
import { SWATCHES, SKINS, HAIRS } from './util.js';

export const HAIR_STYLES = { short: 'Pendek', long: 'Panjang', ponytail: 'Kuncir kuda', bob: 'Bob', bun: 'Cepol', pigtails: 'Kuncir dua', curly: 'Keriting', hijab: 'Hijab' };
export const OUTFITS = { kemeja: 'Kemeja + celana', rok: 'Blus + rok', dress: 'Dress', hoodie: 'Hoodie', jas: 'Jas' };
export const ACCS = { '': 'Tanpa aksesori', kacamata: 'Kacamata', anting: 'Anting', topi: 'Topi' };
export const HIJABS = ['#E8EEF8', '#2F5D9E', '#C2417A', '#2C8452', '#7A3E9D', '#F2D7DC', '#55606E', '#1F1F26'];
export const LOOK_KEYS = ['color', 'hair', 'skin', 'hairStyle', 'outfit', 'acc', 'hijab', 'tie'];
const FEM = ['long', 'ponytail', 'bob', 'bun', 'pigtails', 'curly', 'hijab'];

const T = (id, name, hairStyle, outfit, acc, color, hair, skin, extra = {}) => ({ id, name, look: { hairStyle, outfit, acc, color, hair, skin, hijab: '#E8EEF8', tie: false, ...extra } });
/** "Template karakter": a one-click look. At least half feminine, skin tones mixed. */
export const TEMPLATES = [
  T('hijab-biru', 'Hijab biru', 'hijab', 'dress', '', '#7A3E9D', '#2B1D14', '#D9A47C', { hijab: '#2F5D9E' }),
  T('hijab-pastel', 'Hijab pastel', 'hijab', 'jas', 'kacamata', '#55606E', '#2B1D14', '#F1C9A5', { hijab: '#F2D7DC' }),
  T('panjang', 'Rambut panjang', 'long', 'kemeja', 'anting', '#C2417A', '#2B1D14', '#E8B98F'),
  T('kuncir', 'Kuncir kuda', 'ponytail', 'rok', '', '#1C7379', '#5A3A22', '#F1C9A5'),
  T('bob', 'Bob', 'bob', 'jas', 'anting', '#BC3B34', '#1E1E24', '#D9A47C'),
  T('cepol', 'Cepol', 'bun', 'dress', '', '#2C8452', '#3D2B4F', '#B97E57'),
  T('kuncir-dua', 'Kuncir dua', 'pigtails', 'hoodie', '', '#C2417A', '#C9A15A', '#F1C9A5'),
  T('keriting', 'Keriting', 'curly', 'rok', 'kacamata', '#A9620F', '#2B1D14', '#8D5A3B'),
  T('rok-kantor', 'Rok kantor', 'long', 'rok', 'anting', '#2F5D9E', '#7A4B2A', '#D9A47C'),
  T('sporty', 'Sporty', 'ponytail', 'hoodie', 'topi', '#BC3B34', '#1E1E24', '#E8B98F'),
  T('berkacamata', 'Berkacamata', 'short', 'kemeja', 'kacamata', '#2F5D9E', '#1E1E24', '#E8B98F'),
  T('hoodie', 'Hoodie', 'short', 'hoodie', '', '#55606E', '#7A4B2A', '#B97E57'),
  T('manager', 'Manager berdasi', 'short', 'jas', '', '#2F5D9E', '#2B1D14', '#D9A47C', { tie: true }),
  T('klasik', 'Klasik', 'short', 'kemeja', '', '#2C8452', '#5A3A22', '#F1C9A5'),
  T('bertopi', 'Bertopi', 'short', 'kemeja', 'topi', '#A9620F', '#7A4B2A', '#8D5A3B'),
];

/** Merge a look into target (only the look fields); fills defaults so old roles keep working. */
export function applyLook(target, look) {
  for (const k of LOOK_KEYS) if (look[k] !== undefined) target[k] = look[k];
  target.outfit ||= 'kemeja'; target.acc ||= ''; target.hijab ||= HIJABS[0]; target.hairStyle ||= 'short';
  if (target.hairStyle === 'hijab' && target.acc === 'topi') target.acc = '';
  return target;
}
export const templateOf = id => TEMPLATES.find(t => t.id === id);

function rng(seed) { // mulberry32; no seed -> Math.random
  if (seed === undefined || seed === null) return Math.random;
  let a = typeof seed === 'number' ? seed >>> 0 : [...String(seed)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const wpick = (r, pairs) => { let t = pairs.reduce((s, [, w]) => s + w, 0) * r(); for (const [v, w] of pairs) if ((t -= w) < 0) return v; return pairs[0][0]; };
/** A balanced random look: ~half feminine, coherent colours, hijab never with a cap. opts.fem forces a side. */
export function randomLook(seed, opts = {}) {
  const r = rng(seed), fem = opts.fem ?? r() < .5;
  const hairStyle = fem ? wpick(r, [['long', 3], ['ponytail', 3], ['bob', 3], ['bun', 2], ['pigtails', 2], ['curly', 2], ['hijab', 2.2], ['short', .6]]) : wpick(r, [['short', 8], ['curly', 1]]);
  const outfit = fem ? wpick(r, [['rok', 3], ['dress', 3], ['jas', 2], ['kemeja', 2], ['hoodie', 1.5]]) : wpick(r, [['kemeja', 5], ['hoodie', 2], ['jas', 2]]);
  let acc = wpick(r, fem ? [['', 4], ['anting', 3], ['kacamata', 2], ['topi', 1]] : [['', 5], ['kacamata', 2.5], ['topi', 1.5]]);
  if (hairStyle === 'hijab' && acc === 'topi') acc = '';
  const color = pick(r, SWATCHES), skin = pick(r, SKINS), hair = pick(r, HAIRS);
  const hijab = pick(r, HIJABS.filter(h => h.toLowerCase() !== color.toLowerCase()));
  const tie = !fem && (outfit === 'jas' ? r() < .7 : outfit === 'kemeja' && r() < .3);
  return { hairStyle, outfit, acc, color, hair, skin, hijab, tie };
}
export const isFemStyle = s => FEM.includes(s);
