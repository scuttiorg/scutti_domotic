// La réconciliation champ par champ, côté boîtier.
//
// Le boîtier et Scutti portent les mêmes pièces, et les deux se règlent :
// Scutti depuis le navigateur de n'importe où, le boîtier depuis son
// interface locale, en wifi, y compris quand la connexion est coupée. Aucun
// des deux ne gagne par principe : chaque champ voyage avec la date de sa
// dernière écriture, et la plus récente l'emporte, CHAMP PAR CHAMP.
//
// La même règle est écrite des deux côtés (`src/modules/domotique/services/
// fusion.ts` dans scutti). Deux implémentations pour une règle, c'est une
// de trop, mais les deux programmes ne partagent aucun code et la règle
// tient en dix lignes : la recopier coûte moins qu'un paquet à publier.
//
// L'ÉGALITÉ NE RENVERSE PAS : deux horloges ne sont jamais exactement
// d'accord, et une égalité qui bascule ferait osciller la valeur à chaque
// échange.

/** Un champ : `{ valeur, le }`, où `le` est une date ISO 8601 en UTC. */
const quand = (champ) => {
  const t = Date.parse(champ?.le ?? '');
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Ce que deux jeux de champs donnent ensemble : le plus récent de chaque
 * champ, les champs que l'un seul porte gardés tels quels.
 */
export function fusionnerChamps(locaux = {}, distants = {}) {
  const sortie = { ...locaux };
  for (const [champ, distant] of Object.entries(distants)) {
    if (quand(distant) === -Infinity) continue;
    if (quand(distant) > quand(locaux[champ])) sortie[champ] = distant;
  }
  return sortie;
}

/** Une valeur posée ici, maintenant : c'est sa date qui la fera gagner. */
export function poser(valeur, le = new Date().toISOString()) {
  return { valeur, le };
}

/** La valeur d'un champ, ou `defaut` s'il n'a jamais été posé. */
export function valeur(champs, nom, defaut = null) {
  return champs?.[nom]?.valeur ?? defaut;
}
