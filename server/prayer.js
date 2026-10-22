// Prayer times, Kemenag method (Fajr 20°, Isha 18°, Asr Shafi'i, +2 min ihtiyath), computed locally.
// Solar position follows the same low-precision formulas PrayTimes.org uses (good to about a minute).
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const fix = (a, m) => { a -= m * Math.floor(a / m); return a; };
const sin = d => Math.sin(rad(d)), cos = d => Math.cos(rad(d)), tan = d => Math.tan(rad(d));

export const METHOD = { fajr: 20, isha: 18, sunset: 0.833, asrFactor: 1, ihtiyat: 2 };

function julian(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}
function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fix(357.529 + 0.98560028 * D, 360), q = fix(280.459 + 0.98564736 * D, 360);
  const L = fix(q + 1.915 * sin(g) + 0.020 * sin(2 * g), 360);
  const e = 23.439 - 0.00000036 * D;
  const RA = deg(Math.atan2(cos(e) * sin(L), cos(L))) / 15;
  return { decl: deg(Math.asin(sin(e) * sin(L))), eqt: q / 15 - fix(RA, 24) };
}
/** UTC offset (hours) of an IANA zone on a calendar date, at local noon. */
function tzOffset(tz, y, m, d) {
  const t = Date.UTC(y, m - 1, d, 12);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(t).map(p => [p.type, +p.value]));
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - t) / 3600000;
}
const hhmm = h => {
  if (!Number.isFinite(h)) return null;
  const m = Math.round(fix(h, 24) * 60);
  return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};

/** {subuh,dzuhur,ashar,maghrib,isya,terbit} as "HH:MM" local time for a YYYY-MM-DD date. */
export function prayerTimes(dateStr, loc = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) throw new Error('Tanggal harus YYYY-MM-DD');
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error('Tanggal tidak valid');
  const lat = Number.isFinite(+loc.lat) ? +loc.lat : -6.2, lng = Number.isFinite(+loc.lng) ? +loc.lng : 106.8, tz = loc.tz || 'Asia/Jakarta';
  const off = tzOffset(tz, y, mo, d);
  const { decl, eqt } = sunPosition(julian(y, mo, d) + 0.5 - lng / 360); // sun at local noon
  const noon = 12 + off - lng / 15 - eqt;
  const t = angle => deg(Math.acos((-sin(angle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat)))) / 15;
  const asrAngle = deg(Math.atan(1 / (METHOD.asrFactor + tan(Math.abs(lat - decl)))));
  const asr = deg(Math.acos((sin(asrAngle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat)))) / 15;
  const ih = METHOD.ihtiyat / 60;
  return {
    subuh: hhmm(noon - t(METHOD.fajr) + ih), terbit: hhmm(noon - t(METHOD.sunset)),
    dzuhur: hhmm(noon + ih), ashar: hhmm(noon + asr + ih),
    maghrib: hhmm(noon + t(METHOD.sunset) + ih), isya: hhmm(noon + t(METHOD.isha) + ih),
  };
}
