// LA FENÊTRE OUVERTE, devinée à la température.
//
// Une fenêtre ou une porte d'entrée ouverte fait tomber la température de la
// pièce d'un coup ; le thermostat, lui, y voyait une pièce froide et
// chauffait à pleine puissance vers dehors. Aucun capteur d'ouverture : la
// chute suffit, les capteurs envoyant leur mesure dès 0,25 °C d'écart et au
// moins toutes les cinq minutes (rapports.js).
//
// LA RÈGLE
//
// - Une baisse d'au moins `CHUTE_FENETRE` en `CHUTE_FENETRE_MS` ou moins
//   coupe la pièce pendant `COUPURE_FENETRE_MS`. Le chauffage le plus
//   puissant ne fait pas perdre un degré en cinq minutes à une pièce fermée :
//   seule une ouverture le fait.
// - Pendant la coupure, la détection ne se relance pas : la pièce continue de
//   se refroidir, ce n'est pas une deuxième fenêtre.
// - Une remontée de `REMONTEE_FENETRE` depuis le point le plus bas de la
//   coupure y met fin plus tôt : la fenêtre est refermée, la pièce se
//   réchauffe seule (murs, meubles), il est temps de l'aider.
// - À l'échéance, régulation normale.
//
// Après une coupure, l'historique repart de la dernière mesure : la chute
// qui l'a déclenchée ne doit pas la déclencher une seconde fois.
//
// Tout ici est pur : index.js garde l'état de chaque pièce et l'applique.

/** La baisse qui trahit une ouverture, en °C. */
export const CHUTE_FENETRE = 1;
/** En combien de temps au plus, en ms : cinq minutes. */
export const CHUTE_FENETRE_MS = 5 * 60_000;
/** La durée de la coupure, en ms : trente minutes. */
export const COUPURE_FENETRE_MS = 30 * 60_000;
/** La remontée qui dit la fenêtre refermée, en °C. */
export const REMONTEE_FENETRE = 0.5;

/** Les mesures arrondies au dixième : 20,3 − 19,3 doit faire 1, pas 0,999…. */
const EPSILON = 1e-9;

/** Un suivi neuf : aucune mesure, aucune coupure. */
export const SUIVI_VIDE = Object.freeze({ historique: [], fenetre: null });

/**
 * Ajoute la mesure de la pièce (`{ temperature, le }`, mesurePiece) à son
 * historique, et oublie ce qui a plus de `CHUTE_FENETRE_MS` de plus qu'elle.
 * Une mesure déjà notée (même date : le passage de la minute la relit) ne
 * compte pas deux fois.
 */
export function noterMesure(historique, mesure) {
  if (!mesure || typeof mesure.temperature !== 'number') return historique;
  const t = Date.parse(mesure.le);
  if (!Number.isFinite(t)) return historique;
  const dernier = historique.at(-1);
  if (dernier && t <= dernier.t) return historique;
  return [...historique, { t, temperature: mesure.temperature }].filter((m) => t - m.t <= CHUTE_FENETRE_MS);
}

/** La dernière mesure a perdu au moins `CHUTE_FENETRE` sur une des mesures de l'historique. */
export function chuteBrutale(historique) {
  const dernier = historique.at(-1);
  if (!dernier) return false;
  return historique.some((m) => dernier.t - m.t <= CHUTE_FENETRE_MS
    && m.temperature - dernier.temperature >= CHUTE_FENETRE - EPSILON);
}

/**
 * Le suivi de la pièce après une mesure (ou un simple passage, `mesure`
 * null quand les capteurs se taisent).
 *
 * `suivi` : `{ historique, fenetre }`, `fenetre` valant null ou
 * `{ jusqua, plancher }` (ms et °C : la fin de la coupure, et la température
 * la plus basse vue depuis son début). `active` : l'option de la pièce ;
 * coupée, aucune fenêtre ne tient.
 */
export function suivreFenetre(suivi, mesure, maintenant, active = true) {
  const historique = noterMesure(suivi.historique, mesure);
  const fenetre = suivi.fenetre;
  const depuisLaDerniere = () => historique.slice(-1);

  if (!active) return { historique, fenetre: null };

  if (fenetre) {
    if (maintenant >= fenetre.jusqua) return { historique: depuisLaDerniere(), fenetre: null };
    const temperature = mesure?.temperature;
    if (typeof temperature !== 'number') return { historique, fenetre };
    if (temperature - fenetre.plancher >= REMONTEE_FENETRE - EPSILON) {
      return { historique: depuisLaDerniere(), fenetre: null };
    }
    return { historique, fenetre: { ...fenetre, plancher: Math.min(fenetre.plancher, temperature) } };
  }

  if (chuteBrutale(historique)) {
    const dernier = historique.at(-1);
    return {
      historique: depuisLaDerniere(),
      fenetre: { jusqua: maintenant + COUPURE_FENETRE_MS, plancher: dernier.temperature },
    };
  }
  return { historique, fenetre: null };
}
