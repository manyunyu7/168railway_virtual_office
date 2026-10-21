// Control Claude sessions that run in a plain Terminal.app or iTerm2 tab (not tmux),
// by finding the tab whose tty matches the session and typing into it with AppleScript.
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';

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

/** Type a line into the terminal tab that owns this tty (Enter is pressed after it). */
export async function typeInto(tty, text) {
  if (!tty || !fs.existsSync(tty)) throw new Error('Terminal sesi ini tidak ditemukan. Mungkin tab-nya sudah ditutup.');
  const line = String(text).replace(/\s*\n\s*/g, ' ').trim();
  if (!line) throw new Error('Teks kosong');
  if ((await osa(TERMINAL, [tty, line])) === 'ok') return 'Terminal';
  if ((await osa(ITERM, [tty, line])) === 'ok') return 'iTerm2';
  throw new Error('Tab untuk sesi ini tidak ditemukan di Terminal maupun iTerm2.');
}

/** The claude process attached to a tty (for force-quit). */
export function claudePid(tty) {
  try {
    const rows = execFileSync('/bin/ps', ['-t', tty.replace('/dev/', ''), '-o', 'pid=,comm='], { encoding: 'utf8' }).trim().split('\n');
    const row = rows.map(r => r.trim().split(/\s+/)).find(([, comm]) => /(^|\/)claude$/.test(comm || ''));
    return row ? Number(row[0]) : null;
  } catch { return null; }
}
