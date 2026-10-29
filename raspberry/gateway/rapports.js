// LES CAPTEURS PARLENT PLUS SOUVENT.
//
// Un thermomètre sur pile n'envoie sa mesure que lorsqu'elle a assez changé
// (souvent un demi-degré) ou à long intervalle : son écran affichait 16,6 °C
// quand Scutti, et donc la régulation, en était encore à 17,1. On lui
// demande d'envoyer dès 0,25 °C d'écart (3 % d'humidité), et au moins toutes
// les cinq minutes : assez fin pour une marge de régulation d'un demi-degré,
// sans user la pile pour des dixièmes qui ne changent rien au chauffage.
//
// Seulement aux capteurs dont une pièce se sert, et seulement s'il le faut :
// Zigbee2MQTT dit, dans sa liste des appareils, comment chacun est réglé.
//
// UN CAPTEUR SUR PILE DORT, et n'entend rien pendant ce temps. Le meilleur
// moment pour lui parler est juste après qu'il a envoyé une mesure : c'est
// là que la demande part, et un échec se retente au réveil suivant, au plus
// toutes les dix minutes.

/** Ce qu'on veut, par mesure. `reportable_change` est en centièmes de l'unité. */
export const VOULU = [
  { cluster: 'msTemperatureMeasurement', attribute: 'measuredValue', reportable_change: 25 },  // 0,25 °C
  { cluster: 'msRelativeHumidity', attribute: 'measuredValue', reportable_change: 300 },       // 3 %
].map((m) => ({ ...m, minimum_report_interval: 10, maximum_report_interval: 300 }));

export const ENTRE_DEUX_ESSAIS = 10 * 60_000;

/** Le réglage en place convient-il ? Aussi fin et aussi fréquent, ou mieux. */
function convient(actuel, voulu) {
  return actuel
    && actuel.reportable_change <= voulu.reportable_change
    && actuel.maximum_report_interval > 0
    && actuel.maximum_report_interval <= voulu.maximum_report_interval;
}

/**
 * Les réglages à demander à un appareil de `bridge/devices` : pour chaque
 * mesure qu'il porte (le cluster est dans les entrées d'un de ses
 * endpoints) et qui n'est pas déjà réglée comme il faut.
 */
export function reglagesManquants(appareil) {
  const manquants = [];
  for (const [endpoint, ep] of Object.entries(appareil?.endpoints ?? {})) {
    const entrees = ep?.clusters?.input ?? [];
    const enPlace = ep?.configured_reportings ?? [];
    for (const voulu of VOULU) {
      if (!entrees.includes(voulu.cluster)) continue;
      const actuel = enPlace.find((r) => r.cluster === voulu.cluster && r.attribute === voulu.attribute);
      if (convient(actuel, voulu)) continue;
      manquants.push({ id: appareil.friendly_name, endpoint: Number(endpoint), ...voulu });
    }
  }
  return manquants;
}
