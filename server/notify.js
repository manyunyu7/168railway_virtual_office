import { config } from './config.js';
import { officeDb, one } from './db.js';
import { bus } from './live.js';

/** Push to Ghina (killa-engine style POST /v1/notify) when something needs the owner. Never throws, never blocks the daemon. */
const last = new Map();
const warned = new Set();

export function notifyConf() {
  const c = config().ghinaNotify || {};
  return c.enabled !== false && c.url && c.token ? c : null;
}

/** What the Ghina app opens: /kantor/o/<office>/s/<sid> (office and sid are separate fields; path is the web-UI hash). */
export function linkFor({ kind, office, sid }) {
  return { kind: 'kantor', office: office || null, sid: sid || null, path: office ? `#/o/${office}/kantor` : '#/', event: kind };
}

const clip = (t, n) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const TITLES = { permission: w => `${w} minta izin`, question: w => `${w} bertanya`, meeting: w => w, file: w => `${w} mengirim file`, budget: w => `${w}: anggaran habis`, sysmon: w => w, pratinjau: w => `${w} mengirim pratinjau` };
// Kantor kind -> event name of Ghina's POST /api/kantor/notify
// budget has no event of its own in Ghina; it travels as 'question' (an agent needs the owner to look)
const EVENTS = { permission: 'permission', question: 'question', meeting: 'meeting_done', file: 'file', budget: 'question', sysmon: 'question', pratinjau: 'pratinjau' };

export async function pushGhina(ev) {
  const c = notifyConf();
  if (!c || !EVENTS[ev.kind]) return false;
  if (ev.kind === 'file' || ev.kind === 'budget' || ev.kind === 'sysmon' || ev.kind === 'pratinjau' ? c[ev.kind] === false : !(c.events || []).includes(ev.kind)) return false;
  const key = `${ev.kind}:${ev.sid || ev.office || ''}:${ev.dedupe || ''}`;
  const now = Date.now();
  if (now - (last.get(key) || 0) < (Number(c.debounceSec) || 30) * 1000) return false;
  last.set(key, now);
  if (last.size > 500) for (const [k, t] of last) if (now - t > 3600e3) last.delete(k);
  const body = { event: EVENTS[ev.kind], title: clip(TITLES[ev.kind](ev.who || 'Sesi'), 120), body: clip(ev.text, 500),
    ...(ev.office ? { office: ev.office, path: ev.kind === 'pratinjau' && ev.id ? `#/o/${ev.office}/pratinjau/${ev.id}` : `#/o/${ev.office}/kantor` } : {}), ...(ev.sid ? { sid: ev.sid } : {}), ...(ev.id ? { id: ev.id } : {}) };
  try {
    const r = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return true;
  } catch (e) {
    const m = String(e.message);
    if (!warned.has(m)) { warned.add(m); console.error(`notifikasi Ghina gagal: ${m}`); }
    return false;
  }
}

export function startNotify() {
  bus.on('notify', ev => { pushGhina(ev).catch(() => {}); });
  bus.on('msg', m => {
    try {
      if (m.t === 'inbox') pushGhina({ kind: 'permission', sid: m.item.sid, office: m.item.office, who: m.item.who || 'Sesi', text: `${m.item.tool} ${String(m.item.summary || '').replace(/\s+/g, ' ').slice(0, 200)}`.trim() }).catch(() => {});
      else if (m.t === 'changed' && m.what === 'meetings' && m.meeting && m.office && m.office !== '*') {
        const mt = one(officeDb(m.office), 'SELECT id, topic, status FROM meetings WHERE id = ?', m.meeting);
        if (mt && (mt.status === 'selesai' || mt.status === 'gagal')) pushGhina({ kind: 'meeting', office: m.office, dedupe: `${mt.id}:${mt.status}`, who: mt.status === 'selesai' ? 'Rapat selesai' : 'Rapat gagal', text: mt.topic }).catch(() => {});
      }
    } catch {}
  });
}
