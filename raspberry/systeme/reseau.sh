#!/usr/bin/env bash
# Le boîtier garde son réseau tout seul (chauffage-reseau.timer, toutes les deux minutes).
#
# Un Raspberry qui perd le wifi (box redémarrée, coupure de courant) ne le
# retrouve pas toujours : il reste allumé, LED verte, et introuvable. Ici,
# on vérifie que la box répond ; sinon on relance le wifi, et si le réseau
# manque depuis une demi-heure, on redémarre le boîtier.
#
# Au plus un redémarrage toutes les six heures : une box éteinte pour la
# journée ne doit pas le faire redémarrer en boucle, et la régulation
# continue sur place sans réseau, sur la dernière configuration connue.
set -uo pipefail

ETAT=/var/lib/chauffage-reseau
ECHECS_AVANT_REDEMARRAGE=15          # 15 passages de 2 min : une demi-heure
ENTRE_DEUX_REDEMARRAGES=$((6 * 3600))

# La box répond au ping, ou Scutti répond : certaines box ignorent le ping,
# et un faux « injoignable » relancerait le wifi toutes les deux minutes.
joignable() {
  local box url
  box=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
  [ -n "$box" ] || return 1
  ping -c 2 -W 3 "$box" >/dev/null 2>&1 && return 0
  url=$(sed -n 's/^SCUTTI_URL=//p' /opt/chauffage/gateway/.env 2>/dev/null)
  [ -n "$url" ] && curl -s -o /dev/null -m 10 "$url"
}

relancer_wifi() {
  if command -v nmcli >/dev/null 2>&1; then
    nmcli radio wifi off
    sleep 5
    nmcli radio wifi on
  fi
}

main() {
  mkdir -p "$ETAT"
  if joignable; then
    rm -f "$ETAT/echecs"
    return 0
  fi

  local echecs dernier
  echecs=$(( $(cat "$ETAT/echecs" 2>/dev/null || echo 0) + 1 ))
  echo "$echecs" > "$ETAT/echecs"
  echo "réseau injoignable (${echecs}e passage) : relance du wifi"
  relancer_wifi

  [ "$echecs" -ge "$ECHECS_AVANT_REDEMARRAGE" ] || return 0
  dernier=$(cat "$ETAT/redemarrage" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - dernier )) -ge "$ENTRE_DEUX_REDEMARRAGES" ]; then
    date +%s > "$ETAT/redemarrage"
    rm -f "$ETAT/echecs"
    echo "réseau absent depuis $(( echecs * 2 )) min : redémarrage du boîtier"
    systemctl reboot
  fi
}

main "$@"; exit $?
