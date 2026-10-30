// L'HEURE D'UNE MESURE, qui tient quand le Raspberry se remet à l'heure.
//
// Le Raspberry n'a pas de pile pour garder l'heure : il démarre sur la
// dernière heure qu'il a notée avant d'être éteint, et ne se recale qu'une
// fois le réseau revenu. Le 30/10, rallumé après plus de deux heures sans
// courant, il a reçu un relevé à « 10 h 30 », puis sauté à 12 h 54 : le
// relevé, vieux de quelques secondes, a paru vieux de deux heures, et la
// pièce a été coupée pour « capteurs muets ».
//
// L'âge d'une mesure se compte donc sur un chronomètre qui ne saute jamais
// (`instant`, l'horloge monotone du système), et l'heure qu'on en montre se
// déduit au moment de la lire (`dateDe`) : quand l'horloge saute, toutes les
// heures déjà notées suivent ensemble, et restent comparables entre elles.

/** Un écart plus grand est un saut de l'horloge, pas sa dérive ordinaire. */
export const SAUT_MS = 30_000;

/** L'heure murale moins le chronomètre : constant tant que l'horloge ne saute pas. */
let decalage = Date.now() - performance.now();

/** Le chronomètre, en ms : seul à servir pour une durée. */
export const instant = () => performance.now();

/**
 * L'heure murale d'un `instant`. Si l'horloge a sauté depuis la dernière
 * lecture, le saut est pris en compte ici, pour tous les instants à la fois.
 */
export function dateDe(vu) {
  const maintenant = Date.now() - performance.now();
  if (Math.abs(maintenant - decalage) > SAUT_MS) {
    const saut = Math.round((maintenant - decalage) / 60_000);
    console.log(`[horloge] l’heure du boîtier a sauté de ${saut > 0 ? '+' : ''}${saut} min : les mesures déjà reçues sont recalées`);
    decalage = maintenant;
  }
  return new Date(Math.round(vu + decalage));
}
