// Gallery of office templates ("suasana kantor"), shared by the layout editor and the new-office wizard.
// GET /api/templates gives each template with a small SVG thumbnail of a sample office.
import { esc, api } from './util.js';

let cache = null;
export async function loadTemplates() {
  if (!cache) cache = api('/api/templates').then(r => r.templates || []).catch(e => { cache = null; throw e; });
  return cache;
}
const thumb = t => t.thumb ? `<img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(t.thumb)}" alt="" loading="lazy">` : '';
/** Cards for every template; `sel` = selected id; `attr` = the data attribute the caller listens to. `none` adds a "keep the default plan" card. */
export function galleryHTML(list, sel, { attr = 'data-tpl', none = '' } = {}) {
  return `<div class="tpl-gal" role="listbox" aria-label="Suasana kantor">${list.map(t => `
    <button type="button" class="tpl-card${t.id === sel ? ' on' : ''}" ${attr}="${esc(t.id)}" role="option" aria-selected="${t.id === sel}" style="--tpl:${esc(t.accent || '#7FA88A')}">
      <span class="tpl-th">${thumb(t)}</span>
      <span class="tpl-tx"><b>${esc(t.name)}</b><i>${esc(t.mood || '')}</i><span>${esc(t.desc)}</span></span></button>`).join('')}
    ${none ? `<button type="button" class="tpl-card tpl-none${!sel ? ' on' : ''}" ${attr}="" role="option" aria-selected="${!sel}"><span class="tpl-tx"><b>${esc(none)}</b><span>Denah disusun otomatis dari isi folder, tanpa perabot tambahan.</span></span></button>` : ''}
  </div>`;
}
