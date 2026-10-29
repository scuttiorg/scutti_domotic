// LA CHAUFFE FORCÉE : des radiateurs allumés pour un temps, quelle que soit
// la consigne.
//
// POURQUOI ELLE EXISTE : la régulation ne connaît que la consigne. Un
// atelier qu'on veut chaud tout de suite, une pièce qu'on sèche après un
// dégât des eaux, et il fallait inventer une consigne manuelle à 30 °C en
// espérant penser à la retirer. Le forçage dit ce qu'on veut : ces
// radiateurs-là, allumés, pendant ce temps-là, puis la régulation reprend.
//
// CE QUI EST FORCÉ, CE SONT DES PRISES : on choisit des radiateurs, mais deux
// radiateurs peuvent partager une prise (une multiprise), et c'est la prise
// qu'on allume. Les autres prises de la pièce suivent la régulation normale.
//
// IL VOYAGE COMME UN RÉGLAGE : un champ `forcage` de la pièce, `{ valeur,
// le }`, échangé avec Scutti et arbitré à la date, comme le mode
// (fusion.js). Posé ici ou dans Scutti, arrêté de l'un ou de l'autre côté,
// les deux finissent d'accord ; et il est rangé dans l'état local, donc il
// survit à un redémarrage. Son échéance est ABSOLUE : un boîtier qui
// redémarre ne le prolonge pas.
//
// SES GARDE-FOUS, ÉCRITS ICI ET DANS SCUTTI :
//   - quatre heures au plus ; au-delà, refusé, d'où qu'il vienne ;
//   - au-dessus de TEMPERATURE_MAX_FORCAGE dans la pièce, il s'arrête ;
//   - sans capteur vivant, il est suspendu : on ne chauffe pas à l'aveugle
//     (index.js), et le seuil de température ne pourrait pas être vu.
//
// Logique pure, sans I/O : index.js lit l'état et commande les prises.

import { prisesDe } from './thermostat.js';

/** Les durées proposées, en minutes : 30 min, 1 h, 2 h, 4 h. */
export const DUREES_FORCAGE = [30, 60, 120, 240];

/** Au-delà, refusé : un radiateur oublié allumé ne chauffe pas une nuit entière. */
export const FORCAGE_MAX_MINUTES = 240;

/** Au-dessus, dans la pièce, le forçage s'arrête de lui-même. */
export const TEMPERATURE_MAX_FORCAGE = 28;

/**
 * Deux horloges ne sont jamais d'accord à la seconde : une échéance posée
 * dans Scutti peut paraître ici un peu plus loin que quatre heures.
 */
const MARGE_HORLOGE_MS = 5 * 60_000;
const MAX_MS = FORCAGE_MAX_MINUTES * 60_000;

/**
 * Les radiateurs de la pièce, chacun avec ses prises, tels que Scutti les
 * envoie. Un Scutti d'avant n'envoie que les prises : chaque prise vaut
 * alors un radiateur, nommé comme elle, pour qu'on puisse encore choisir.
 */
export function radiateursDe(piece) {
  const prises = new Set(prisesDe(piece));
  const lus = Array.isArray(piece.radiateurs) ? piece.radiateurs : [];
  const radiateurs = lus
    .filter((r) => typeof r?.nom === 'string' && Array.isArray(r.prises))
    .map((r) => ({ nom: r.nom, prises: r.prises.filter((p) => prises.has(p)) }))
    .filter((r) => r.prises.length > 0);
  return radiateurs.length ? radiateurs : [...prises].map((p) => ({ nom: p, prises: [p] }));
}

/**
 * Un forçage demandé ici : les radiateurs cochés (leurs rangs dans
 * `radiateursDe`) et une durée proposée. Rend la valeur à ranger, ou `null`
 * pour une demande qui ne se pose pas : durée inconnue ou trop longue,
 * aucun radiateur.
 */
export function nouveauForcage(piece, rangs, minutes, maintenant = Date.now()) {
  const duree = Number(minutes);
  if (!DUREES_FORCAGE.includes(duree) || duree > FORCAGE_MAX_MINUTES) return null;
  const radiateurs = radiateursDe(piece);
  const choisis = [...new Set(rangs.map(Number))].filter((i) => Number.isInteger(i) && radiateurs[i]);
  const prises = [...new Set(choisis.flatMap((i) => radiateurs[i].prises))];
  if (!prises.length) return null;
  return { prises, jusqua: new Date(maintenant + duree * 60_000).toISOString() };
}

/**
 * Le forçage qui s'applique maintenant, d'après le champ rangé dans l'état
 * local, ou `null`. Il ne s'applique pas s'il est échu, s'il dure plus de
 * quatre heures (depuis sa pose comme depuis maintenant), ou s'il ne vise
 * plus aucune prise de la pièce.
 *
 * @param champ `{ valeur: { prises, jusqua } | null, le }`, ou rien
 * @returns `{ prises, jusqua }` : les prises de la pièce qu'il vise encore
 */
export function forcageEnVigueur(champ, piece, maintenant = Date.now()) {
  const valeur = champ?.valeur;
  if (!valeur || !Array.isArray(valeur.prises)) return null;
  const fin = Date.parse(valeur.jusqua);
  if (!Number.isFinite(fin) || fin <= maintenant) return null;
  if (fin - maintenant > MAX_MS + MARGE_HORLOGE_MS) return null;
  const pose = Date.parse(champ.le);
  if (Number.isFinite(pose) && fin - pose > MAX_MS + MARGE_HORLOGE_MS) return null;
  const vise = new Set(valeur.prises);
  const prises = prisesDe(piece).filter((p) => vise.has(p));
  if (!prises.length) return null;
  return { prises, jusqua: new Date(fin).toISOString() };
}

/** La pièce est trop chaude pour qu'on continue de forcer. */
export const tropChaud = (temperature) => typeof temperature === 'number' && temperature > TEMPERATURE_MAX_FORCAGE;

/**
 * Les prises qui doivent être allumées, dans l'ordre de la pièce : celles du
 * forçage, et toutes les autres si la régulation chauffe.
 */
export function prisesAllumees(piece, chauffe, forcage) {
  const forcees = new Set(forcage?.prises ?? []);
  return prisesDe(piece).filter((p) => chauffe || forcees.has(p));
}

/** Deux listes de prises allumées sont-elles les mêmes ? */
export function memesPrises(a = [], b = []) {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/**
 * Ce que le boîtier doit faire des prises d'une pièce, à chaque régulation.
 *
 * - Sans capteur vivant, le forçage est SUSPENDU (pas effacé) : on ne
 *   chauffe pas à l'aveugle, et le seuil de température ne se verrait pas.
 *   Il reprend avec la mesure, s'il n'est pas échu.
 * - Au-dessus de TEMPERATURE_MAX_FORCAGE, il est ARRÊTÉ : `arreter` dit à
 *   l'appelant de l'effacer, comme un « Arrêter », pour que Scutti le sache.
 * - Les prises ne sont commandées que si ce qui doit être allumé change, ou
 *   qu'un forçage commence ou finit : chaque fois, un relevé part.
 *
 * @param etat `{ piece, chauffe, temperature, allumees, forceJusqua }` :
 *   `chauffe` est ce que veut la régulation, `allumees` et `forceJusqua` ce
 *   qui a été commandé la dernière fois (rien après un redémarrage).
 * @param champ le champ `forcage` de l'état local
 * @returns `{ allumees, forceJusqua, forcage, commander, arreter }`
 */
export function pilotage({ piece, chauffe, temperature, allumees, forceJusqua }, champ, maintenant = Date.now()) {
  const vivant = typeof temperature === 'number';
  let forcage = vivant ? forcageEnVigueur(champ, piece, maintenant) : null;
  const arreter = Boolean(forcage) && tropChaud(temperature);
  if (arreter) forcage = null;
  const voulues = prisesAllumees(piece, chauffe, forcage);
  const jusqua = forcage?.jusqua ?? null;
  return {
    allumees: voulues,
    forceJusqua: jusqua,
    forcage,
    commander: !memesPrises(voulues, allumees) || jusqua !== (forceJusqua ?? null),
    arreter,
  };
}

/**
 * Les radiateurs que le forçage alimente tout entiers : toutes leurs prises
 * sont forcées. Un radiateur qui partage la prise d'un radiateur choisi
 * compte aussi : il chauffe.
 */
export function radiateursForces(piece, forcage) {
  const forcees = new Set(forcage?.prises ?? []);
  return radiateursDe(piece).filter((r) => r.prises.every((p) => forcees.has(p))).length;
}

/** « 15 h 30 », « 16 h », à l'heure du bâtiment. */
export function heureEnClair(iso, fuseau) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).map((p) => [p.type, p.value])
  );
  const heure = Number(parts.hour);
  return parts.minute === '00' ? `${heure} h` : `${heure} h ${parts.minute}`;
}

/** « Chauffe forcée jusqu'à 15 h 30, 2 radiateurs ». */
export function resumeForcage(piece, forcage, fuseau) {
  const n = radiateursForces(piece, forcage);
  const quoi = n > 1 ? `${n} radiateurs` : n === 1 ? '1 radiateur' : `${forcage.prises.length} prise${forcage.prises.length > 1 ? 's' : ''}`;
  return `Chauffe forcée jusqu’à ${heureEnClair(forcage.jusqua, fuseau)}, ${quoi}`;
}

/** « 30 min », « 1 h », « 4 h ». */
export const libelleDuree = (minutes) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`);
