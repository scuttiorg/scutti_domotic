/**
 * Logique pure, sans I/O : à partir d'une pièce (mode, consigne manuelle,
 * règles) et d'une température, décide ce que vise le radiateur et s'il
 * doit chauffer.
 *
 * Même règle que scutti (src/modules/domotique/services/consigne.ts) : si
 * l'une change, l'autre doit changer.
 */

/** Le fuseau dans lequel les règles s'écrivent : celui du bâtiment, quel que soit celui du système. */
export const FUSEAU = process.env.FUSEAU || 'Europe/Paris';

const enMinutes = (hhmm) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const JOUR_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const LECTEUR = new Intl.DateTimeFormat('en-US', { timeZone: FUSEAU, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** L'instant en heure murale : jour ISO (lundi 1, dimanche 7) et minutes depuis minuit. */
export function heureMurale(date) {
  const parts = Object.fromEntries(LECTEUR.formatToParts(date).map((p) => [p.type, p.value]));
  return { jour: JOUR_ISO[parts.weekday] ?? 1, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function regleCouvre(regle, date) {
  if (!regle.actif) return false;
  const { jour, minutes: maintenant } = heureMurale(date);
  const debut = enMinutes(regle.heure_debut);
  const fin = enMinutes(regle.heure_fin);
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
