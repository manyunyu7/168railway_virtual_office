// Server-rendered pages for akun mode: sign in (/masuk) and accept an invite (/undangan). No scripts at all.
import qrcode from 'qrcode-generator';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE = `:root{--bg:#FBF4EA;--card:#FFFCF7;--line:#E8DDCD;--ink:#1F1628;--sub:#675A6D;--acc:#F59A3C;--acc-ink:#3A240F;--err-bg:#F9E0DA;--err:#8E2F1F}
@media (prefers-color-scheme:dark){:root{--bg:#1A1420;--card:#241C2B;--line:#3A3042;--ink:#F3ECF5;--sub:#B7A9BC;--err-bg:#4A2320;--err:#FFC9BE}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:20px 16px;box-sizing:border-box}
form{box-sizing:border-box;width:100%;max-width:400px;display:grid;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}
h1{margin:0;font-size:22px}p{margin:0;color:var(--sub);font-size:14px}label{font-weight:600;font-size:14px}
input{font:15px system-ui,sans-serif;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);width:100%;box-sizing:border-box}
input.code{font:20px ui-monospace,Menlo,monospace;letter-spacing:.3em;text-align:center}
button{min-height:48px;border:0;border-radius:12px;background:var(--acc);color:var(--acc-ink);font:700 16px system-ui,sans-serif;cursor:pointer}
.err{background:var(--err-bg);color:var(--err);border-radius:10px;padding:10px 12px;font-size:14px}
.qr{background:#fff;border-radius:12px;padding:12px;justify-self:center;line-height:0}.qr svg{width:200px;height:200px}
.secret{font:14px ui-monospace,Menlo,monospace;word-break:break-all;background:var(--bg);border:1px dashed var(--line);border-radius:10px;padding:10px;text-align:center;color:var(--ink)}
ol{margin:0;padding-left:20px;color:var(--sub);font-size:14px}a{color:inherit}`;

const shell = (title, inner) => `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${inner}</body></html>`;

export function loginHtml({ error = '', username = '', next = '' } = {}) {
  return shell('Masuk · Kantor Claude', `<form method="post" action="/masuk" autocomplete="on">
<h1>Kantor Claude</h1><p>Masuk dengan akun yang dibuat admin kantor.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<input type="hidden" name="next" value="${esc(next)}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required value="${esc(username)}" ${username ? '' : 'autofocus'}>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required ${username ? 'autofocus' : ''}>
<label for="c">Kode 2FA</label><input id="c" name="code" class="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" required placeholder="000000">
<button type="submit">Masuk</button>
<p>Lupa password atau HP hilang? Minta admin mengirim ulang undangan.</p></form>`);
}

function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export function inviteHtml({ token, info, error = '' }) {
  if (!info) return shell('Undangan · Kantor Claude', `<form><h1>Undangan tidak berlaku</h1><p>Link ini sudah dipakai, kedaluwarsa, atau salah salin. Minta admin kantor membuat undangan baru.</p><p><a href="/masuk">Ke halaman masuk</a></p></form>`);
  const m = info.member;
  return shell('Undangan · Kantor Claude', `<form method="post" action="/undangan" autocomplete="off">
<h1>Halo, ${esc(m.name)}</h1><p>Buat password dan pasang 2FA untuk akun <b>${esc(m.username)}</b>.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<input type="hidden" name="k" value="${esc(token)}">
<input type="text" name="username" value="${esc(m.username)}" autocomplete="username" hidden>
<label for="p1">Password baru</label><input id="p1" name="password" type="password" autocomplete="new-password" minlength="10" required autofocus>
<label for="p2">Ulangi password</label><input id="p2" name="password2" type="password" autocomplete="new-password" minlength="10" required>
<p>Minimal 10 karakter. Kalimat pendek yang mudah kamu ingat lebih kuat daripada kata acak yang pendek.</p>
<ol><li>Buka Google Authenticator, Authy, atau 1Password di HP.</li><li>Scan QR ini, atau ketik kuncinya manual.</li><li>Masukkan 6 digit yang muncul.</li></ol>
<div class="qr" role="img" aria-label="QR kode 2FA">${qrSvg(info.otpauth)}</div>
<div class="secret" aria-label="Kunci 2FA">${esc(info.secret.replace(/(.{4})/g, '$1 ').trim())}</div>
<p><a href="${esc(info.otpauth)}">Buka di aplikasi authenticator</a> (kalau halaman ini dibuka di HP).</p>
<label for="c">Kode 2FA</label><input id="c" name="code" class="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" required placeholder="000000">
<button type="submit">Aktifkan akun</button></form>`);
}
