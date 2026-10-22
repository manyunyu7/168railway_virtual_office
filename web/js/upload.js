// Unggah lampiran bertahap ke sesi: POST buka -> PUT potongan (bisa dilanjut lewat GET offset) -> selesai.
import { api, post } from './util.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_TRY = 8;

export const fmtSize = n => { n = Number(n) || 0; return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'; };

function putChunk(id, offset, blob, onBytes, signal) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/api/uploads/${encodeURIComponent(id)}`);
    x.withCredentials = true;
    x.setRequestHeader('Upload-Offset', String(offset));
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = e => onBytes(e.loaded);
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) return resolve(d || {});
      const er = new Error(d?.error || `Gagal (${x.status})`);
      er.status = x.status; er.data = d; reject(er);
    };
    x.onerror = () => reject(Object.assign(new Error('Koneksi terputus'), { net: true }));
    x.ontimeout = x.onerror;
    x.onabort = () => reject(Object.assign(new Error('Dibatalkan'), { aborted: true }));
    signal?.addEventListener('abort', () => x.abort(), { once: true });
    x.send(blob);
  });
}

/**
 * Unggah satu file. Mengembalikan promise; onProgress(bytesTerkirim, total).
 * Putus koneksi: ulang dengan jeda yang membesar, mulai dari offset yang diakui server.
 */
export async function uploadFile(sid, file, { caption, onProgress, signal } = {}) {
  const total = file.size;
  const name = file.name || `tempel-${Date.now()}.${(file.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`;
  const open = await post(`/api/sessions/${encodeURIComponent(sid)}/uploads`, { name, size: total, mime: file.type || 'application/octet-stream', ...(caption ? { caption } : {}) });
  const id = open.id; let offset = open.offset || 0, chunk = open.chunk || 1048576, tries = 0;
  onProgress?.(offset, total);
  while (offset < total || total === 0) {
    if (signal?.aborted) throw Object.assign(new Error('Dibatalkan'), { aborted: true });
    const end = Math.min(total, offset + chunk), base = offset;
    try {
      const r = await putChunk(id, offset, file.slice(offset, end), l => onProgress?.(base + l, total), signal);
      offset = typeof r.offset === 'number' ? r.offset : end;
      tries = 0; onProgress?.(offset, total);
      if (r.done || total === 0) break;
    } catch (e) {
      if (e.aborted || (e.status && e.status < 500 && e.status !== 409)) throw e;
      if (++tries > MAX_TRY) throw e;
      await sleep(Math.min(8000, 400 * 2 ** tries));
      try { const st = await api(`/api/uploads/${encodeURIComponent(id)}`); offset = st.offset || 0; if (st.done) break; } catch {}
    }
  }
  return { id, name };
}
