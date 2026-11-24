// Mesin keempat: OpenCode. Isian model untuk editor role / mulai shift, dan pengaturan sesi yang sedang jalan.
import { $, esc, api, post, toast, modal, closeModal } from './util.js';

export const isOpenCode = s => s?.engine === 'opencode';
export const OC_MODES = [['default', 'Tanya dulu'], ['acceptEdits', 'Edit file otomatis'], ['plan', 'Rencanakan (tanpa edit)'], ['bypassPermissions', 'Lewati semua izin']];
export const OC_MODE_LABEL = Object.fromEntries(OC_MODES);
let cache;
const ocModels = force => (!cache || force ? (cache = api('/api/opencode/models').catch(() => ({ models: [], available: false }))) : cache);
const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;

function fieldsHTML(data, prefix, current = {}) {
  const models = data.models || [], cur = current.model || '';
  const groups = [...new Set(models.map(m => m.provider))];
  const select = `<select id="${prefix}-model">${opt('', 'Bawaan OpenCode', cur)}${groups.map(g => `<optgroup label="${esc(g)}">${models.filter(m => m.provider === g).map(m => opt(m.slug, m.name, cur)).join('')}</optgroup>`).join('')}${cur && !models.some(m => m.slug === cur) ? opt(cur, cur, cur) : ''}</select>`;
  return `<div class="field"><label for="${prefix}-model">Model OpenCode</label>${models.length ? select
    : `<input id="${prefix}-model" value="${esc(cur)}" placeholder="provider/model, kosong = bawaan" autocomplete="off">`}</div>
    <p class="hint">${data.available ? (data.error ? esc(data.error) : 'Memakai login OpenCode di PC ini. Kosong berarti model bawaan OpenCode.') : 'OpenCode belum terpasang di PC ini (brew install opencode, lalu login sekali).'}</p>`;
}
export async function mountOcFields(box, prefix, current = {}) {
  box.innerHTML = '<p class="hint">Memuat model OpenCode…</p>';
  const data = await ocModels();
  if (box.isConnected) box.innerHTML = fieldsHTML(data, prefix, current);
}
export const ocValues = prefix => ({ engine: 'opencode', model: $(`#${prefix}-model`)?.value?.trim() || '', effort: '' });
export const ocModeOptions = cur => OC_MODES.map(([v, l]) => opt(v, 'Izin: ' + l, cur)).join('');
export const ocSessSub = s => s.model || 'model bawaan';

/** Ganti model sesi OpenCode yang sedang jalan (lewat server OpenCode milik shift itu, bukan tombol keyboard). */
export async function pickOcSettings(s) {
  const data = await ocModels(), sid = s.sid;
  modal({ title: 'Model OpenCode', body: `Aktif sekarang: ${ocSessSub(s)}. Berlaku mulai giliran berikutnya.`,
    html: `<div class="rf-fields">${fieldsHTML(data, 'ocs', { model: s.model })}</div>`,
    actions: [{ label: 'Terapkan', kind: 'primary', fn: () => { applyOc(sid); return false; } }, { label: 'Batal' }] });
}
async function applyOc(sid) {
  const model = $('#ocs-model')?.value?.trim();
  if (!model) { toast('Pilih model dulu', 'warn'); return; }
  try { await post(`/api/sessions/${encodeURIComponent(sid)}/opencode/settings`, { model }); closeModal(); toast('Model OpenCode diganti', 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
}
