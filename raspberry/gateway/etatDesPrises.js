// etatDesPrises.js
//
// CE QUE LES PRISES FONT VRAIMENT, ET NON CE QU'ON LEUR A DEMANDÉ.
//
// Le boîtier commande une prise sans attendre de réponse (mqtt.js, setPlug),
// et ne recommande que si sa décision change. Un ordre perdu sur le réseau
// Zigbee, ou un appui sur le bouton de la prise, laissait donc le radiateur
// dans l'état contraire, sans que personne le voie : les relevés disaient
// « prises allumées » d'après la DEMANDE. Le 26/11, à La Calade, le boîtier
// avait coupé à 12 h 32 et rapportait « rien n'est allumé », pendant que le
// radiateur tirait 1 600 W tout l'après-midi.
//
// Chaque message d'une prise porte pourtant son état (`state`). Ce module :
//   - le lit ;
//   - décide s'il faut renvoyer l'ordre quand la prise contredit le boîtier,
//     sans s'acharner (un appui volontaire sur le bouton finit par gagner,
//     et se voit alors dans Scutti) ;
//   - dit quelles prises sont réellement allumées, pour les relevés.

/** Le temps laissé à un ordre pour arriver avant de le croire perdu. */
export const DELAI_AVANT_RATTRAPAGE = 15_000;
/** Au plus tant de renvois par prise sur la fenêtre, puis on laisse faire. */
export const RATTRAPAGES_MAX = 3;
export const FENETRE_RATTRAPAGE = 10 * 60_000;

/** L'état que rapporte une prise : true allumée, false éteinte, null inconnu. */
export function etatLu(payload) {
  if (payload?.state === 'ON') return true;
  if (payload?.state === 'OFF') return false;
  return null;
}

/**
 * Faut-il renvoyer l'ordre à une prise qui vient de dire son état ?
 *
 * `voulue` est null tant que le boîtier n'a rien décidé (juste après un
 * redémarrage) : on ne contredit pas une prise sans savoir ce qu'on veut.
 * Les essais se comptent sur une fenêtre glissante, et s'effacent dès que
 * la prise est d'accord.
 *
 * @returns {{ renvoyer: boolean, essais: number[], abandon: boolean }}
 */
export function rattraper({ voulue, reelle, derniereCommande, essais = [], maintenant }) {
  if (voulue === null || voulue === undefined || reelle === null || reelle === undefined || reelle === voulue) {
    return { renvoyer: false, essais: [], abandon: false };
  }
  if (derniereCommande && maintenant - derniereCommande < DELAI_AVANT_RATTRAPAGE) {
    return { renvoyer: false, essais, abandon: false };
  }
  const recents = essais.filter((t) => maintenant - t < FENETRE_RATTRAPAGE);
  if (recents.length >= RATTRAPAGES_MAX) return { renvoyer: false, essais: recents, abandon: true };
  return { renvoyer: true, essais: [...recents, maintenant], abandon: false };
}

/**
 * Les prises réellement allumées d'une pièce : l'état rapporté par chacune
 * quand on l'a, sinon ce qui lui a été demandé.
 *
 * @param {string[]} prises les prises de la pièce
 * @param {string[]} voulues celles que le boîtier a allumées
 * @param {Map<string, boolean>} etats l'état rapporté, prise par prise
 */
export function prisesReellementAllumees(prises, voulues, etats) {
  return prises.filter((p) => (etats.has(p) ? etats.get(p) === true : voulues.includes(p)));
}
