#!/usr/bin/env bash
# Relance Mosquitto et Zigbee2MQTT (chauffage-zigbee.path).
#
# La passerelle n'a pas le droit de toucher à Docker : elle dépose une
# demande, depuis Scutti (« Relancer Zigbee »), ou seule quand Zigbee ne
# répond plus depuis dix minutes (gateway/sante.js). Les deux, dans l'ordre :
# Zigbee2MQTT ne parle qu'à travers Mosquitto, et un Mosquitto figé le fait
# paraître hors ligne.
set -uo pipefail

# Prise dès le début : tant qu'elle existe, systemd relancerait ce script.
rm -f /var/lib/chauffage/demande-zigbee
cd /opt/chauffage || exit 1
# `up -d` d'abord : un conteneur arrêté ne se relance pas avec `restart`.
docker compose up -d
docker compose restart mosquitto zigbee2mqtt
echo "Mosquitto et Zigbee2MQTT relancés"
