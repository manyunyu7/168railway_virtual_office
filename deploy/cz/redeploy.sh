#!/bin/sh
# Di Aishwarya, setelah rsync kode ke /srv/kantor-cz/app:
#   redeploy.sh           restart daemon saja (kode dibaca dari /srv/kantor-cz/app); sesi tmux tetap jalan
#   redeploy.sh --image   build ulang image + ganti container (perlu untuk Dockerfile/dependency baru);
#                         memutus semua sesi, jadi ditolak kalau masih ada sesi, kecuali ditambah --paksa
set -e
cd /srv/kantor-cz/app
# node_modules lives in the image; the bind-mounted code reaches it through this link
[ -L node_modules ] || ln -s /app/node_modules node_modules
if [ "$1" != "--image" ]; then
  docker exec kantor-cz pkill -f "node /app-src/server/index.js" && echo "daemon dimulai ulang (sesi tetap jalan)"
  exit 0
fi
ACTIVE=$(docker exec kantor-cz tmux ls -F '#{session_name}' 2>/dev/null || true)
if [ -n "$ACTIVE" ] && [ "$2" != "--paksa" ]; then
  echo "Masih ada sesi jalan di kantor-cz, redeploy --image dibatalkan supaya tidak memutus kerja orang:"; echo "$ACTIVE" | sed 's/^/  /'
  echo "Minta semua menutup sesinya, atau jalankan: $0 --image --paksa"; exit 3
fi
TAG=kantor-cz:$(date +%Y%m%d%H%M)
nice -n 10 docker build -q -t "$TAG" -t kantor-cz:latest -f deploy/cz/Dockerfile . >/dev/null
docker rm -f kantor-cz >/dev/null 2>&1 || true
docker run -d --name kantor-cz --hostname kantor-cz --network kantor-cz --restart unless-stopped \
  --memory 12g --memory-swap 12g --cpus 3 --pids-limit 4096 --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:4317:4317 -e KANTOR_APP=/app-src \
  -v /srv/kantor-cz/app:/app-src:ro -v /srv/kantor-cz/home:/home/kantor -v /srv/kantor-cz/work:/work kantor-cz:latest >/dev/null
echo "jalan: $TAG"
# keep the newest two dated images (current + one to roll back to)
docker images kantor-cz --format "{{.Tag}}" | grep -E "^[0-9]{12}$" | sort -r | tail -n +3 | sed "s/^/kantor-cz:/" | xargs -r docker rmi >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
