#!/bin/sh
# First start writes the config (akun mode); every start re-installs hooks and the kantor MCP for this user.
set -e
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
git config --global user.name >/dev/null 2>&1 || git config --global user.name "Kantor CZ"
git config --global user.email >/dev/null 2>&1 || git config --global user.email "kantor-cz@tentrem.space"
(
  for i in $(seq 1 60); do [ -f "$K/server.json" ] && break; sleep 1; done
  node /app/bin/kantor.js hooks install >/dev/null 2>&1 || echo "hooks belum terpasang"
  claude mcp get kantor >/dev/null 2>&1 || claude mcp add -s user kantor -- /usr/local/bin/node /app/server/mcp-stdio.js >/dev/null 2>&1 || echo "mcp belum terpasang"
) &
exec node /app/server/index.js
