// LA SANTÉ DU BOÎTIER, envoyée à Scutti.
//
// Un boîtier seul dans un bâtiment ne se plaint pas : le 30/10, il a été
// éteint plus de deux heures, et Scutti disait seulement « capteur muet ».
// Il dit donc à Scutti, à chaque démarrage puis toutes les cinq minutes, ce
// qu'un technicien irait lire sur place :
//
// - POURQUOI IL A DÉMARRÉ (`causeDuDemarrage`) : coupure de courant,
//   redémarrage demandé, redémarrage par le chien de garde du réseau,
//   mise à jour, plantage de la passerelle ;
// - sa version, et la dernière vérification de la mise à jour ;
// - la liaison avec Mosquitto et Zigbee2MQTT ;
// - la température du processeur, une alimentation trop faible, le wifi, la
//   place sur la carte SD.
//
// LE CYCLE. Chaque démarrage écrit `cycle.json` (le démarrage du système
// qu'il a vu, la version), chaque arrêt propre y ajoute sa date. Au
// démarrage suivant, ce qui manque dit ce qui s'est passé : pas de date
// d'arrêt, c'est que le boîtier n'a pas eu le temps de s'arrêter.
//
// ZIGBEE QUI NE RÉPOND PLUS. Zigbee2MQTT qui a perdu sa clé USB, ou Mosquitto
// figé, ne reviennent pas toujours seuls : après dix minutes, la passerelle
// demande à les relancer (`relanceZigbeeDue`), au plus toutes les trente
// minutes, puis de plus en plus rarement tant que rien ne revient. Elle n'a
// pas le droit de toucher à Docker : elle dépose une demande, et systemd la
// prend (systeme/chauffage-zigbee.path).
//
// Tout ce qui décide est pur ; ce qui lit le système ne lève jamais et rend
// null quand une valeur manque (un Raspberry d'un autre modèle, un PC de
// développement).

import { readFileSync, writeFileSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

/** Ce que Zigbee ou MQTT peut rester sans répondre avant qu'on les relance. */
export const SILENCE_AVANT_RELANCE_MS = 10 * 60_000;
/** Le délai entre deux relances, doublé à chaque relance restée sans effet. */
export const ENTRE_DEUX_RELANCES_MS = 30 * 60_000;
export const ENTRE_DEUX_RELANCES_MAX_MS = 6 * 3600_000;
/** Un redémarrage par le chien de garde du réseau s'inscrit au plus ce temps avant le démarrage. */
const REDEMARRAGE_RESEAU_MS = 10 * 60_000;

// ── Le cycle : pourquoi le boîtier a démarré ────────────────────────────────

/**
 * La cause du démarrage, d'après le cycle précédent.
 *
 * - `precedent` : `cycle.json` tel que le démarrage d'avant l'a laissé, ou
 *   null (première fois) ;
 * - `bootId` : l'identifiant du démarrage du système en cours ;
 * - `boitierLe` : quand le système a démarré (ms) ;
 * - `reseauLe` : le dernier redémarrage décidé par le chien de garde du
 *   réseau (systeme/reseau.sh), ou null.
 *
 * Un redémarrage décidé (par quelqu'un, par le chien de garde du réseau)
 * arrête la passerelle proprement ; une coupure de courant, ou un boîtier
 * figé que le chien de garde matériel relance, ne lui en laisse pas le temps.
 *
 * Rend l'une de : `installation`, `mise_a_jour`, `relance`, `plantage`,
 * `reseau`, `redemarrage`, `coupure`.
 */
export function causeDuDemarrage({ precedent, bootId, version, boitierLe, reseauLe }) {
  if (!precedent?.boot_id) return 'installation';
  if (precedent.boot_id === bootId) {
    if (!precedent.arret_le) return 'plantage';
    return precedent.version && version && precedent.version !== version ? 'mise_a_jour' : 'relance';
  }
  if (reseauLe !== null && reseauLe <= boitierLe && boitierLe - reseauLe < REDEMARRAGE_RESEAU_MS) return 'reseau';
  return precedent.arret_le ? 'redemarrage' : 'coupure';
}

/** Le cycle laissé par le démarrage précédent, ou null. */
export function lireCycle(fichier) {
  try {
    const cycle = JSON.parse(readFileSync(fichier, 'utf8'));
    return cycle && typeof cycle === 'object' ? cycle : null;
  } catch {
    return null;
  }
}

/** Écrit le cycle ; un échec se dit, mais n'arrête rien. */
export function ecrireCycle(fichier, cycle) {
  try {
    writeFileSync(fichier, JSON.stringify(cycle), { mode: 0o600 });
  } catch (e) {
    console.warn('[santé] cycle non écrit :', e.message);
  }
}

// ── La relance de Zigbee2MQTT et Mosquitto ──────────────────────────────────

/**
 * Faut-il relancer Zigbee2MQTT et Mosquitto ? `liaison` : ce que mqtt.js
 * sait (`mqtt`, `mqttDepuis`, `zigbee`, `zigbeeDepuis`, en ms du
 * chronomètre) ; `relances` : `{ derniere, suite }`, la dernière relance et
 * le nombre de relances faites depuis que tout répondait. La première
 * attend dix minutes de panne, la suivante trente minutes de plus, puis une
 * heure, deux, jusqu'à six heures.
 *
 * Zigbee se juge à travers MQTT : MQTT coupé, on ne sait rien de Zigbee, et
 * c'est MQTT qui compte.
 */
export function relanceZigbeeDue(liaison, relances, maintenant) {
  const enPanneDepuis = !liaison.mqtt
    ? liaison.mqttDepuis
    : liaison.zigbee === true ? null : liaison.zigbeeDepuis;
  if (enPanneDepuis === null || maintenant - enPanneDepuis < SILENCE_AVANT_RELANCE_MS) return false;
  if (relances.derniere === null) return true;
  const attente = Math.min(ENTRE_DEUX_RELANCES_MAX_MS, ENTRE_DEUX_RELANCES_MS * 2 ** Math.max(0, relances.suite - 1));
  return maintenant - relances.derniere >= attente;
}

// ── Ce que le système dit de lui-même ───────────────────────────────────────

const lire = (chemin) => {
  try { return readFileSync(chemin, 'utf8').trim(); } catch { return null; }
};

/** Le niveau du wifi en dBm, lu dans /proc/net/wireless ; null sans wifi. */
export function wifiDbm(texte) {
  for (const ligne of (texte ?? '').split('\n')) {
    const m = ligne.match(/^\s*wl\w+:\s+\S+\s+[\d.]+\s+(-?[\d.]+)/);
    if (m) return Math.round(Number(m[1]));
  }
  return null;
}

/**
 * L'alarme de sous-tension du Raspberry Pi 5 (`rpi_volt`) : une
 * alimentation trop faible, première cause des redémarrages inexpliqués.
 * Null quand le modèle ne la donne pas.
 */
function sousTension() {
  try {
    for (const h of readdirSync('/sys/class/hwmon')) {
      if (lire(`/sys/class/hwmon/${h}/name`) === 'rpi_volt') {
        return lire(`/sys/class/hwmon/${h}/in0_lcrit_alarm`) === '1';
      }
    }
  } catch { /* pas de capteurs : un autre modèle, ou un PC */ }
  return null;
}

const pourcent = (part, tout) => (tout > 0 ? Math.round((part / tout) * 100) : null);

/** Les mesures du système, chacune null quand elle manque. */
export function mesuresSysteme() {
  const temperature = Number(lire('/sys/class/thermal/thermal_zone0/temp'));
  let disqueLibre = null;
  try {
    const d = statfsSync('/');
    disqueLibre = pourcent(d.bavail, d.blocks);
  } catch { /* hors Linux */ }
  return {
    modele: lire('/proc/device-tree/model')?.replace(/\0/g, '') ?? null,
    temperature_cpu: Number.isFinite(temperature) && temperature > 0 ? Math.round(temperature / 100) / 10 : null,
    sous_tension: sousTension(),
    wifi_dbm: wifiDbm(lire('/proc/net/wireless')),
    disque_libre: disqueLibre,
    memoire_libre: pourcent(os.freemem(), os.totalmem()),
    charge: Math.round(os.loadavg()[0] * 100) / 100,
  };
}

/** Le dernier redémarrage décidé par le chien de garde du réseau (systeme/reseau.sh), en ms, ou null. */
export function redemarrageReseauLe() {
  const secondes = Number(lire('/var/lib/chauffage-reseau/redemarrage'));
  return Number.isFinite(secondes) && secondes > 0 ? secondes * 1000 : null;
}

/** L'identifiant du démarrage en cours du système, ou null hors Linux. */
export const bootId = () => lire('/proc/sys/kernel/random/boot_id');


/**
 * Ce que la mise à jour automatique a laissé dans le dossier du boîtier
 * (systeme/maj.sh) : la version posée, celle qu'elle a refusée, et sa
 * dernière vérification.
 */
const sha = (v) => (/^[0-9a-f]{40}$/.test(v ?? '') ? v : null);

export function etatMiseAJour(dossier) {
  const version = lire(join(dossier, 'VERSION'));
  let derniere = null;
  try {
    derniere = JSON.parse(lire(join(dossier, 'MAJ_ETAT')) ?? 'null');
  } catch { /* illisible : comme absent */ }
  return {
    version: sha(version),
    version_refusee: sha(lire(join(dossier, 'VERSION_REFUSEE'))),
    verifiee_le: typeof derniere?.le === 'string' ? derniere.le : null,
    resultat: typeof derniere?.resultat === 'string' ? derniere.resultat : null,
  };
}

/** Dépose une demande pour systemd (`demande-maj`, `demande-zigbee`) ; rend faux si elle n'a pas pu l'être. */
export function deposerDemande(dossier, quoi) {
  try {
    writeFileSync(join(dossier, `demande-${quoi}`), new Date().toISOString());
    return true;
  } catch (e) {
    console.warn(`[santé] demande ${quoi} non déposée :`, e.message);
    return false;
  }
}
