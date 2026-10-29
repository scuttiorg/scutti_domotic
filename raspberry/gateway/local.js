// L'ÉTAT LOCAL DU BOÎTIER : ce qu'il sait des pièces et des appareils, avec
// la date de chaque champ, sur son propre disque.
//
// POURQUOI UN FICHIER PLUTÔT QUE LA MÉMOIRE : c'est ce qui rend le boîtier
// indépendant. Réglé pendant une coupure, il redémarre avec ce réglage, et
// le fera gagner au prochain échange parce que sa date est plus récente.
// Sans ce fichier, un redémarrage perdrait le réglage sans rien dire.
//
// LA FORME EST CELLE DE L'ÉCHANGE : `{ valeur, le }` par champ. Rien n'est
// traduit entre le disque, le réseau et l'écran, donc rien ne peut diverger
// entre les trois.
//
// LES VITESSES DE CHAUFFE (vitesse.js) y sont aussi, à part : le boîtier les
// apprend seul, elles ne s'arbitrent pas, et un redémarrage ne doit pas
// effacer des semaines de mesures. `vitesses` : uuid de la pièce -> °C/h.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fusionnerChamps, poser } from './fusion.js';

const VIDE = { pieces: {}, appareils: {}, vitesses: {} };

export default class EtatLocal {
  constructor(fichier) {
    this.fichier = fichier;
    this.etat = this.#lire();
  }

  #lire() {
    if (!existsSync(this.fichier)) return structuredClone(VIDE);
    try {
      const lu = JSON.parse(readFileSync(this.fichier, 'utf8'));
      return { pieces: lu?.pieces ?? {}, appareils: lu?.appareils ?? {}, vitesses: lu?.vitesses ?? {} };
    } catch {
      // Un fichier abîmé (coupure de courant pendant l'écriture) ne doit pas
      // empêcher le boîtier de démarrer : il repart vide et se remplira au
      // premier échange.
      console.warn('[local] état illisible, on repart de zéro');
      return structuredClone(VIDE);
    }
  }

  /** Écriture par renommage : un fichier à moitié écrit n'existe jamais. */
  #ecrire() {
    const provisoire = `${this.fichier}.tmp`;
    writeFileSync(provisoire, JSON.stringify(this.etat), { mode: 0o600 });
    renameSync(provisoire, this.fichier);
  }

  /** Les pièces, telles que l'écran et le thermostat les lisent. */
  pieces() {
    return Object.entries(this.etat.pieces).map(([uuid, champs]) => ({ uuid, champs }));
  }

  appareils() {
    return Object.entries(this.etat.appareils).map(([ieee, champs]) => ({ ieee, champs }));
  }

  champsPiece(uuid) {
    return this.etat.pieces[uuid] ?? {};
  }

  champsAppareil(ieee) {
    return this.etat.appareils[ieee] ?? {};
  }

  /**
   * Une valeur réglée ICI, maintenant. C'est la date posée à cet instant qui
   * la fera gagner à l'échange, qu'il ait lieu dans une seconde ou demain.
   */
  poserPiece(uuid, champ, valeur) {
    this.etat.pieces[uuid] = { ...this.champsPiece(uuid), [champ]: poser(valeur) };
    this.#ecrire();
  }

  poserAppareil(ieee, champ, valeur) {
    this.etat.appareils[ieee] = { ...this.champsAppareil(ieee), [champ]: poser(valeur) };
    this.#ecrire();
  }

  /** La vitesse de chauffe apprise pour la pièce (°C/h), ou null. */
  vitesse(uuid) {
    return this.etat.vitesses[uuid] ?? null;
  }

  /** Range la vitesse apprise ; null l'oublie. */
  poserVitesse(uuid, vitesse) {
    if (vitesse === null) delete this.etat.vitesses[uuid];
    else this.etat.vitesses[uuid] = vitesse;
    this.#ecrire();
  }

  /** Ce qui part à l'échange : tout, Scutti écartant ce qui est plus vieux que chez lui. */
  pourEchange() {
    return { pieces: this.pieces(), appareils: this.appareils() };
  }

  /**
   * Ce que l'échange rend : l'état d'APRÈS arbitrage, côté Scutti. On le
   * refusionne ici avec la même règle, car un réglage fait pendant l'appel
   * ne doit pas être perdu par la réponse.
   *
   * Les pièces absentes de la réponse ont été supprimées dans Scutti : elles
   * disparaissent d'ici aussi, sinon le boîtier chaufferait pour une pièce
   * qui n'existe plus. Leur vitesse apprise part avec elles.
   */
  appliquerRetour({ pieces = [], appareils = [] } = {}) {
    const neuf = { pieces: {}, appareils: {}, vitesses: {} };
    for (const piece of pieces) {
      neuf.pieces[piece.uuid] = fusionnerChamps(this.champsPiece(piece.uuid), piece.champs);
      if (this.etat.vitesses[piece.uuid] !== undefined) neuf.vitesses[piece.uuid] = this.etat.vitesses[piece.uuid];
    }
    for (const appareil of appareils) {
      neuf.appareils[appareil.ieee] = fusionnerChamps(this.champsAppareil(appareil.ieee), appareil.champs);
    }
    this.etat = neuf;
    this.#ecrire();
  }
}
