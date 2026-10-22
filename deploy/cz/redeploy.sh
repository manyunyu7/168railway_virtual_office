#!/bin/sh
# Di Aishwarya: build ulang image dari /srv/kantor-cz/app dan ganti container kantor-cz. Data di /srv/kantor-cz/{home,work} tetap.
set -e
cd /srv/kantor-cz/app
# replacing the container kills every tmux session in it (shifts, terminals): refuse while any is running
ACTIVE=$(docker exec kantor-cz tmux ls -F '#{session_name}' 2>/dev/null || true)
if [ -n "$ACTIVE" ] && [ "$1" != "--paksa" ]; then
  echo "Masih ada sesi jalan di kantor-cz, redeploy dibatalkan supaya tidak memutus kerja orang:"; echo "$ACTIVE" | sed 's/^/  /'
  echo "Minta semua menyelesaikan/menutup sesinya, atau jalankan: $0 --paksa"; exit 3
fi
TAG=kantor-cz:$(date +%Y%m%d%H%M)
nice -n 10 docker build -q -t "$TAG" -t kantor-cz:latest -f deploy/cz/Dockerfile . >/dev/null
docker rm -f kantor-cz >/dev/null 2>&1 || true
docker run -d --name kantor-cz --hostname kantor-cz --network kantor-cz --restart unless-stopped \
  --memory 6g --memory-swap 6g --cpus 3 --pids-limit 4096 --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:4317:4317 -v /srv/kantor-cz/home:/home/kantor -v /srv/kantor-cz/work:/work kantor-cz:latest >/dev/null
echo "jalan: $TAG"
