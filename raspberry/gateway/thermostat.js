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

/**
 * Au-dessus, dehors, une pièce qui a la coupure ne chauffe pas. Chaque pièce
 * choisit son seuil dans Scutti (`seuil_exterieur`) ; celui-ci vaut pour une
 * configuration qui ne le porte pas encore.
 */
export const SEUIL_DOUX = 17;

/** Le seuil de coupure de la pièce, ou celui par défaut s'il manque ou ne se lit pas. */
export function seuilExterieur(piece) {
  const seuil = piece.seuil_exterieur;
  return typeof seuil === 'number' && Number.isFinite(seuil) ? seuil : SEUIL_DOUX;
}
/** L'avance la plus longue, par grand froid. */
export const AVANCE_MAX = 45;
/** Une température extérieure plus vieille ne compte plus (Scutti injoignable). */
const EXTERIEUR_VALIDE_MS = 3 * 3_600_000;

/** Les minutes d'avance : aucune à 15 °C dehors et au-dessus, 3 par degré en dessous. */
export function avance(exterieur) {
  return Math.min(AVANCE_MAX, Math.max(0, Math.round((15 - exterieur) * 3)));
}

function exterieurDe(exterieur, date) {
  if (!exterieur) return null;
  return date - Date.parse(exterieur.le) < EXTERIEUR_VALIDE_MS ? exterieur.temperature : null;
}

const regleA = (piece, date) => [...piece.regles]
  .sort((a, b) => a.priorite - b.priorite)
  .find((r) => regleCouvre(r, date));

/**
 * La consigne en vigueur (null = radiateur coupé). La température
 * extérieure vient de Scutti, avec la configuration de la pièce.
 */
export function consigneEnVigueur(piece, date = new Date()) {
  if (piece.mode === 'off') return null;

  if (piece.mode === 'manuel' && piece.consigne_manuelle !== null) {
    const echu = piece.manuel_jusqua !== null && new Date(piece.manuel_jusqua) < date;
    if (!echu) return piece.consigne_manuelle;
  }

  const exterieur = exterieurDe(piece.exterieur, date);
  if (piece.coupure_exterieur && exterieur !== null && exterieur > seuilExterieur(piece)) return null;

  const regle = regleA(piece, date);
  const ici = regle ? regle.consigne : piece.consigne_defaut;
  // Par temps froid, une plage plus chaude qui commence bientôt démarre maintenant.
  if (piece.anticipation && exterieur !== null && avance(exterieur) > 0) {
    const bientot = regleA(piece, new Date(date.getTime() + avance(exterieur) * 60_000));
    if (bientot && bientot.consigne > ici) return bientot.consigne;
  }
  return ici;
}

/** Hystérésis : n'allume qu'en dessous de consigne − h/2, n'éteint qu'au-dessus de consigne + h/2. */
export function doitChauffer(consigne, temperature, chauffe, hysteresis = 0.5) {
  if (consigne === null || temperature === null) return false;
  const demi = hysteresis / 2;
  if (temperature < consigne - demi) return true;
  if (temperature > consigne + demi) return false;
  return chauffe;
}

/**
 * Les capteurs d'une pièce. Une configuration d'avant les listes ne porte
 * que `capteur` : il compte, seul.
 */
export function capteursDe(piece) {
  return piece.capteurs?.length ? piece.capteurs : [{ nom: piece.capteur, compte: true }];
}

/**
 * Les prises d'une pièce : toutes celles de ses radiateurs, commandées
 * ensemble (une consigne, une marge, toutes allumées ou toutes éteintes).
 * Une configuration d'avant les radiateurs ne porte que `prise`.
 */
export function prisesDe(piece) {
  const prises = piece.prises?.length ? piece.prises : [piece.prise];
  return [...new Set(prises.filter(Boolean))];
}

/**
 * Ce qu'une nouvelle configuration demande aux prises, avant toute
 * régulation : la régulation ne commande les prises qu'au changement
 * d'état de la pièce, elle ne verrait donc ni une prise retirée ni une
 * prise ajoutée.
 *
 * - Une prise qui ne sert plus à AUCUNE pièce est coupée : sinon son
 *   radiateur resterait allumé sans plus personne pour l'éteindre.
 * - Une prise nouvelle pour sa pièce prend l'état de celle-ci (éteinte pour
 *   une pièce neuve). Une prise passée d'une pièce à une autre n'est donc
 *   jamais coupée après avoir reçu l'état de la nouvelle, quel que soit
 *   l'ordre des pièces.
 *
 * @param anciennes Map uuid -> { piece, chauffe }, l'état d'avant
 * @param pieces les pièces de la nouvelle configuration
 * @returns [prise, allumee][]
 */
export function prisesAPoser(anciennes, pieces) {
  const ordres = new Map();
  const servent = new Set(pieces.flatMap(prisesDe));
  for (const s of anciennes.values()) {
    for (const prise of prisesDe(s.piece)) if (!servent.has(prise)) ordres.set(prise, false);
  }
  for (const piece of pieces) {
    const s = anciennes.get(piece.uuid);
    const avant = new Set(s ? prisesDe(s.piece) : []);
    for (const prise of prisesDe(piece)) if (!avant.has(prise)) ordres.set(prise, s ? s.chauffe : false);
  }
  return [...ordres];
}

const moyenne = (valeurs) => Math.round((valeurs.reduce((a, b) => a + b, 0) / valeurs.length) * 10) / 10;

/**
 * Ce que mesure une pièce à plusieurs capteurs : la moyenne de ceux qui
 * comptent, ou le plus froid. Un capteur muet depuis `delai` est écarté ;
 * quand tous ceux qui comptent le sont, la pièce n'a plus de température et
 * le radiateur se coupe.
 *
 * `mesures` : nom du capteur -> { temperature, humidite, le }.
 */
export function mesurePiece(piece, mesures, maintenant, delai) {
  const vivantes = capteursDe(piece)
    .filter((c) => c.compte)
    .map((c) => mesures.get(c.nom))
    .filter((m) => m?.le && maintenant - Date.parse(m.le) < delai);
  const temperatures = vivantes.map((m) => m.temperature).filter((t) => typeof t === 'number');
  if (!temperatures.length) return null;
  const humidites = vivantes.map((m) => m.humidite).filter((h) => typeof h === 'number');
  return {
    temperature: piece.calcul === 'plus_froid' ? Math.min(...temperatures) : moyenne(temperatures),
    humidite: humidites.length ? moyenne(humidites) : null,
    le: vivantes.map((m) => m.le).sort().at(-1),
  };
}
