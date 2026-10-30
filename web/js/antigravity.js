import { $, esc, api } from './util.js';
export const isAntigravity = s => s?.engine === 'antigravity';
export const AGY_MODES = [['default', 'Tanya dulu'], ['acceptEdits', 'Edit file otomatis'], ['auto', 'Auto'], ['plan', 'Rencanakan (plan)'], ['bypassPermissions', 'Lewati semua izin']];
let cache;
export async function mountAgyFields(box, prefix, current = {}) {
  box.innerHTML = '<p class="hint">Memuat model Gemini…</p>';
  const data = await (cache ||= api('/api/antigravity/models').catch(() => ({ models: [], available: false })));
  if (!box.isConnected) return;
  const models = (data.models || []).filter(m => m.slug.startsWith('gemini-'));
  const option = (id, name) => `<option value="${esc(id)}"${id === current.model ? ' selected' : ''}>${esc(name)}</option>`;
  box.innerHTML = `<div class="field"><label for="${prefix}-model">Model Gemini</label>${models.length
    ? `<select id="${prefix}-model">${option('', 'Bawaan Antigravity')}${models.map(m => option(m.slug, m.name)).join('')}${current.model && !models.some(m => m.slug === current.model) ? option(current.model, current.model) : ''}</select>`
    : `<input id="${prefix}-model" value="${esc(current.model || '')}" placeholder="Bawaan Antigravity">`}</div>
    <p class="hint">${data.available ? 'Memakai akun Google yang login di PC ini. Kuota bisa dicek lewat /usage di terminal.' : 'Antigravity belum tersedia di PC ini. Pasang dan login Google terlebih dahulu.'}</p>`;
}
export const agyValues = prefix => ({ engine: 'antigravity', model: $(`#${prefix}-model`)?.value?.trim() || '', effort: '' });
