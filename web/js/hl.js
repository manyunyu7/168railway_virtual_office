// Pewarna kode ringan untuk blok ``` di Chat: komentar, string, angka, kata kunci. Tanpa pustaka luar;
// cukup untuk membaca cepat, bukan parser sungguhan. Bahasa tak dikenal memakai aturan umum.
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const words = s => new Set(s.split(' '));

const KW = {
  js: words('const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of this super null undefined true false yield delete void static get set interface type enum implements readonly as'),
  py: words('def return if elif else for while in not and or is import from as class try except finally raise with lambda yield pass break continue global nonlocal None True False async await self'),
  sh: words('if then else elif fi for while do done case esac in function return local export source echo exit set unset readonly shift sudo cd'),
  dart: words('class extends implements with mixin final const var void return if else for while do switch case break continue new import export library part show hide async await yield try catch finally throw this super null true false late required static get set enum typedef dynamic factory override is as'),
  php: words('function return if else elseif foreach for while do switch case break continue new class extends implements use namespace public private protected static const try catch finally throw echo null true false array fn match'),
  go: words('func return if else for range switch case break continue go defer chan map struct interface type package import var const select default fallthrough nil true false'),
  sql: words('select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on group by order having limit offset as distinct null is in like between case when then else end primary key foreign references default unique begin commit'),
  css: words('important media supports keyframes from to'),
};
const ALIAS = { javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', json: 'js', mjs: 'js', cjs: 'js', python: 'py', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', golang: 'go', yaml: 'yml', yml: 'yml', patch: 'diff' };

// urutan penting: komentar dan string dulu supaya kata kunci di dalamnya tidak ikut diwarnai
const COMMENT = { js: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', dart: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', go: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', php: '\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/',
  css: '\\/\\*[\\s\\S]*?\\*\\/', py: '#[^\\n]*', sh: '#[^\\n]*', yml: '#[^\\n]*', sql: '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' };
const STRING = '`(?:\\\\[\\s\\S]|[^`\\\\])*`|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'';
const NUMBER = '\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b';

/** HTML berwarna untuk satu blok kode; selalu sudah di-escape. */
export function hl(code, lang = '') {
  const l = ALIAS[lang.toLowerCase()] || lang.toLowerCase();
  if (l === 'diff') return code.split('\n').map(line => {
    const c = /^\+(?!\+\+)/.test(line) ? 'hl-add' : /^-(?!--)/.test(line) ? 'hl-del' : /^@@/.test(line) ? 'hl-k' : '';
    return c ? `<span class="${c}">${esc(line)}</span>` : esc(line);
  }).join('\n');
  const kw = KW[l] || null;
  const cm = COMMENT[l] || (kw ? '' : '\\/\\/[^\\n]*|#[^\\n]*');
  const re = new RegExp(`(${cm || '(?!)'})|(${STRING})|(${NUMBER})|([A-Za-z_$][\\w$]*)`, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [t, c, s, n, w] = m;
    if (c) out += `<span class="hl-c">${esc(t)}</span>`;
    else if (s) out += `<span class="hl-s">${esc(t)}</span>`;
    else if (n) out += `<span class="hl-n">${esc(t)}</span>`;
    else if (w && kw?.has(l === 'sql' ? w.toLowerCase() : w)) out += `<span class="hl-k">${esc(t)}</span>`;
    else out += esc(t);
    last = m.index + t.length;
    if (!t.length) re.lastIndex++;
  }
  return out + esc(code.slice(last));
}
