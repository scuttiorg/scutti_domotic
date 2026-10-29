#!/usr/bin/env bash
# Installation sur Raspberry Pi OS (Bookworm). À lancer en root depuis le dossier raspberry/.
#
# Appelé par la ligne que Scutti fait coller, qui pose SCUTTI_URL et
# SCUTTI_CODE : le script échange alors le code contre le jeton, écrit les
# deux .env, démarre les conteneurs et le service, et il n'y a plus rien à
# faire à la main. Lancé sans ces variables, il s'arrête après l'installation
# et dit ce qui reste à renseigner.
#
# Il se relance sans danger, et c'est aussi lui que la mise à jour
# automatique (systeme/maj.sh) rejoue à chaque version, avec MISE_A_JOUR=1 :
# rien de ce que le boîtier a écrit lui-même n'est écrasé (jeton, mot de
# passe MQTT, réseau Zigbee), et un boîtier déjà relié redémarre sur le
# nouveau code.
set -euo pipefail

DEST=/opt/chauffage
HERE=$(cd "$(dirname "$0")" && pwd)
SCUTTI_URL="${SCUTTI_URL:-}"
SCUTTI_CODE="${SCUTTI_CODE:-}"
MISE_A_JOUR="${MISE_A_JOUR:-}"

# Un secret lisible, tiré au sort : personne n'a plus à inventer un mot de
# passe MQTT, ni à le retaper deux fois dans deux fichiers.
tirer_secret() { head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24; }

# Écrit le fichier seulement s'il change, et le dit : recharger systemd ou
# NetworkManager à chaque mise à jour pour rien n'apporte que du risque.
ecrire_si_change() {
  if [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; then return 1; fi
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" > "$1"
}

# Les paquets ne se réinstallent pas à chaque version : les mises à jour
# système passent par unattended-upgrades, et une mise à jour du boîtier ne
# doit pas échouer parce qu'un miroir apt est en panne.
if [ -z "$MISE_A_JOUR" ]; then
  echo "→ Paquets"
  apt-get update -q
  apt-get install -y -q curl git openssl rsync ufw unattended-upgrades mosquitto-clients

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
fi

echo "→ Pare-feu : SSH, et l'interface locale sur le réseau du bâtiment"
LOCAL_PORT="${LOCAL_PORT:-8080}"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
# L'interface locale n'est ouverte QUE sur les réseaux privés : c'est elle qui
# permet de régler le chauffage quand Scutti est injoignable, et elle n'a
# aucune raison d'être joignable depuis l'extérieur.
if [ "$LOCAL_PORT" != "0" ]; then
  for reseau in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
    ufw allow from "$reseau" to any port "$LOCAL_PORT" proto tcp
  done
fi
ufw --force enable

echo "→ SSH par clé uniquement"
if [ -s /root/.ssh/authorized_keys ] || ls /home/*/.ssh/authorized_keys >/dev/null 2>&1; then
  # Dans sshd_config.d, et en tête : sshd garde la PREMIÈRE valeur lue, et
  # ce dossier est lu avant sshd_config. Un `PasswordAuthentication yes`
  # posé là par l'outil de préparation de la carte SD l'emportait sur la
  # ligne réglée dans sshd_config, et le mot de passe restait accepté.
  if ecrire_si_change /etc/ssh/sshd_config.d/00-chauffage.conf "PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password"; then
    sshd -t && systemctl reload ssh
  fi
else
  echo "   (aucune clé SSH trouvée : mot de passe conservé — ajoute une clé puis relance)"
fi

echo "→ Tenir debout tout seul"
# Un boîtier figé (noyau bloqué, carte SD qui ne répond plus) ne se relève
# pas seul : le chien de garde matériel du Raspberry le redémarre si systemd
# cesse de lui répondre pendant quinze secondes.
if [ -e /dev/watchdog ]; then
  if ecrire_si_change /etc/systemd/system.conf.d/chauffage-watchdog.conf "[Manager]
RuntimeWatchdogSec=15
RebootWatchdogSec=2min"; then
    systemctl daemon-reexec
  fi
fi
# Une panique du noyau redémarre au bout de dix secondes, au lieu de laisser
# le boîtier figé jusqu'à ce que quelqu'un débranche la prise.
if ecrire_si_change /etc/sysctl.d/90-chauffage.conf "kernel.panic = 10
kernel.panic_on_oops = 1"; then
  sysctl -q -p /etc/sysctl.d/90-chauffage.conf
fi
if command -v nmcli >/dev/null 2>&1; then
  # L'économie d'énergie du wifi du Raspberry coupe la liaison au repos :
  # c'est la cause la plus courante d'un boîtier allumé mais introuvable.
  if ecrire_si_change /etc/NetworkManager/conf.d/chauffage.conf "[connection]
wifi.powersave=2"; then
    systemctl reload NetworkManager || true
  fi
  # NetworkManager abandonne une connexion après quatre échecs, et ne la
  # retente plus : une box qui redémarre la nuit suffit. 0 = sans fin.
  nmcli -t -f NAME,TYPE connection show | while IFS=: read -r nom type; do
    if [ "$type" = 802-11-wireless ]; then
      nmcli connection modify "$nom" connection.autoconnect-retries 0 || true
    fi
  done
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
mkdir -p "$DEST"/{gateway,web,mosquitto,zigbee2mqtt}
cp "$HERE/docker-compose.yml" "$DEST/"
cp "$HERE/mosquitto/mosquitto.conf" "$DEST/mosquitto/"
# Le code est remplacé en entier : ce qui a disparu du dépôt disparaît d'ici.
# Ce que le boîtier a écrit lui-même (.env, cache, dépendances) reste.
rsync -a --delete --exclude .env --exclude config.cache.json --exclude node_modules \
  "$HERE/gateway/" "$DEST/gateway/"
rsync -a --delete "$HERE/web/" "$DEST/web/"
# La configuration de Zigbee2MQTT n'est posée qu'une fois : il y écrit la clé
# du réseau à son premier démarrage, puis les noms des appareils. La recopier
# effacerait le réseau, et tous les appareils seraient à ré-appairer.
[ -f "$DEST/zigbee2mqtt/configuration.yaml" ] || cp "$HERE/zigbee2mqtt/configuration.yaml" "$DEST/zigbee2mqtt/"
[ -f "$DEST/.env" ] || cp "$HERE/.env.example" "$DEST/.env"
[ -f "$DEST/gateway/.env" ] || cp "$HERE/gateway/.env.example" "$DEST/gateway/.env"
touch "$DEST/gateway/config.cache.json"
# La version posée, que la mise à jour compare à celle de GitHub. Hors dépôt
# git (une archive copiée à la main), elle est inconnue, et la prochaine
# mise à jour réinstalle main.
git -C "$HERE" rev-parse HEAD 2>/dev/null > "$DEST/VERSION" || echo inconnue > "$DEST/VERSION"

echo "→ Certificat de l'interface locale"
# L'interface ne parle qu'en HTTPS. Le certificat est engendré une fois, ici :
# la clé privée ne quitte jamais le boîtier, et le recréer changerait
# l'empreinte que les navigateurs ont acceptée et que Scutti affiche.
mkdir -p "$DEST/tls"
if [ ! -s "$DEST/tls/boitier.key" ] || [ ! -s "$DEST/tls/boitier.crt" ]; then
  NOM=$(hostname)
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=$NOM.local" -addext "subjectAltName=DNS:$NOM.local,DNS:$NOM" \
    -keyout "$DEST/tls/boitier.key" -out "$DEST/tls/boitier.crt" 2>/dev/null
fi

chown -R root:chauffage "$DEST"
chmod 750 "$DEST" "$DEST/gateway" "$DEST/web" "$DEST/tls"
chmod 640 "$DEST/tls/boitier.key"
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

echo "→ Services"
cp "$DEST/gateway/chauffage-gateway.service" "$HERE"/systeme/chauffage-{maj,reseau}.{service,timer} /etc/systemd/system/
install -m 755 "$HERE/systeme/maj.sh" /usr/local/sbin/chauffage-maj
install -m 755 "$HERE/systeme/reseau.sh" /usr/local/sbin/chauffage-reseau
systemctl daemon-reload
systemctl enable chauffage-gateway
systemctl enable --now chauffage-maj.timer chauffage-reseau.timer

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
fi

if grep -q '^SCUTTI_TOKEN=jeton-de-la-passerelle$' "$DEST/gateway/.env"; then
  cat <<EOF

Terminé. Reste à faire :
  1. Renseigner SCUTTI_URL et SCUTTI_TOKEN dans $DEST/gateway/.env.
  2. cd $DEST && docker compose up -d
  3. systemctl start chauffage-gateway && journalctl -fu chauffage-gateway

Plus simple : lancez l'installation depuis Scutti, qui donne une ligne à
coller et relie le boîtier sans rien à éditer.
EOF
  exit 0
fi

echo "→ Démarrage"
# `up -d` recrée les conteneurs dont la définition a changé, et eux seuls :
# sans lui, un conteneur d'une version précédente garde ses anciens ports.
(cd "$DEST" && docker compose up -d)
systemctl restart chauffage-gateway

if [ -n "$SCUTTI_CODE" ]; then
  cat <<EOF

Terminé. Le boîtier est relié à Scutti : la page d'installation continue
toute seule. L'appairage et le nommage des appareils se font là-bas.
EOF
else
  echo
  echo "Terminé. Le boîtier tourne sur la version ${MISE_A_JOUR:+mise à jour }$(cut -c1-7 "$DEST/VERSION")."
fi
if [ "$LOCAL_PORT" != "0" ]; then
  echo "Interface locale : https://$(hostname).local:$LOCAL_PORT, avec le code d'accès choisi dans Scutti."
  echo "Empreinte du certificat : $(openssl x509 -noout -fingerprint -sha256 -in "$DEST/tls/boitier.crt" | cut -d= -f2)"
fi
