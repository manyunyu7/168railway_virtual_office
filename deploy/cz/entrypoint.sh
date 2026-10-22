#!/bin/sh
# First start writes the config (akun mode); every start re-installs hooks and the kantor MCP for this user.
# The daemon runs in a loop: an update only restarts node (pkill), so tmux sessions (shifts, terminals) survive.
# KANTOR_APP = where the code is: /app (baked into the image) or /app-src (bind mount from the host, see redeploy.sh).
set -e
APP="${KANTOR_APP:-/app}"
K="$HOME/.kantor-claude"
mkdir -p "$K" "$HOME/.claude" && chmod 700 "$K"
if [ ! -f "$K/config.json" ]; then
  cat > "$K/config.json" <<JSON
{
  "host": "0.0.0.0",
  "port": 4317,
  "roots": ["/work"],
  "defaultPermissionMode": "default",
  "musicDir": "/work/.musik",
  "sysmon": { "enabled": false },
  "akun": { "enabled": true, "names": ["${KANTOR_NAME:-cz.tentrem.space}"], "trustProxy": true, "sessionDays": 14 }
}
JSON
  chmod 600 "$K/config.json"
fi
[ -f "$HOME/.zshrc" ] || printf '# Kantor CZ\nexport PATH=$HOME/.local/bin:$PATH\nPROMPT="%%n@cz %%~ %%# "\n' > "$HOME/.zshrc"
git config --global user.name >/dev/null 2>&1 || git config --global user.name "Kantor CZ"
git config --global user.email >/dev/null 2>&1 || git config --global user.email "kantor-cz@tentrem.space"
(
  for i in $(seq 1 60); do [ -f "$K/server.json" ] && break; sleep 1; done
  # reinstall so the hook path follows $APP (image or bind mount)
  node "$APP/bin/kantor.js" hooks uninstall >/dev/null 2>&1 || true
  node "$APP/bin/kantor.js" hooks install >/dev/null 2>&1 || echo "hooks belum terpasang"
  claude mcp remove -s user kantor >/dev/null 2>&1 || true
  claude mcp add -s user kantor -- /usr/local/bin/node "$APP/server/mcp-stdio.js" >/dev/null 2>&1 || echo "mcp belum terpasang"
) &
child=
trap 'stop=1; [ -n "$child" ] && kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
stop=
while [ -z "$stop" ]; do
  node "$APP/server/index.js" & child=$!
  wait "$child" || true
  [ -n "$stop" ] && break
  echo "daemon berhenti, mulai lagi dalam 1 detik"; sleep 1
done
