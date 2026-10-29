// QUI A LE DROIT DE RÉGLER LE CHAUFFAGE SUR PLACE.
//
// Être sur le wifi du bâtiment ne suffit pas : un wifi se pirate, et celui
// qui y entre ne doit pas pouvoir couper le chauffage ni appairer son propre
// appareil. L'interface locale demande donc un code, choisi dans Scutti.
//
// LE BOÎTIER N'A JAMAIS LE CODE. Scutti lui envoie un vérificateur scrypt
// (`scrypt$N$r$p$sel$empreinte`, base64), dans la configuration qu'il lit
// avec son jeton. Une carte SD volée ne donne que lui, et scrypt rend
// l'essai de chaque code coûteux.
//
// SANS CODE, PAS D'INTERFACE. Tant que Scutti n'a pas posé de code, ou s'il
// l'a retiré, toute page est refusée : un boîtier neuf est fermé par défaut.
//
// LES ESSAIS SONT COMPTÉS POUR TOUT LE BOÎTIER, pas par adresse : sur un
// réseau local, changer d'adresse ne coûte rien. Cinq erreurs en un quart
// d'heure ferment la porte jusqu'à ce que la plus ancienne sorte de la
// fenêtre. Un intrus peut donc bloquer l'interface locale ; il ne peut pas
// deviner le code, et Scutti reste là.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const ESSAIS_MAX = 5;
const FENETRE_ESSAIS = 15 * 60_000;
const SESSION_INACTIVE = 12 * 3600_000;
const SESSION_MAX = 7 * 24 * 3600_000;
const SESSIONS_MAX = 50;

/** Le vérificateur lu, ou null s'il n'a pas la forme attendue. */
function lireVerificateur(verificateur) {
  const parties = String(verificateur ?? '').split('$');
  if (parties.length !== 6 || parties[0] !== 'scrypt') return null;
  const [N, r, p] = parties.slice(1, 4).map(Number);
  const sel = Buffer.from(parties[4], 'base64');
  const empreinte = Buffer.from(parties[5], 'base64');
  // Des paramètres bornés : un vérificateur abîmé ne doit pas pouvoir
  // demander au Raspberry des gigaoctets de mémoire.
  const puissanceDeDeux = Number.isInteger(N) && N >= 1024 && N <= 131_072 && (N & (N - 1)) === 0;
  if (!puissanceDeDeux || !(r >= 1 && r <= 8) || !(p >= 1 && p <= 4)) return null;
  if (sel.length < 16 || empreinte.length < 32) return null;
  return { N, r, p, sel, empreinte };
}

/**
 * Le code saisi correspond-il au vérificateur ? En temps constant.
 *
 * Débarrassé de ses espaces de bord, comme Scutti le fait avant de calculer
 * le vérificateur : une espace laissée par le clavier d'un téléphone ne doit
 * pas refuser le bon code.
 */
export function verifierCode(code, verificateur) {
  const v = lireVerificateur(verificateur);
  const saisi = typeof code === 'string' ? code.trim() : '';
  if (!v || !saisi) return Promise.resolve(false);
  return new Promise((resolve) => {
    scrypt(saisi.normalize('NFC'), v.sel, v.empreinte.length,
      { N: v.N, r: v.r, p: v.p, maxmem: 256 * v.N * v.r },
      (erreur, calcule) => resolve(!erreur && timingSafeEqual(calcule, v.empreinte)));
  });
}

export default class Acces {
  /**
   * @param verificateur () => le vérificateur en vigueur, ou null. Lu à
   *   chaque demande : un code changé dans Scutti ferme aussitôt les
   *   sessions ouvertes avec l'ancien.
   */
  constructor(verificateur, maintenant = Date.now) {
    this.verificateur = verificateur;
    this.maintenant = maintenant;
    this.essais = [];
    this.sessions = new Map();
  }

  /** Un code est-il posé ? Sans lui, l'interface est fermée. */
  ouvert() {
    return lireVerificateur(this.verificateur()) !== null;
  }

  /** Secondes avant de pouvoir réessayer, 0 si on peut. */
  attente() {
    const limite = this.maintenant() - FENETRE_ESSAIS;
    this.essais = this.essais.filter((t) => t > limite);
    if (this.essais.length < ESSAIS_MAX) return 0;
    return Math.ceil((this.essais[0] - limite) / 1000);
  }

  /**
   * Un code contre une session. L'essai est compté AVANT la vérification :
   * des demandes envoyées en même temps ne passent pas toutes sous la limite
   * pendant que scrypt calcule.
   *
   * @returns le jeton de session, ou null.
   */
  async connecter(code) {
    if (!this.ouvert() || this.attente() > 0) return null;
    const verificateur = this.verificateur();
    const essai = this.maintenant();
    this.essais.push(essai);
    if (!(await verifierCode(code, verificateur))) return null;
    this.essais.splice(this.essais.indexOf(essai), 1);

    if (this.sessions.size >= SESSIONS_MAX) this.sessions.delete(this.sessions.keys().next().value);
    const jeton = randomBytes(32).toString('base64url');
    const t = this.maintenant();
    this.sessions.set(jeton, { verificateur, ouverte: t, vue: t });
    return jeton;
  }

  /** La session est-elle valable ? Elle se prolonge à chaque passage. */
  valide(jeton) {
    const session = jeton ? this.sessions.get(jeton) : undefined;
    if (!session) return false;
    const t = this.maintenant();
    const perimee = t - session.vue > SESSION_INACTIVE || t - session.ouverte > SESSION_MAX;
    if (perimee || session.verificateur !== this.verificateur()) {
      this.sessions.delete(jeton);
      return false;
    }
    session.vue = t;
    return true;
  }

  deconnecter(jeton) {
    if (jeton) this.sessions.delete(jeton);
  }
}

export const DUREE_SESSION_SECONDES = SESSION_MAX / 1000;
