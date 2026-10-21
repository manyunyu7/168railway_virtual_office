// The shared right-side drawer. Views put their own content in it.
import { $ } from './util.js';

const drawer = () => $('#drawer');
const scrim = () => $('#scrim');
let onClose = null;
const st = { open: false, key: null };

/** Show html in the drawer. key identifies what is open (e.g. "card:k123"). */
export function showDrawer(html, { wide = false, key = null, close = null } = {}) {
  const d = drawer();
  if (st.open && onClose && st.key !== key) { const f = onClose; onClose = null; f(); }
  d.classList.toggle('wide', wide);
  d.innerHTML = html;
  d.hidden = false; scrim().hidden = false;
  st.open = true; st.key = key; onClose = close;
  return d;
}
export function closeDrawer() {
  if (!st.open) return;
  const f = onClose; onClose = null;
  drawer().hidden = true; scrim().hidden = true; drawer().innerHTML = '';
  st.open = false; st.key = null;
  f?.();
}
export const drawerState = () => st;
export const drawerEl = drawer;
