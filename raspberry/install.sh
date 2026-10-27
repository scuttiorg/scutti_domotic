#!/usr/bin/env bash
# Installation sur Raspberry Pi OS (Bookworm). À lancer en root depuis le dossier raspberry/.
set -euo pipefail

DEST=/opt/chauffage
HERE=$(cd "$(dirname "$0")" && pwd)

echo "→ Paquets"
apt-get update -q
apt-get install -y -q docker.io docker-compose-plugin nodejs npm ufw unattended-upgrades mosquitto-clients

echo "→ Mises à jour automatiques"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "→ Pare-feu : SSH uniquement"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

echo "→ SSH par clé uniquement"
if [ -s /root/.ssh/authorized_keys ] || ls /home/*/.ssh/authorized_keys >/dev/null 2>&1; then
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  systemctl reload ssh
else
  echo "   (aucune clé SSH trouvée : mot de passe conservé — ajoute une clé puis relance)"
fi

echo "→ Utilisateur de service"
id chauffage >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin chauffage

echo "→ Fichiers"
mkdir -p "$DEST"
cp -r "$HERE"/{docker-compose.yml,mosquitto,zigbee2mqtt,gateway} "$DEST"/
[ -f "$DEST/.env" ] || cp "$HERE/.env.example" "$DEST/.env"
[ -f "$DEST/gateway/.env" ] || cp "$HERE/gateway/.env.example" "$DEST/gateway/.env"
touch "$DEST/gateway/config.cache.json"
chown -R root:chauffage "$DEST"
chmod 750 "$DEST" "$DEST/gateway"
chmod 640 "$DEST/.env" "$DEST/gateway/.env"
chmod 660 "$DEST/gateway/config.cache.json"

echo "→ Dépendances Node"
(cd "$DEST/gateway" && npm ci --omit=dev 2>/dev/null || npm install --omit=dev)

echo "→ Mot de passe MQTT"
if [ ! -f "$DEST/mosquitto/passwd" ]; then
  # shellcheck disable=SC1091
  source "$DEST/.env"
  docker run --rm -v "$DEST/mosquitto:/m" eclipse-mosquitto:2 \
    mosquitto_passwd -c -b /m/passwd "$MQTT_USER" "$MQTT_PASSWORD"
  chmod 600 "$DEST/mosquitto/passwd"
fi

echo "→ Service"
cp "$DEST/gateway/chauffage-gateway.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable chauffage-gateway

cat <<EOF

Terminé. Reste à faire :
  1. Éditer $DEST/.env et $DEST/gateway/.env (mots de passe, jeton scutti).
  2. cd $DEST && docker compose up -d
  3. Appairer les appareils via un tunnel : ssh -L 8080:127.0.0.1:8080 pi@<ip>  puis http://localhost:8080
     (nommer capteur et prise comme dans scutti, puis remettre permit_join à false)
  4. systemctl start chauffage-gateway && journalctl -fu chauffage-gateway
EOF
