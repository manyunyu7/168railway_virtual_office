import { esc, api, post, toast, modal, closeModal } from './util.js';

/** Isi awal playbook baru. */
export const PB_TEMPLATE = `## Kapan dipakai
Situasi yang memicu prosedur ini.

## Sebelum mulai
- [ ] Prasyarat pertama
- [ ] Prasyarat kedua

## Langkah
1. Langkah pertama
2. Langkah kedua
3. Langkah ketiga

## Cek sesudahnya
- [ ] Apa yang harus dipastikan sudah beres

## Kalau gagal (rollback)
Cara membatalkan dan siapa yang dikabari.
`;

const base = ctx => (ctx.office.id === '_kompleks' ? '#/kompleks' : '#/o/' + ctx.office.id);

/** Playbook milik satu role: [{slug,title,icon,roles,when,always,approval}] */
export async function loadPlaybooks(ctx, roleId) {
  try { return await api(`/api/offices/${encodeURIComponent(ctx.office.id)}/playbooks${roleId ? '?role=' + encodeURIComponent(roleId) : ''}`) || []; }
  catch { return []; }
}

export const pbFlags = p => `${p.always ? '<span class="chip pb-flag">Selalu dibacakan</span>' : ''}${p.approval ? '<span class="chip pb-flag warn">Minta persetujuan</span>' : ''}`;

/** Daftar playbook satu role + tombol tambah (data-act="pb-new" ditangani onPbClick). */
export function playbookListHTML(ctx, role, list) {
  const items = list.map(p => `<li><a href="${base(ctx)}/wiki/${encodeURIComponent(p.slug)}"><span class="pb-li-t">${esc(p.icon || '📘')} <b>${esc(p.title)}</b></span>${p.when ? `<span class="pb-li-w">${esc(p.when)}</span>` : ''}${pbFlags(p) ? `<span class="pb-li-f">${pbFlags(p)}</span>` : ''}</a></li>`).join('');
  return `${items ? `<ul class="pb-ul">${items}</ul>` : `<p class="hint">${esc(role.name)} belum memegang playbook.</p>`}
    <button class="btn sm" data-act="pb-new" data-role="${esc(role.id)}">+ Playbook untuk ${esc(role.name)}</button>`;
}

/** Buat halaman playbook dari template untuk role itu, lalu buka. */
export function newPlaybookFor(ctx, role, done) {
  modal({
    title: `Playbook baru untuk ${role.name}`,
    html: `<div class="field"><label for="pbNewT">Judul</label><input id="pbNewT" type="text" placeholder="mis. Deploy web" maxlength="80" autocomplete="off"></div>
      <p class="hint">Halaman dibuat dari template (kapan dipakai, langkah, rollback) dan dipegang ${esc(role.name)}.</p>`,
    actions: [{ label: 'Buat', kind: 'primary', fn: () => { create(ctx, role, done); return false; } }, { label: 'Batal' }],
  });
}
async function create(ctx, role, done) {
  const title = document.getElementById('pbNewT').value.trim();
  if (!title) { toast('Judul wajib diisi', 'warn'); return; }
  const u = p => `/api/offices/${encodeURIComponent(ctx.office.id)}/${p}`;
  try {
    const page = await post(u('wiki'), { title, body: PB_TEMPLATE, msg: 'Playbook baru dari template' });
    await post(u('wiki-playbook'), { slug: page.slug, roles: [role.id], when: '', always: false, approval: false });
    closeModal(); toast('Playbook dibuat. Isi langkahnya.', 'ok');
    done?.(page);
    location.hash = `${base(ctx)}/wiki/${encodeURIComponent(page.slug)}`;
  } catch (e) { toast(e.message, 'bad'); }
}
