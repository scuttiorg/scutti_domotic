import config from './config.js';
import { subscribe, unsubscribe, setPlug, onInventaire, onVu, requeteBridge } from './mqtt.js';
import { consigneEnVigueur, doitChauffer, capteursDe, prisesDe, prisesAPoser, mesurePiece, FUSEAU } from './thermostat.js';
import { fetchConfiguration, pushReleves, fetchCommandes, ackCommande, putAppareils, echanger } from './scutti.js';
import { construireAppareils, signature } from './devices.js';
import EtatLocal from './local.js';
import { valeur } from './fusion.js';
import { demarrerInterfaceLocale } from './web.js';
import Acces from './acces.js';
import Basculements from './basculements.js';
import { reglagesManquants, ENTRE_DEUX_ESSAIS } from './rapports.js';
import { suivreFenetre, SUIVI_VIDE } from './fenetre.js';
import { vitesseMesuree, apprendre } from './vitesse.js';
import {
  pilotage, forcageEnVigueur, nouveauForcage, radiateursDe, resumeForcage, TEMPERATURE_MAX_FORCAGE,
} from './forcage.js';

/** Ce qui a été réglé ICI, avec la date de chaque champ (local.js). */
const local = new EtatLocal(config.etatFile);
let dernierEchange = { le: null, ok: false };
let appairageJusqua = 0;
/** Le nom du boîtier vient de Scutti : il est posé à la déclaration, là-bas. */
let nomBoitier = 'Boîtier';
/**
 * Le vérificateur du code d'accès local, posé dans Scutti (acces.js). Il
 * vient de la configuration, donc du cache quand Scutti est injoignable :
 * l'interface de secours reste ouverte à qui a le code. Null : fermée.
 */
let verificateurLocal = null;

/**
 * pieceUuid -> { piece, temperature, humidite, chauffe, releveLe, suivi, chauffeDepuis }
 *
 * `suivi` : l'historique court des mesures et la coupure en cours quand une
 * fenêtre est ouverte (fenetre.js). `chauffeDepuis` : l'allumage en cours,
 * `{ le, temperature }`, d'où la vitesse de chauffe s'apprend (vitesse.js).
 */
const state = new Map();
const pieceNeuve = (piece) => ({
  piece, temperature: null, humidite: null, chauffe: false, releveLe: null, suivi: SUIVI_VIDE, chauffeDepuis: null,
});

/**
 * Le dernier relevé de chaque capteur : nom -> { temperature, humidite, le }.
 * Un capteur peut servir plusieurs pièces ; il n'est écouté qu'une fois.
 */
const mesures = new Map();

/** Sans relevé récent d'aucun capteur qui compte, on ne pilote pas à l'aveugle : radiateur coupé. */
const capteurVivant = (s) => s.temperature !== null;

function onReleve(nom, releve) {
  const precedent = mesures.get(nom) ?? {};
  mesures.set(nom, {
    temperature: releve.temperature ?? precedent.temperature,
    humidite: releve.humidite ?? precedent.humidite,
    le: new Date().toISOString(),
  });
  for (const s of state.values()) {
    if (capteursDe(s.piece).some((c) => c.nom === nom)) reguler(s);
  }
}

/** La température de la pièce, depuis ses capteurs vivants (thermostat.js) ; rend la mesure, ou null. */
function mesurer(s) {
  const m = mesurePiece(s.piece, mesures, Date.now(), config.sensorTimeout);
  s.temperature = m?.temperature ?? null;
  s.humidite = m?.humidite ?? null;
  if (m) s.releveLe = m.le;
  return m;
}

/** La fin de la coupure pour fenêtre ouverte, en ISO, ou null. */
const fenetreJusqua = (s) => (s.suivi.fenetre ? new Date(s.suivi.fenetre.jusqua).toISOString() : null);

/**
 * La consigne de la pièce : sa configuration, plus ce que le boîtier sait
 * seul, la fenêtre ouverte et la vitesse de chauffe apprise.
 */
function consigneDe(s) {
  return consigneEnVigueur(
    { ...s.piece, fenetre_jusqua: fenetreJusqua(s), vitesse_chauffe: local.vitesse(s.piece.uuid) },
    new Date(),
    s.temperature
  );
}

/**
 * Suit la fenêtre de la pièce (fenetre.js). Une coupure qui commence ou
 * finit part tout de suite à Scutti, par un échange, plutôt qu'au passage
 * suivant : c'est ce que la fiche de la pièce doit dire.
 */
function suivreLaFenetre(s, mesure) {
  const avant = s.suivi.fenetre;
  s.suivi = suivreFenetre(s.suivi, mesure, Date.now(), s.piece.coupure_fenetre !== false);
  if (Boolean(avant) === Boolean(s.suivi.fenetre)) return;
  console.log(s.suivi.fenetre
    ? `[${s.piece.nom}] chute brutale : fenêtre ouverte, chauffage coupé jusqu’à ${new Date(s.suivi.fenetre.jusqua).toLocaleTimeString('fr-FR', { timeZone: FUSEAU })}`
    : `[${s.piece.nom}] fenêtre refermée ou coupure échue : régulation normale`);
  echangerAvecScutti().catch((e) => console.warn('[scutti] échange après la fenêtre impossible :', e.message));
}

/**
 * Un allumage ouvre une période de chauffe ; l'extinction la mesure et, si
 * elle apprend quelque chose, met à jour la vitesse de la pièce (vitesse.js).
 */
function noterChauffe(s, allume) {
  const maintenant = Date.now();
  if (allume) {
    s.chauffeDepuis = { le: maintenant, temperature: s.temperature };
    return;
  }
  const interrompue = Boolean(s.suivi.fenetre) || !capteurVivant(s);
  const mesure = vitesseMesuree(s.chauffeDepuis, { le: maintenant, temperature: s.temperature }, interrompue);
  s.chauffeDepuis = null;
  if (mesure === null) return;
  const vitesse = apprendre(local.vitesse(s.piece.uuid), mesure);
  local.poserVitesse(s.piece.uuid, vitesse);
  console.log(`[${s.piece.nom}] chauffe mesurée : ${mesure.toFixed(2)} °C/h, vitesse apprise ${vitesse} °C/h`);
}

/** Les allumages et extinctions, envoyés à la seconde (basculements.js). */
const basculements = new Basculements();
let envoiBasculements = false;

async function envoyerBasculements() {
  if (envoiBasculements) return;
  const lot = basculements.aEnvoyer();
  if (!lot.length) return;
  envoiBasculements = true;
  try {
    if (await pushReleves(lot)) basculements.envoyes(lot.length);
  } finally {
    envoiBasculements = false;
  }
}

/** Toutes les prises de la pièce, dans le même état. */
function commander(piece, allume) {
  for (const prise of prisesDe(piece)) setPlug(prise, allume);
}

function reguler(s) {
  const vivant = capteurVivant(s);
  suivreLaFenetre(s, mesurer(s));
  const consigne = capteurVivant(s) ? consigneDe(s) : null;
  const chauffer = doitChauffer(consigne, s.temperature, s.chauffe, s.piece.hysteresis);
  if (vivant && !capteurVivant(s)) console.warn(`[${s.piece.nom}] capteurs muets → coupure de sécurité`);
  if (chauffer !== s.chauffe) {
    noterChauffe(s, chauffer);
    s.chauffe = chauffer;
    const n = prisesDe(s.piece).length;
    console.log(`[${s.piece.nom}] ${s.temperature} °C, consigne ${consigne ?? 'aucune'} → ${n > 1 ? `${n} prises` : 'radiateur'} ${chauffer ? 'ON' : 'OFF'}`);
  }
  piloter(s, consigne);
}

// ── La chauffe forcée (forcage.js) ──────────────────────────────────────────
//
// `s.chauffe` reste ce que veut la régulation, et la marge s'en sert ;
// `s.allumees` est ce que les prises font vraiment : celles du forçage, et
// toutes quand la régulation chauffe. C'est `s.allumees` qui part dans les
// relevés, pour que Scutti compte ce qui a vraiment consommé.

/** Au moins une prise de la pièce est allumée : ce que les relevés appellent « chauffe ». */
const allumee = (s) => (s.allumees ?? []).length > 0;

/**
 * Les prises de la pièce, d'après la régulation et le forçage (forcage.js,
 * `pilotage`). Un forçage arrêté parce que la pièce dépasse
 * TEMPERATURE_MAX_FORCAGE s'efface comme un « Arrêter » posé ici, et part à
 * Scutti. Les prises ne sont commandées que si quelque chose change, et
 * chaque fois un relevé part aussitôt, horodaté à la seconde.
 */
function piloter(s, consigne) {
  const champ = local.champsPiece(s.piece.uuid).forcage;
  const p = pilotage(s, champ);
  if (p.arreter) {
    local.poserPiece(s.piece.uuid, 'forcage', null);
    console.warn(`[${s.piece.nom}] ${s.temperature} °C, au-dessus de ${TEMPERATURE_MAX_FORCAGE} °C : chauffe forcée arrêtée`);
    echangerSansAttendre();
  }
  if (!p.commander) return;
  if (p.forceJusqua !== (s.forceJusqua ?? null)) {
    console.log(`[${s.piece.nom}] ${p.forcage ? resumeForcage(s.piece, p.forcage, FUSEAU) : 'chauffe forcée finie ou suspendue : régulation normale'}`);
  }
  s.allumees = p.allumees;
  s.forceJusqua = p.forceJusqua;
  for (const prise of prisesDe(s.piece)) setPlug(prise, p.allumees.includes(prise));
  basculements.noter({
    piece_uuid: s.piece.uuid,
    temperature: s.temperature,
    humidite: s.humidite,
    chauffe: allumee(s),
    consigne,
    mesure_le: new Date().toISOString(),
    prises_allumees: p.allumees,
  });
  envoyerBasculements();
}

/**
 * L'échange : ce qui a été réglé ici part, l'état d'après arbitrage revient.
 *
 * Il a lieu AVANT la lecture de la configuration : Scutti doit avoir reçu
 * les réglages locaux avant de dire ce qu'il faut chauffer, sans quoi le
 * boîtier recevrait l'ancienne valeur et la rejouerait.
 */
async function echangerAvecScutti() {
  const retour = await echanger({ ...local.pourEchange(), etats: etatsPourScutti() });
  dernierEchange = { le: new Date().toISOString(), ok: Boolean(retour) };
  if (retour) local.appliquerRetour(retour);
}

/**
 * Ce que le boîtier sait seul, et que Scutti montre : la coupure en cours
 * quand une fenêtre est ouverte, et la vitesse de chauffe apprise, d'où
 * Scutti tire la même avance que le boîtier. Un Scutti d'avant ignore le
 * champ (son schéma écarte ce qu'il ne connaît pas, sans refuser le corps).
 */
function etatsPourScutti() {
  return [...state.values()].map((s) => ({
    uuid: s.piece.uuid,
    fenetre_jusqua: fenetreJusqua(s),
    vitesse_chauffe: local.vitesse(s.piece.uuid),
  }));
}

/**
 * Un échange tout de suite, sans attendre le passage suivant : un forçage
 * posé ou arrêté ici doit se voir dans Scutti dans la seconde. Un échec
 * n'est pas une perte, le passage suivant le refera.
 */
function echangerSansAttendre() {
  echangerAvecScutti().catch((e) => console.warn('[scutti] échange impossible :', e.message));
}

/**
 * La pièce telle qu'elle doit être pilotée : la configuration de Scutti,
 * RECOUVERTE par l'état local.
 *
 * Le recouvrement est toujours juste : après un échange réussi, l'état
 * local EST celui de Scutti, puisqu'on y a rangé la réponse d'après
 * arbitrage ; pendant une coupure, il porte ce qui a été réglé ici, et
 * c'est précisément ce qu'on veut appliquer.
 */
function recouvrir(piece) {
  const champs = local.champsPiece(piece.uuid);
  return {
    ...piece,
    nom: valeur(champs, 'nom', piece.nom),
    mode: valeur(champs, 'mode', piece.mode),
    consigne_defaut: valeur(champs, 'consigne_defaut', piece.consigne_defaut),
    hysteresis: valeur(champs, 'hysteresis', piece.hysteresis),
    consigne_manuelle: valeur(champs, 'consigne_manuelle', piece.consigne_manuelle),
    manuel_jusqua: valeur(champs, 'manuel_jusqua', piece.manuel_jusqua),
    actif: valeur(champs, 'actif', true),
  };
}

function appliquer(brutes) {
  const pieces = brutes.map(recouvrir).filter((p) => p.actif !== false);
  // Les prises retirées, ajoutées ou passées d'une pièce à l'autre (thermostat.js).
  for (const [prise, allumee] of prisesAPoser(state, pieces)) setPlug(prise, allumee);

  const vues = new Set();
  for (const piece of pieces) {
    vues.add(piece.uuid);
    const existant = state.get(piece.uuid);
    if (existant) {
      existant.piece = piece;
      reguler(existant);
    } else {
      state.set(piece.uuid, pieceNeuve(piece));
    }
  }
  ecouter(pieces);
  // Une pièce qui n'est plus dans la configuration : ses prises sont déjà
  // coupées (ou reprises par une autre pièce) ; on l'oublie.
  for (const uuid of state.keys()) {
    if (!vues.has(uuid)) state.delete(uuid);
  }
}

/** Écoute les capteurs dont une pièce a besoin, et ceux-là seulement. */
function ecouter(pieces) {
  const utiles = new Set(pieces.flatMap((p) => capteursDe(p).map((c) => c.nom)));
  for (const nom of mesures.keys()) {
    if (!utiles.has(nom)) { unsubscribe(nom); mesures.delete(nom); }
  }
  for (const nom of utiles) {
    if (!mesures.has(nom)) mesures.set(nom, {});
    subscribe(nom, (r) => onReleve(nom, r));
  }
}

// ── Les appareils du réseau Zigbee ──────────────────────────────────────────
//
// Le bridge publie sa liste à chaque changement (appairage, départ,
// renommage), et chaque appareil qui parle dit sa batterie et sa date.
//
// Un changement du RÉSEAU (un appareil arrive, part, change de nom ou livre
// son modèle) part tout de suite : c'est ce qu'attend la personne qui vient
// d'appuyer sur le bouton de l'appareil, les yeux sur Scutti. Le reste, la
// batterie et la date, part au plus une fois toutes les cinq minutes.

/** nom Zigbee2MQTT -> { batterie, temperature, vuLe } */
const vus = new Map();
let inventaire = [];
let envoiAppareils = null;
let dernierEnvoi = 0;
/** La signature du réseau que Scutti a reçue, après un envoi RÉUSSI. */
let reseauEnvoye = null;
/**
 * Un envoi en vol, et s'il faut en refaire un derrière lui. Deux PUT de la
 * liste entière qui se croisent pourraient arriver dans le désordre, et
 * Scutti garderait la plus ancienne : on les met donc en file.
 */
let enVol = false;
let aRefaire = false;

async function envoyerAppareils() {
  clearTimeout(envoiAppareils);
  envoiAppareils = null;
  if (enVol) { aRefaire = true; return; }
  enVol = true;
  dernierEnvoi = Date.now();
  const appareils = construireAppareils(inventaire, vus);
  const recu = await putAppareils(appareils);
  if (recu) reseauEnvoye = signature(appareils);
  enVol = false;
  if (aRefaire) { aRefaire = false; planifierAppareils(); }
  // Scutti injoignable : on réessaie à la minute, sans attendre que le
  // réseau Zigbee change de nouveau.
  else if (!recu && !envoiAppareils) envoiAppareils = setTimeout(envoyerAppareils, config.pullInterval);
}

/**
 * Programme l'envoi : tout de suite si le réseau a changé depuis ce que
 * Scutti a reçu, au plancher sinon.
 */
function planifierAppareils() {
  if (signature(construireAppareils(inventaire, vus)) !== reseauEnvoye) {
    envoyerAppareils();
    return;
  }
  if (envoiAppareils) return;
  const attente = Math.max(0, config.appareilsInterval - (Date.now() - dernierEnvoi));
  envoiAppareils = setTimeout(envoyerAppareils, attente);
}

onInventaire((devices) => {
  inventaire = devices;
  planifierAppareils();
});

onVu((nom, payload) => {
  const precedent = vus.get(nom) ?? {};
  const batterie = typeof payload.battery === 'number' ? payload.battery : precedent.batterie;
  const temperature = typeof payload.temperature === 'number' ? payload.temperature : precedent.temperature;
  vus.set(nom, { batterie, temperature, vuLe: new Date().toISOString() });
  // La date et la batterie partent elles aussi, au plancher : sans cela,
  // elles n'arrivaient à Scutti qu'avec un changement du réseau, et un
  // thermomètre qui parlait toutes les cinq minutes y était dit « muet
  // depuis 2 h » dès que plus rien n'était appairé ni renommé.
  planifierAppareils();
  reglerSiBesoin(nom);
});

// ── Des capteurs qui parlent plus souvent (rapports.js) ─────────────────────

/** nom -> date du dernier essai ; les capteurs déjà réglés depuis le démarrage. */
const essaisDeReglage = new Map();
const capteursRegles = new Set();
let fileDeReglages = Promise.resolve();

// Zigbee2MQTT 2 a renommé la requête ; le boîtier ne sait pas quelle version
// tourne dans le conteneur. Un bridge qui ne connaît pas un sujet ne répond
// pas : on essaie le nom d'aujourd'hui, puis celui d'avant, et on retient
// celui qui a répondu.
const SUJETS_REGLAGE = ['device/reporting/configure', 'device/configure_reporting'];
let sujetReglage = null;

async function demanderReglage(reglage) {
  let derniere;
  for (const sujet of sujetReglage ? [sujetReglage] : SUJETS_REGLAGE) {
    try {
      await requeteBridge(sujet, reglage, 30_000);
      sujetReglage = sujet;
      return;
    } catch (e) {
      derniere = e;
      // Une réponse, même un refus, dit que le sujet existe.
      if (!e.message.includes('n’a pas répondu')) { sujetReglage = sujet; throw e; }
    }
  }
  throw derniere;
}

/**
 * Un capteur dont une pièce se sert vient de parler : il est éveillé, c'est
 * le moment de lui demander d'envoyer plus souvent, s'il le faut.
 */
function reglerSiBesoin(nom) {
  if (!mesures.has(nom) || capteursRegles.has(nom)) return;
  const manquants = reglagesManquants(inventaire.find((a) => a.friendly_name === nom));
  if (!manquants.length) { capteursRegles.add(nom); return; }
  if (Date.now() - (essaisDeReglage.get(nom) ?? 0) < ENTRE_DEUX_ESSAIS) return;
  essaisDeReglage.set(nom, Date.now());
  fileDeReglages = fileDeReglages
    .then(async () => {
      for (const reglage of manquants) await demanderReglage(reglage);
      capteursRegles.add(nom);
      console.log(`[capteurs] ${nom} : mesure envoyée dès 0,25 °C (3 % d’humidité) d’écart, et au moins toutes les 5 min`);
    })
    .catch((e) => console.warn(`[capteurs] ${nom} pas encore réglé (${e.message}) : nouvel essai à un prochain réveil`));
}

// ── Les commandes venues de Scutti ──────────────────────────────────────────

/** Ce que chaque type de commande demande au bridge. */
async function executer(commande) {
  if (commande.type === 'permit_join') {
    // Une durée nulle FERME la fenêtre : c'est ainsi que Scutti arrête la
    // recherche. `|| 240` en aurait fait quatre minutes de plus.
    const time = Number(commande.charge?.time);
    const duree = Number.isFinite(time) && time >= 0 ? time : 240;
    appairageJusqua = Date.now() + duree * 1000;
    return requeteBridge('permit_join', { time: duree });
  }
  if (commande.type === 'rename') {
    return requeteBridge('device/rename', { from: commande.charge?.de, to: commande.charge?.vers });
  }
  throw new Error(`type de commande inconnu : ${commande.type}`);
}

async function traiter(commandes) {
  for (const commande of commandes) {
    try {
      await executer(commande);
      await ackCommande(commande.id, null);
      console.log(`[commande] ${commande.type} exécutée`);
    } catch (e) {
      await ackCommande(commande.id, e.message);
      console.warn(`[commande] ${commande.type} refusée :`, e.message);
    }
  }
}

/**
 * Un passage : l'échange, la configuration, puis les commandes en attente.
 * Le prochain
 * passage est programmé ici, rapproché tant que Scutti dit qu'il reste
 * quelque chose à faire.
 */
async function pull() {
  await echangerAvecScutti();
  const configuration = await fetchConfiguration();
  if (configuration?.passerelle?.nom) nomBoitier = configuration.passerelle.nom;
  if (configuration) verificateurLocal = configuration.acces_local?.verificateur ?? null;
  if (configuration) appliquer(configuration.pieces);
  if (configuration?.commandes_en_attente) await traiter(await fetchCommandes());
  // Après une commande exécutée, on revient vite : le renommage change
  // l'inventaire, et l'appairage fait apparaître un appareil.
  const vite = Boolean(configuration?.commandes_en_attente);
  setTimeout(pull, vite ? config.pullIntervalRapide : config.pullInterval);
}

function push() {
  const releves = [...state.values()]
    .filter((s) => s.releveLe && capteurVivant(s))
    .map((s) => ({
      piece_uuid: s.piece.uuid,
      temperature: s.temperature,
      humidite: s.humidite,
      chauffe: allumee(s),
      consigne: capteurVivant(s) ? consigneDe(s) : null,
      mesure_le: s.releveLe,
      // Ce qui a vraiment consommé : Scutti compte chaque radiateur au
      // prorata de ses prises allumées. Un Scutti d'avant écarte le champ.
      prises_allumees: s.allumees ?? [],
    }));
  if (releves.length) pushReleves(releves);
  // Ceux qu'une coupure a retenus repartent avec le relevé périodique.
  envoyerBasculements();
}

/**
 * Ce qu'un réglage local a le droit de valoir, avec les MÊMES bornes que le
 * contrat d'échange. Une valeur hors bornes serait refusée par Scutti, et
 * refusée pour tout le corps : un seul mauvais réglage rendrait le boîtier
 * muet jusqu'à ce qu'on efface son état. On refuse donc ici, où la personne
 * voit la page.
 *
 * `undefined` veut dire « rien à poser ».
 */
function borner(champ, saisie) {
  if (champ === 'mode') return ['off', 'auto', 'manuel'].includes(saisie) ? saisie : undefined;
  if (champ === 'nom') {
    const nom = String(saisie ?? '').trim().slice(0, 80);
    return nom || undefined;
  }
  const bornes = { consigne_defaut: [5, 30], consigne_manuelle: [5, 30], hysteresis: [0.2, 3] }[champ];
  if (!bornes) return undefined;
  const nombre = Number(saisie);
  if (!Number.isFinite(nombre) || nombre < bornes[0] || nombre > bornes[1]) return undefined;
  return nombre;
}

// ── Ce que l'interface locale lit et déclenche ──────────────────────────────
//
// Elle ne décide rien : elle montre l'état du boîtier et lui demande des
// gestes. Tout ce qu'elle écrit passe par l'état local, donc par une date,
// donc par l'arbitrage.

/** Ce que la liste du boîtier dit sous le nom de la pièce. */
function noteDe(s) {
  if (s.suivi.fenetre) {
    const fin = new Date(s.suivi.fenetre.jusqua).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: FUSEAU });
    return `Fenêtre ouverte, chauffage coupé jusqu’à ${fin}`;
  }
  return s.releveLe ? `Mesuré ${new Date(s.releveLe).toLocaleTimeString('fr-FR')}` : 'Aucune mesure';
}

/** « Chauffe forcée jusqu'à 15 h 30, 2 radiateurs », ou null. */
function forcageDe(s) {
  const forcage = forcageEnVigueur(local.champsPiece(s.piece.uuid).forcage, s.piece);
  if (!forcage) return null;
  return { resume: resumeForcage(s.piece, forcage, FUSEAU), suspendu: !capteurVivant(s) };
}

const contexte = {
  get nom() { return nomBoitier; },
  scuttiUrl: config.scutti.url,
  etatEchange: () => dernierEchange,
  appairageRestant: () => Math.max(0, Math.round((appairageJusqua - Date.now()) / 1000)),

  pieces: () => [...state.values()].map((s) => ({
    uuid: s.piece.uuid,
    nom: s.piece.nom,
    mode: s.piece.mode,
    consigne: capteurVivant(s) ? consigneDe(s) : null,
    temperature: s.temperature,
    chauffe: allumee(s),
    note: noteDe(s),
    forcage: forcageDe(s),
  })),

  /** Une pièce et ses radiateurs, pour la page qui force la chauffe ; null si inconnue. */
  piece(uuid) {
    const s = state.get(uuid);
    if (!s) return null;
    return { uuid, nom: s.piece.nom, radiateurs: radiateursDe(s.piece), forcage: forcageDe(s) };
  },

  /**
   * Forcer la chauffe : rangé dans l'état local, avec sa date, comme tout
   * réglage d'ici. Une demande hors bornes ne se pose pas (forcage.js).
   */
  async forcer(uuid, rangs, minutes) {
    const s = state.get(uuid);
    const valeurPosee = s ? nouveauForcage(s.piece, rangs, minutes) : null;
    if (!valeurPosee) return;
    local.poserPiece(uuid, 'forcage', valeurPosee);
    reguler(s);
    echangerSansAttendre();
  },

  async arreterForcage(uuid) {
    const s = state.get(uuid);
    if (!s) return;
    local.poserPiece(uuid, 'forcage', null);
    reguler(s);
    echangerSansAttendre();
  },

  appareils: () => construireAppareils(inventaire, vus).map((a) => ({
    ...a,
    libelle: valeur(local.champsAppareil(a.ieee), 'libelle', null),
  })),

  async reglerPiece(uuid, champ, valeurSaisie) {
    const posee = borner(champ, valeurSaisie);
    if (posee === undefined) return;
    local.poserPiece(uuid, champ, posee);
    const s = state.get(uuid);
    if (s) { s.piece = recouvrir(s.piece); reguler(s); }
  },

  async nommerAppareil(ieee, libelle) {
    local.poserAppareil(ieee, 'libelle', (libelle ?? '').trim() || null);
  },

  async appairer() {
    await requeteBridge('permit_join', { time: 240 });
    appairageJusqua = Date.now() + 240_000;
  },

  echanger: echangerAvecScutti,
};

if (config.localPort === 0) {
  console.log('[web] interface locale coupée (LOCAL_PORT=0)');
} else if (!config.tls) {
  console.warn('[web] aucun certificat lisible : interface locale coupée (relancer install.sh)');
} else {
  console.log(`[web] empreinte du certificat : ${config.tls.empreinte}`);
  demarrerInterfaceLocale(contexte, config.localPort, { tls: config.tls, acces: new Acces(() => verificateurLocal) });
}

// Réévaluation périodique : les règles horaires changent sans nouveau relevé.
setInterval(() => state.forEach(reguler), 60_000);
setInterval(push, config.pushInterval);

// Arrêt propre : tout couper avant de quitter.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    state.forEach((s) => commander(s.piece, false));
    setTimeout(() => process.exit(0), 500);
  });
}

await pull();
console.log(`[gateway] ${state.size} pièce(s) pilotée(s)`);
