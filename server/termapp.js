// Control Claude sessions that run in a plain Terminal.app or iTerm2 tab (not tmux),
// by finding the tab whose tty matches the session and typing into it with AppleScript.
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { isRemote, isOffline, getMachine, tmuxMachineOf, ensureProbed, spawnArgs } from './machines.js';

// tty sesi di Mac lain (docs/MULTI-PC.md) bernama sama dengan tty di Mac ini (/dev/ttys003 ada di keduanya):
// mengetik atau mengirim sinyal ke sana akan mengenai tab atau proses yang salah. Sesi remote hanya lewat tmux.
export const REMOTE_TTY_MSG = 'Sesi ini jalan di mesin lain dan hanya bisa dikendalikan lewat tmux kantor. Mesinnya mungkin sedang offline.';

const TERMINAL = `on run argv
  set theTty to item 1 of argv
  set theText to item 2 of argv
  if application "Terminal" is not running then return "notfound"
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is theTty then
          do script theText in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const ITERM = `on run argv
  set theTty to item 1 of argv
  set theText to item 2 of argv
  if application "iTerm2" is not running then return "notfound"
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is theTty then
            tell s to write text theText
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const osa = (script, args) => new Promise((resolve, reject) => {
  execFile('osascript', ['-e', script, ...args], { timeout: 15000 }, (err, out, errOut) => {
    if (err) {
      const msg = String(errOut || err.message);
      if (/-1743|not authori[sz]ed|Not authorised/i.test(msg)) return reject(new Error('macOS belum mengizinkan Kantor Claude mengendalikan Terminal. Buka System Settings → Privacy & Security → Automation, lalu centang Terminal untuk node.'));
      return reject(new Error(msg.trim().split('\n').pop()));
    }
    resolve(out.trim());
  });
});

/** Type a line into the terminal tab that owns this tty (Enter is pressed after it). `machine`: mesin sesi itu (remote → ditolak). */
export async function typeInto(tty, text, { machine = null } = {}) {
  if (isRemote(machine)) throw new Error(REMOTE_TTY_MSG);
  if (!tty || !fs.existsSync(tty)) throw new Error('Terminal sesi ini tidak ditemukan. Mungkin tab-nya sudah ditutup.');
  const line = String(text).replace(/\s*\n\s*/g, ' ').trim();
  if (!line) throw new Error('Teks kosong');
  if ((await osa(TERMINAL, [tty, line])) === 'ok') return 'Terminal';
  if ((await osa(ITERM, [tty, line])) === 'ok') return 'iTerm2';
  throw new Error('Tab untuk sesi ini tidak ditemukan di Terminal maupun iTerm2.');
}

/** The claude process attached to a tty (for force-quit). Mesin remote → null (pid lokal bukan miliknya). */
export function claudePid(tty, { machine = null } = {}) {
  if (!tty || isRemote(machine)) return null;
  try {
    const rows = execFileSync('/bin/ps', ['-t', tty.replace('/dev/', ''), '-o', 'pid=,comm='], { encoding: 'utf8' }).trim().split('\n');
    const row = rows.map(r => r.trim().split(/\s+/)).find(([, comm]) => /(^|\/)claude$/.test(comm || ''));
    return row ? Number(row[0]) : null;
  } catch { return null; }
}

/**
 * { file, args, machine } untuk pty.spawn yang menempel ke sesi tmux kantor `name` (terminal web), di Mac ini atau di
 * mesin tempat sesi itu jalan (ssh -t). Lokal: `localTmux attach-session -t name` seperti semula, machine null.
 * Mesin offline → Error dengan pesan yang bisa ditampilkan; dicek sebelum ssh supaya tidak menunggu timeout.
 */
export function attachArgs(name, localTmux) {
  const machine = tmuxMachineOf(name);
  if (!isRemote(machine)) return { file: localTmux, args: ['attach-session', '-t', name], machine: null };
  const offline = () => new Error(`Mesin ${getMachine(machine)?.name || machine} sedang offline. Terminal ini bisa dibuka lagi setelah mesinnya tersambung.`);
  if (isOffline(machine)) throw offline();
  ensureProbed(machine);
  if (isOffline(machine)) throw offline();
  // -u: locale lewat ssh belum tentu UTF-8, padahal TUI Claude penuh karakter garis dan simbol
  return { ...spawnArgs(machine, 'tmux', ['-u', 'attach-session', '-t', name]), machine };
}
