// Claude Code kadang menyusun draf laporan masalah ke Anthropic (tool SendFeedback) dan menampilkannya di atas kotak input,
// dengan tombol 1 lihat, 2 kirim, 0 abaikan. Modul ini hanya membaca layarnya; tidak ada yang terkirim tanpa klik pemilik.
const KEYS = /1 to review\s*·\s*2 to send\s*·\s*0 to dismiss/;

/** Judul draf dari isi layar, atau null bila prompt tidak tampil. */
export function draftOnScreen(screen) {
  const t = String(screen || '');
  if (!KEYS.test(t)) return null;
  const m = /([A-Za-z][A-Za-z ]*?) drafted:\s*(.+?)\s*│?\s*$/m.exec(t);
  return m ? m[2].trim() : 'Draf laporan';
}
/** Draf yang masih tersimpan: `1 feedback draft` di baris bawah, walau kotak dan tombolnya sedang tidak tampil. */
export const draftsWaiting = screen => /\b\d+ feedback drafts?\b/.test(String(screen || ''));
/** Kotak input kosong: tombol angka aman ditekan tanpa mengganggu ketikan. */
export const inputEmpty = screen => /^\s*│?\s*❯\s*│?\s*$/m.test(String(screen || ''));
