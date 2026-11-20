// LA PUISSANCE MESURÉE, pièce par pièce.
//
// Jusqu'ici Scutti estimait la consommation d'après la puissance déclarée
// des radiateurs et le temps où leurs prises étaient allumées. Une prise qui
// mesure (Nous A7Z et la plupart des prises Tuya) dit ce qui passe vraiment :
// un radiateur dont le thermostat intégré coupe, un radiateur plus faible
// que sa plaque, ou une prise allumée sur rien se voient alors.
//
// UNE MESURE NE VAUT QUE FRAÎCHE ET APRÈS LA BASCULE. Une prise n'envoie sa
// puissance que lorsqu'elle change : une mesure de plus de dix minutes ne
// dit plus rien, et celle qui arrive dans les secondes qui suivent un
// allumage est encore celle d'avant (ou celle d'un radiateur qui démarre).
// Sans mesure valable pour TOUTES les prises de la pièce, la pièce n'a pas
// de puissance mesurée et Scutti garde son estimation : une somme à
// moitié mesurée serait fausse sans le dire.
//
// LE DÉTAIL PART AUSSI, prise par prise (`mesuresDesPrises`) : une pièce à
// plusieurs radiateurs ne disait pas lequel consommait, et une prise allumée
// sur rien ne se voyait pas. Chaque prise qui mesure est rapportée pour
// elle-même, même quand sa voisine se tait, et Scutti estime la part des
// autres.
//
// Logique pure, sans I/O : index.js tient les mesures et les commandes.

/** Au-delà, une mesure ne dit plus ce que tire la prise. */
export const MESURE_VALIDE_MS = 10 * 60_000;
/** Après une commande, le temps que la prise mesure le nouvel état. */
export const APRES_BASCULE_MS = 30_000;
/** Une puissance hors de ces bornes est une erreur de lecture, pas une mesure (W). */
export const PUISSANCE_MAX = 20_000;

/** La puissance lue dans un message de prise, si elle est plausible. */
export function puissanceLue(payload) {
  const w = payload?.power;
  return typeof w === 'number' && Number.isFinite(w) && w >= 0 && w <= PUISSANCE_MAX ? w : null;
}

/** Le compteur d'énergie lu dans un message de prise (kWh), s'il est plausible. */
export function energieLue(payload) {
  const kwh = payload?.energy;
  return typeof kwh === 'number' && Number.isFinite(kwh) && kwh >= 0 ? kwh : null;
}

/** La mesure de la prise si elle vaut encore, sinon null. */
export function mesureValable(vu, commandeLe, maintenant) {
  if (typeof vu?.puissance !== 'number' || !vu.puissanceLe) return null;
  const le = Date.parse(vu.puissanceLe);
  if (!Number.isFinite(le) || maintenant - le > MESURE_VALIDE_MS) return null;
  if (commandeLe !== undefined && le < commandeLe + APRES_BASCULE_MS) return null;
  return vu.puissance;
}

/**
 * Ce que mesure CHAQUE prise de la pièce, en watts, par nom de prise. Une
 * prise sans mesure valable est absente de l'objet, et non à zéro : Scutti
 * compte alors sa part estimée plutôt qu'une consommation nulle inventée.
 * Objet vide quand aucune prise ne mesure.
 *
 * C'est le détail qui manquait à `puissanceMesuree` : la somme d'une pièce
 * ne dit pas lequel de ses radiateurs a consommé, et elle se taisait dès
 * qu'une seule prise ne mesurait pas.
 */
export function mesuresDesPrises(prises, vus, commandes, maintenant) {
  const mesures = {};
  for (const prise of prises) {
    const w = mesureValable(vus.get(prise), commandes.get(prise), maintenant);
    if (w !== null) mesures[prise] = Math.round(w);
  }
  return mesures;
}

/**
 * La puissance que tirent ensemble les prises d'une pièce, en watts, ou
 * null dès qu'une prise n'a pas de mesure valable.
 *
 * `vus` : nom -> { puissance, puissanceLe } ; `commandes` : nom -> ms de la
 * dernière commande envoyée à la prise.
 */
export function puissanceMesuree(prises, vus, commandes, maintenant) {
  if (!prises.length) return null;
  let total = 0;
  for (const prise of prises) {
    const w = mesureValable(vus.get(prise), commandes.get(prise), maintenant);
    if (w === null) return null;
    total += w;
  }
  return Math.round(total);
}
