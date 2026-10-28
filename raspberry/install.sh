#!/usr/bin/env bash
# Installation sur Raspberry Pi OS (Bookworm). À lancer en root depuis le dossier raspberry/.
#
# Appelé par la ligne que Scutti fait coller, qui pose SCUTTI_URL et
# SCUTTI_CODE : le script échange alors le code contre le jeton, écrit les
# deux .env, démarre les conteneurs et le service, et il n'y a plus rien à
# faire à la main. Lancé sans ces variables, il s'arrête après l'installation
# et dit ce qui reste à renseigner.
set -euo pipefail

DEST=/opt/chauffage
HERE=$(cd "$(dirname "$0")" && pwd)
SCUTTI_URL="${SCUTTI_URL:-}"
SCUTTI_CODE="${SCUTTI_CODE:-}"

# Un secret lisible, tiré au sort : personne n'a plus à inventer un mot de
# passe MQTT, ni à le retaper deux fois dans deux fichiers.
tirer_secret() { head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24; }

echo "→ Paquets"
apt-get update -q
apt-get install -y -q curl ufw unattended-upgrades mosquitto-clients

echo "→ Docker (dépôt officiel : le paquet compose n'est pas dans Raspberry Pi OS)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || apt-get install -y -q docker-compose-plugin

echo "→ Node 22 (dépôt NodeSource : celui de Raspberry Pi OS est trop ancien)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

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

# Docker CRÉE UN DOSSIER quand un fichier monté en volume n'existe pas : un
# premier `up` lancé avant l'installation laisse donc `mosquitto/passwd` en
# dossier, et mosquitto refuse de démarrer avec une erreur qui ne dit pas
# pourquoi. On le voit ici plutôt que trois jours plus tard.
if [ -d "$DEST/mosquitto/passwd" ]; then
  echo "   $DEST/mosquitto/passwd est un dossier : Docker l'a créé à un \`up\` lancé trop tôt." >&2
  echo "   Supprimez-le (rmdir), puis relancez ce script." >&2
  exit 1
fi

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
# Tiré au sort et posé dans les deux .env : c'est un secret entre deux
# conteneurs de la même machine, personne n'a à le connaître.
# Une réinstallation ne le change pas : mosquitto/passwd porterait encore
# l'ancien, et le courtier refuserait la passerelle.
if grep -q '^MQTT_PASSWORD=changez-moi$' "$DEST/.env"; then
  MOT_DE_PASSE=$(tirer_secret)
  sed -i "s|^MQTT_PASSWORD=.*|MQTT_PASSWORD=$MOT_DE_PASSE|" "$DEST/.env"
  sed -i "s|^MQTT_PASSWORD=.*|MQTT_PASSWORD=$MOT_DE_PASSE|" "$DEST/gateway/.env"
fi

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

if [ -n "$SCUTTI_CODE" ] && [ -n "$SCUTTI_URL" ]; then
  echo "→ Liaison avec Scutti"
  # Le code s'échange UNE fois contre le jeton. Le jeton n'est jamais
  # affiché : il va directement dans gateway/.env, en 0640.
  REPONSE=$(curl -fsS -X POST "$SCUTTI_URL/api/public/domotique/installer" \
    -H 'Content-Type: application/json' \
    -d "{\"code\":\"$SCUTTI_CODE\"}")
  JETON=$(printf '%s' "$REPONSE" | sed -n 's/.*"jeton":"\([^"]*\)".*/\1/p')
  if [ -z "$JETON" ]; then
    echo "   Le code d'installation n'a pas été accepté : il a peut-être expiré." >&2
    echo "   Reprenez l'étape 1 dans Scutti pour en obtenir un neuf." >&2
    exit 1
  fi
  sed -i "s|^SCUTTI_URL=.*|SCUTTI_URL=$SCUTTI_URL|" "$DEST/gateway/.env"
  sed -i "s|^SCUTTI_TOKEN=.*|SCUTTI_TOKEN=$JETON|" "$DEST/gateway/.env"

  echo "→ Démarrage"
  (cd "$DEST" && docker compose up -d)
  systemctl restart chauffage-gateway

  cat <<EOF

Terminé. Le boîtier est relié à Scutti : la page d'installation continue
toute seule. L'appairage et le nommage des appareils se font là-bas.
EOF
else
  cat <<EOF

Terminé. Reste à faire :
  1. Renseigner SCUTTI_URL et SCUTTI_TOKEN dans $DEST/gateway/.env.
  2. cd $DEST && docker compose up -d
  3. systemctl start chauffage-gateway && journalctl -fu chauffage-gateway

Plus simple : lancez l'installation depuis Scutti, qui donne une ligne à
coller et relie le boîtier sans rien à éditer.
EOF
fi
