/**
 * Logique pure, sans I/O : à partir d'une pièce (mode, consigne manuelle,
 * règles) et d'une température, décide ce que vise le radiateur et s'il
 * doit chauffer.
 *
 * Même règle que scutti (src/modules/domotique/services/consigne.ts) : si
 * l'une change, l'autre doit changer.
 */

const enMinutes = (hhmm) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Jour ISO : lundi 1, dimanche 7. */
const jourIso = (date) => (date.getDay() === 0 ? 7 : date.getDay());

export function regleCouvre(regle, date) {
  if (!regle.actif) return false;
  const maintenant = date.getHours() * 60 + date.getMinutes();
  const debut = enMinutes(regle.heure_debut);
  const fin = enMinutes(regle.heure_fin);
  const jour = jourIso(date);
  if (debut <= fin) return regle.jours.includes(jour) && maintenant >= debut && maintenant < fin;
  // La plage passe minuit : ce soir pour le jour de la règle, ce matin pour le lendemain.
  const veille = jour === 1 ? 7 : jour - 1;
  return (regle.jours.includes(jour) && maintenant >= debut) || (regle.jours.includes(veille) && maintenant < fin);
}

/** La consigne en vigueur (null = radiateur coupé). */
export function consigneEnVigueur(piece, date = new Date()) {
  if (piece.mode === 'off') return null;

  if (piece.mode === 'manuel' && piece.consigne_manuelle !== null) {
    const echu = piece.manuel_jusqua !== null && new Date(piece.manuel_jusqua) < date;
    if (!echu) return piece.consigne_manuelle;
  }

  const regle = [...piece.regles]
    .sort((a, b) => a.priorite - b.priorite)
    .find((r) => regleCouvre(r, date));

  return regle ? regle.consigne : piece.consigne_defaut;
}

/** Hystérésis : n'allume qu'en dessous de consigne − h/2, n'éteint qu'au-dessus de consigne + h/2. */
export function doitChauffer(consigne, temperature, chauffe, hysteresis = 0.5) {
  if (consigne === null || temperature === null) return false;
  const demi = hysteresis / 2;
  if (temperature < consigne - demi) return true;
  if (temperature > consigne + demi) return false;
  return chauffe;
}
