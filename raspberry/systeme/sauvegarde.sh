#!/usr/bin/env bash
# Sauvegarde du réseau Zigbee dans Scutti (chauffage-sauvegarde.timer, chaque nuit).
#
# La clé du réseau Zigbee et les appairages ne vivent que sur la carte SD,
# dans le dossier de Zigbee2MQTT : une carte qui meurt, et chaque appareil
# du bâtiment est à ré-appairer à la main. Ici, on en envoie une archive à
# Scutti, qui la garde chiffrée ; install.sh la redemande quand il installe
# une carte neuve, avant le premier démarrage de Zigbee2MQTT.
#
# Rien ne part si l'archive n'a pas changé depuis le dernier envoi réussi
# (empreinte SHA-256 gardée dans /var/lib/chauffage-sauvegarde). L'archive
# est donc fabriquée à l'identique d'une nuit à l'autre : mêmes dates,
# mêmes propriétaires, même ordre, et gzip sans horodatage.
#
# LE JETON NE PASSE JAMAIS EN ARGUMENT : `ps` le montrerait à tout
# utilisateur du boîtier. L'en-tête est écrit dans un fichier en 0600, que
# curl lit avec `-H @fichier`.
#
# Tout le travail est dans main(), appelée en dernière ligne : install.sh
# réinstalle ce script, et bash relit un script au fil de l'exécution.
set -euo pipefail

DEST=/opt/chauffage
ZIGBEE=$DEST/zigbee2mqtt
ENV_PASSERELLE=$DEST/gateway/.env
ETAT=/var/lib/chauffage-sauvegarde
CHEMIN=/api/public/domotique/passerelle/sauvegarde
# Ce qu'il faut pour repartir sur le même réseau : la configuration (clé du
# réseau, identifiants PAN, noms des appareils), la sauvegarde du
# coordinateur, la base des appareils, et l'état connu de chacun.
FICHIERS=(configuration.yaml coordinator_backup.json database.db state.json)
# Le plafond de Scutti : au-delà, il refuse (413), autant le dire ici.
TAILLE_MAX=$((5 * 1024 * 1024))
TRAVAIL=

# Une variable du .env de la passerelle, lue et non sourcée : ce fichier
# n'a pas à être exécuté par root.
lire_env() { sed -n "s/^$1=//p" "$ENV_PASSERELLE" 2>/dev/null | tail -n 1; }

nettoyer() { [ -z "$TRAVAIL" ] || rm -rf "$TRAVAIL"; }

main() {
  # Tout ce qui est écrit ici (copies, archive, en-tête) n'est lisible que par root.
  umask 077
  local url jeton ca
  url=$(lire_env SCUTTI_URL)
  jeton=$(lire_env SCUTTI_TOKEN)
  ca=$(lire_env SCUTTI_CA)

  if [ -z "$jeton" ] || [ "$jeton" = jeton-de-la-passerelle ]; then
    echo "boîtier pas encore relié à Scutti : rien à sauvegarder"
    return 0
  fi
  case "$url" in
    https://*) ;;
    *) echo "SCUTTI_URL doit commencer par https:// (lu : « $url »)" >&2; return 1 ;;
  esac

  # Tant que Zigbee2MQTT n'a pas démarré une fois, la clé n'est pas encore
  # tirée (`GENERATE`). Envoyer cette configuration remplacerait, dans
  # Scutti, la sauvegarde d'un réseau qui existe par celle d'aucun réseau.
  if [ ! -f "$ZIGBEE/configuration.yaml" ]; then
    echo "pas de configuration Zigbee2MQTT : rien à sauvegarder"
    return 0
  fi
  if grep -Eq '^[[:space:]]*network_key:[[:space:]]*GENERATE' "$ZIGBEE/configuration.yaml"; then
    echo "Zigbee2MQTT n'a pas encore tiré la clé du réseau : rien à sauvegarder"
    return 0
  fi

  TRAVAIL=$(mktemp -d)
  trap nettoyer EXIT
  mkdir "$TRAVAIL/zigbee"

  # Des copies, et l'archive faite sur elles : Zigbee2MQTT écrit dans ces
  # fichiers à tout moment, et tar s'arrête en erreur sur un fichier qui
  # change pendant qu'il le lit.
  local f presents=()
  for f in "${FICHIERS[@]}"; do
    if [ -f "$ZIGBEE/$f" ] && [ ! -L "$ZIGBEE/$f" ]; then
      cp "$ZIGBEE/$f" "$TRAVAIL/zigbee/$f"
      presents+=("$f")
    fi
  done

  local archive="$TRAVAIL/zigbee.tar.gz"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=u=rw,go= \
    -C "$TRAVAIL/zigbee" -cf - -- "${presents[@]}" | gzip -n -9 > "$archive"

  local empreinte taille
  empreinte=$(sha256sum "$archive" | cut -d' ' -f1)
  taille=$(stat -c %s "$archive")
  if [ "$empreinte" = "$(cat "$ETAT/empreinte" 2>/dev/null || true)" ]; then
    echo "inchangée depuis le dernier envoi (${empreinte:0:12}) : rien à envoyer"
    return 0
  fi
  if [ "$taille" -gt "$TAILLE_MAX" ]; then
    echo "archive de $taille octets, au-delà de ce que Scutti accepte ($TAILLE_MAX) : non envoyée" >&2
    return 1
  fi

  printf 'Authorization: Bearer %s\n' "$jeton" > "$TRAVAIL/entete"
  local options=(-fsS --proto "=https" --max-time 120 -X PUT
    -H @"$TRAVAIL/entete" -H 'Content-Type: application/gzip'
    --data-binary @"$archive" -o /dev/null)
  if [ -n "$ca" ]; then options+=(--cacert "$ca"); fi
  curl "${options[@]}" "$url$CHEMIN"

  # Retenue APRÈS l'envoi réussi seulement : un envoi raté se retente la nuit suivante.
  mkdir -p "$ETAT"
  printf '%s\n' "$empreinte" > "$ETAT/empreinte"
  echo "sauvegarde envoyée : ${presents[*]} ($taille octets, ${empreinte:0:12})"
}

main "$@"; exit $?
