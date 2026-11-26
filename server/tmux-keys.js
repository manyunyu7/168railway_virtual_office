// Mengetik ke pane yang sedang di copy-mode (mis. habis di-scroll dengan mouse: WheelUpPane → copy-mode -e).
// Di mode itu send-keys dibaca sebagai tombol copy-mode, bukan teks untuk agen. Sebagian tombol (t, g, f, F, T,
// angka, ?, /, :) membuka command-prompt yang tanpa -b menahan klien tmux pemanggilnya sampai prompt dijawab
// di terminal yang ter-attach. Dengan execFileSync itu membekukan seluruh daemon (26 Nov 2026: "google coba…"
// ke kc-buddget-chief; 25 Nov: "tinggal nunggu…" ke kc-my-pc-cyrus).
// Obatnya: keluar dulu dari mode dalam panggilan tmux yang sama: `copy-mode -q -t X ; send-keys …`.
// copy-mode -q tidak berbuat apa-apa pada pane yang tidak sedang di mode.

/** Opsi send-keys sebelum argumen tombol/teks; `-t`, `-N`, `-c`, `-T` membawa nilai. */
function sendKeysFlags(args) {
  const flags = [];
  for (let i = 1; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--' || !a.startsWith('-') || a === '-') break;
    flags.push(a);
    if (['-t', '-N', '-c', '-T'].includes(a)) i++;
  }
  return flags;
}

/**
 * Argumen tmux dengan `copy-mode -q -t <target> ;` di depan bila perintahnya mengetik ke pane (send-keys tanpa -X/-M,
 * paste-buffer). Perintah lain dikembalikan apa adanya.
 */
export function leaveModeFirst(args) {
  const verb = args[0];
  if (verb !== 'send-keys' && verb !== 'paste-buffer') return args;
  const i = args.indexOf('-t');
  const target = i >= 0 ? args[i + 1] : null;
  if (!target) return args;
  // -X: perintah untuk copy-mode itu sendiri; -M: event mouse yang memang ditujukan ke mode
  if (verb === 'send-keys' && sendKeysFlags(args).some(f => f === '-X' || f === '-M')) return args;
  return ['copy-mode', '-q', '-t', target, ';', ...args];
}
