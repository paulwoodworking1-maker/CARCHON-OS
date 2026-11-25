#!/usr/bin/env bash
# Met Carchon OS à jour avec la dernière version de GitHub (les données ne bougent pas).
set -euo pipefail
cd /opt/carchon-os
sudo -u carchon git pull --ff-only
sudo -u carchon npm ci --omit=dev
systemctl restart carchon-os
sleep 2 && curl -fsS http://127.0.0.1:3000/sante >/dev/null && echo "À jour."
