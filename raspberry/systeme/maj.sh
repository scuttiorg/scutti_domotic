#!/usr/bin/env bash
# Mise à jour automatique du boîtier (chauffage-maj.timer, toutes les trente minutes).
#
# Le boîtier suit la branche main de scutti_domotic : ce qui y est fusionné
# arrive tout seul, sans que personne ait à se connecter au Raspberry. Il
# passe par install.sh, comme une installation : il n'y a qu'une façon de
# poser le code, et elle sait ce qu'il ne faut pas écraser.
#
# Une version qui ne tient pas debout est retirée aussitôt : on revient à la
# précédente, et on ne la retente plus tant qu'une autre n'est pas publiée.
# Sinon le boîtier la réinstallerait toutes les demi-heures, en coupant le
# chauffage à chaque fois.
#
# Tout le travail est dans main(), appelée en dernière ligne : install.sh
# réinstalle ce script pendant qu'il tourne, et bash relit un script au fil
# de l'exécution.
set -euo pipefail

DEST=/opt/chauffage
DEPOT=$DEST/depot
DEPOT_URL=https://github.com/scuttiorg/scutti_domotic
BRANCHE=main

version_installee() { cat "$DEST/VERSION" 2>/dev/null || echo aucune; }

# La passerelle tient-elle debout ? Active, et pas un seul redémarrage en
# trente secondes : un service qui plante au démarrage est relancé par
# systemd toutes les cinq secondes, et « active » seul ne le verrait pas.
sain() {
  # Un boîtier pas encore relié à Scutti ne fait pas tourner la passerelle :
  # il n'y a rien à juger.
  grep -q '^SCUTTI_TOKEN=jeton-de-la-passerelle$' "$DEST/gateway/.env" && return 0
  sleep 5
  local debut
  debut=$(systemctl show chauffage-gateway -p ActiveEnterTimestampMonotonic --value)
  sleep 30
  systemctl is-active --quiet chauffage-gateway \
    && [ "$(systemctl show chauffage-gateway -p ActiveEnterTimestampMonotonic --value)" = "$debut" ]
}

# Une seule chaîne : appelée dans un `if`, la fonction ne s'arrête plus à la
# première erreur (set -e y est suspendu), et poserait l'ancienne version.
installer() {
  # Un clone d'une seule profondeur ne garde pas forcément la version
  # précédente : on la redemande à GitHub au besoin.
  { git -C "$DEPOT" cat-file -e "$1^{commit}" 2>/dev/null \
      || git -C "$DEPOT" fetch --quiet --depth 1 origin "$1"; } \
    && git -C "$DEPOT" reset --quiet --hard "$1" \
    && MISE_A_JOUR=1 "$DEPOT/raspberry/install.sh"
}

main() {
  if [ ! -d "$DEPOT/.git" ]; then
    git clone --quiet --depth 1 --branch "$BRANCHE" "$DEPOT_URL" "$DEPOT.tmp"
    mv "$DEPOT.tmp" "$DEPOT"
  fi
  git -C "$DEPOT" fetch --quiet --depth 1 origin "$BRANCHE"

  local cible precedente
  cible=$(git -C "$DEPOT" rev-parse FETCH_HEAD)
  precedente=$(version_installee)
  [ "$cible" = "$precedente" ] && return 0
  [ "$cible" = "$(cat "$DEST/VERSION_REFUSEE" 2>/dev/null)" ] && return 0

  echo "mise à jour : ${precedente:0:7} → ${cible:0:7}"
  if installer "$cible" && sain; then
    rm -f "$DEST/VERSION_REFUSEE"
    echo "${cible:0:7} installée"
    return 0
  fi

  echo "${cible:0:7} ne tient pas debout : elle ne sera plus retentée" >&2
  echo "$cible" > "$DEST/VERSION_REFUSEE"
  # Une installation faite hors dépôt (« inconnue ») n'a pas de version où revenir.
  if [[ "$precedente" =~ ^[0-9a-f]{40}$ ]]; then
    echo "retour à ${precedente:0:7}" >&2
    installer "$precedente"
  fi
  return 1
}

main "$@"; exit $?
