#!/usr/bin/env bash
# Installe Carchon OS sur un VPS Ubuntu/Debian neuf (OVH ou autre), avec HTTPS automatique.
# Usage (en root) :  bash install-vps.sh os.mondomaine.fr
# Sans nom de domaine :  bash install-vps.sh   (accès en http://ADRESSE-IP, sans cadenas)
set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/paulwoodworking1-maker/CARCHON-OS.git"
APP_DIR=/opt/carchon-os
DATA_DIR=/var/lib/carchon-os

if [ "$(id -u)" -ne 0 ]; then echo "Lance ce script en root : sudo bash $0 $DOMAIN"; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

echo "==> Mise à jour du système"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https ufw

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Caddy (serveur web + certificat HTTPS automatique)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> Utilisateur et dossiers"
id carchon >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin carchon
mkdir -p "$DATA_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$APP_DIR"; fi
cd "$APP_DIR" && npm ci --omit=dev
chown -R carchon:carchon "$APP_DIR" "$DATA_DIR"

echo "==> Réglages"
if [ ! -f /etc/carchon-os.env ]; then
  SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  {
    echo "PORT=3000"
    echo "DATA_DIR=$DATA_DIR"
    echo "SESSION_SECRET=$SECRET"
    if [ -n "$DOMAIN" ]; then echo "PUBLIC_URL=https://$DOMAIN"; echo "COOKIE_SECURE=1"; fi
    echo "# Envoi des codes e-mail aux clients (à remplir plus tard) :"
    echo "# SMTP_HOST=ssl0.ovh.net"
    echo "# SMTP_PORT=465"
    echo "# SMTP_SECURE=1"
    echo "# SMTP_USER=atelier@mondomaine.fr"
    echo "# SMTP_PASS="
    echo "# MAIL_FROM=Carchon Les Ateliers <atelier@mondomaine.fr>"
  } > /etc/carchon-os.env
  chmod 600 /etc/carchon-os.env
fi

echo "==> Service (démarre tout seul, redémarre en cas de souci)"
cat > /etc/systemd/system/carchon-os.service <<UNIT
[Unit]
Description=Carchon OS
After=network.target

[Service]
User=carchon
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/carchon-os.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now carchon-os
systemctl restart carchon-os

echo "==> Adresse web"
if [ -n "$DOMAIN" ]; then
  printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
else
  printf ':80 {\n\tencode gzip\n\treverse_proxy 127.0.0.1:3000\n}\n' > /etc/caddy/Caddyfile
fi
systemctl reload caddy || systemctl restart caddy

echo "==> Pare-feu"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

echo "==> Sauvegarde chaque nuit (garde 14 jours, dans /var/backups/carchon-os)"
cat > /etc/cron.daily/carchon-os-backup <<'CRON'
#!/bin/sh
mkdir -p /var/backups/carchon-os
tar czf /var/backups/carchon-os/carchon-$(date +%F).tgz -C /var/lib carchon-os
find /var/backups/carchon-os -name '*.tgz' -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/carchon-os-backup

sleep 2
if curl -fsS http://127.0.0.1:3000/sante >/dev/null; then
  IP=$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  echo
  echo "C'est en ligne. Ouvre : ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$IP}"
  echo "Mise à jour plus tard :  sudo bash $APP_DIR/deploy/update-vps.sh"
else
  echo "Le logiciel ne répond pas. Regarde :  journalctl -u carchon-os -n 50"; exit 1
fi
