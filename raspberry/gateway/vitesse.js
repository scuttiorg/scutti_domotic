// LA VITESSE DE CHAUFFE, apprise pièce par pièce.
//
// L'avance d'avant (3 min par degré sous 15 °C dehors, 45 au plus) était la
// même pour toutes les pièces : une salle de bains de 4 m² et un atelier sous
// le toit partaient ensemble. Le boîtier mesure donc ce que chaque pièce
// gagne réellement par heure de radiateur allumé, et thermostat.js en tire
// l'avance (`avanceApprise`).
//
// LA MESURE
//
// - Une période de chauffe va de l'allumage à l'extinction des prises de la
//   pièce ; elle compte si elle a duré au moins `CHAUFFE_MIN_MS` (en deçà,
//   l'inertie du radiateur et le pas des capteurs font tout le résultat), et
//   si la pièce a gagné quelque chose. Une chauffe coupée par une fenêtre
//   ouverte ou des capteurs muets ne compte pas : elle ne mesure pas le
//   radiateur.
// - Chaque mesure, ramenée entre `VITESSE_MIN` et `VITESSE_MAX`, entre dans
//   une moyenne glissante exponentielle (`LISSAGE`) : les dernières chauffes
//   pèsent le plus, ce qui suit les saisons sans retenir une matinée isolée.
//
// La vitesse est rangée dans l'état local (local.js) pour survivre au
// redémarrage, et remonte à Scutti, qui calcule la même avance pour
// l'afficher.

import { VITESSE_MIN, VITESSE_MAX, vitesseValide } from './thermostat.js';

/** La période de chauffe la plus courte qui apprend quelque chose, en ms. */
export const CHAUFFE_MIN_MS = 15 * 60_000;
/** Le poids d'une nouvelle mesure dans la moyenne : 0,3. */
export const LISSAGE = 0.3;

const centieme = (v) => Math.round(v * 100) / 100;

/**
 * Ce qu'une période de chauffe a mesuré, en °C par heure, ou null quand
 * elle n'apprend rien.
 *
 * `debut` et `fin` : `{ le (ms), temperature }` à l'allumage et à
 * l'extinction ; `interrompue` : coupée par une fenêtre ou un capteur muet.
 */
export function vitesseMesuree(debut, fin, interrompue = false) {
  if (interrompue || !debut || !fin) return null;
  if (typeof debut.temperature !== 'number' || typeof fin.temperature !== 'number') return null;
  const duree = fin.le - debut.le;
  if (!(duree >= CHAUFFE_MIN_MS)) return null;
  const gain = fin.temperature - debut.temperature;
  if (gain <= 0) return null;
  return Math.min(VITESSE_MAX, Math.max(VITESSE_MIN, gain / (duree / 3_600_000)));
}

/** La nouvelle vitesse de la pièce : la mesure seule la première fois, la moyenne glissante ensuite. */
export function apprendre(vitesse, mesure) {
  if (mesure === null) return vitesseValide(vitesse);
  const avant = vitesseValide(vitesse);
  return centieme(avant === null ? mesure : avant * (1 - LISSAGE) + mesure * LISSAGE);
}
