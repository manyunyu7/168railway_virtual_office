// Mesin kedua: OpenAI Codex. Pembantu bersama untuk badge, pemilih model/effort, dan mode izin Codex.
import { $, esc, api, post, toast, modal, closeModal } from './util.js';

export const CODEX_MODES = [['default', 'Tanya dulu'], ['auto', 'Auto (Approve for me)'], ['readOnly', 'Hanya baca'], ['bypassPermissions', 'Akses penuh (tanpa sandbox)']];
export const CODEX_MODE_LABEL = Object.fromEntries(CODEX_MODES);
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const isCodex = x => x?.engine === 'codex';
export const codexBadge = x => isCodex(x) ? '<span class="st cx-badge" title="Mesin: OpenAI Codex">Codex</span>' : '';

let cache = null;
export function codexModels(force) {
  if (!cache || force) cache = api('/api/codex/models').catch(() => ({ models: [], default: {} }));
  return cache;
}
const effortsOf = (d, slug) => {
  const m = (d.models || []).find(x => x.slug === (slug || d.default?.model));
  const list = (m?.efforts || []).map(e => e.effort);
  return list.length ? list : EFFORTS;
};
const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
const effortOpts = (d, slug, cur) => opt('', `Bawaan${d.default?.effort ? ' (' + d.default.effort + ')' : ''}`, cur || '') + effortsOf(d, slug).map(e => opt(e, e, cur)).join('');

/** Isian model + effort Codex dengan id awalan `p`: `${p}-model` dan `${p}-effort`. */
export function codexFieldsHTML(d, p, cur = {}) {
  const list = d.models || [];
  const model = list.length
    ? `<select id="${p}-model" data-cx-model="${p}">${opt('', `Bawaan Codex${d.default?.model ? ' (' + d.default.model + ')' : ''}`, cur.model || '')}${list.map(m => opt(m.slug, m.name || m.slug, cur.model)).join('')}${cur.model && !list.some(m => m.slug === cur.model) ? opt(cur.model, cur.model, cur.model) : ''}</select>`
    : `<input id="${p}-model" data-cx-model="${p}" value="${esc(cur.model || '')}" placeholder="${esc(d.default?.model || 'bawaan Codex')}" autocomplete="off">`;
  const desc = list.find(m => m.slug === cur.model)?.desc;
  return `<div class="grid2"><div class="field"><label for="${p}-model">Model Codex</label>${model}${desc ? `<p class="hint" id="${p}-desc">${esc(desc)}</p>` : `<p class="hint" id="${p}-desc" hidden></p>`}</div>
    <div class="field"><label for="${p}-effort">Effort</label><select id="${p}-effort">${effortOpts(d, cur.model, cur.effort)}</select></div></div>`;
}
export const codexValues = p => ({ model: ($(`#${p}-model`)?.value || '').trim(), effort: $(`#${p}-effort`)?.value || '' });

/** Isi `box` dengan isian Codex setelah daftar model terbaca. */
export async function mountCodexFields(box, p, cur) {
  const d = await codexModels();
  if (box.isConnected) box.innerHTML = codexFieldsHTML(d, p, cur);
}

// Ganti model: sesuaikan daftar effort dan deskripsi.
document.addEventListener('change', async e => {
  const p = e.target.dataset?.cxModel; if (!p) return;
  const d = await codexModels(), eff = $(`#${p}-effort`); if (!eff) return;
  const keep = eff.value;
  eff.innerHTML = effortOpts(d, e.target.value.trim(), effortsOf(d, e.target.value.trim()).includes(keep) ? keep : '');
  const ds = $(`#${p}-desc`), m = (d.models || []).find(x => x.slug === e.target.value);
  if (ds) { ds.textContent = m?.desc || ''; ds.hidden = !m?.desc; }
});

export const modeOptions = cur => CODEX_MODES.map(([v, l]) => opt(v, 'Izin: ' + l, cur)).join('');
export const codexSessSub = s => [s.model || 'model bawaan', s.effort].filter(Boolean).join(' · ');

/** Pilihan model/effort/mode untuk sesi Codex yang sedang jalan (model/effort harus idle; mode boleh saat bekerja). */
export async function pickCodexSettings(s) {
  const d = await codexModels(), sid = s.sid;
  modal({ title: 'Model dan effort Codex', body: `Aktif sekarang: ${codexSessSub(s)}. Sesi harus sedang diam (tidak bekerja atau menunggu izin) saat diganti.`,
    html: `<div class="rf-fields">${codexFieldsHTML(d, 'cxs', { model: s.model, effort: s.effort })}</div>`,
    actions: [{ label: 'Terapkan', kind: 'primary', fn: () => { applyCodex(sid); return false; } }, { label: 'Batal' }] });
}
async function applyCodex(sid) {
  const v = codexValues('cxs'), body = {};
  if (v.model) body.model = v.model;
  if (v.effort) body.effort = v.effort;
  if (!Object.keys(body).length) { toast('Pilih model atau effort dulu', 'warn'); return; }
  try {
    await post(`/api/sessions/${encodeURIComponent(sid)}/codex/settings`, body);
    closeModal(); toast('Pengaturan Codex diganti', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}
