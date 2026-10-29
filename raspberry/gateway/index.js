import config from './config.js';
import { subscribe, unsubscribe, setPlug, onInventaire, onVu, requeteBridge } from './mqtt.js';
import { consigneEnVigueur, doitChauffer, capteursDe, prisesDe, prisesAPoser, mesurePiece } from './thermostat.js';
import { fetchConfiguration, pushReleves, fetchCommandes, ackCommande, putAppareils, echanger } from './scutti.js';
import { construireAppareils, signature } from './devices.js';
import EtatLocal from './local.js';
import { valeur } from './fusion.js';
import { demarrerInterfaceLocale } from './web.js';
import Acces from './acces.js';
import Basculements from './basculements.js';
import { reglagesManquants, ENTRE_DEUX_ESSAIS } from './rapports.js';

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

/** pieceUuid -> { piece, temperature, humidite, chauffe, releveLe } */
const state = new Map();

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

/** La température de la pièce, depuis ses capteurs vivants (thermostat.js). */
function mesurer(s) {
  const m = mesurePiece(s.piece, mesures, Date.now(), config.sensorTimeout);
  s.temperature = m?.temperature ?? null;
  s.humidite = m?.humidite ?? null;
  if (m) s.releveLe = m.le;
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
  mesurer(s);
  const consigne = capteurVivant(s) ? consigneEnVigueur(s.piece) : null;
  const chauffer = doitChauffer(consigne, s.temperature, s.chauffe, s.piece.hysteresis);
  if (vivant && !capteurVivant(s)) console.warn(`[${s.piece.nom}] capteurs muets → coupure de sécurité`);
  if (chauffer !== s.chauffe) {
    s.chauffe = chauffer;
    commander(s.piece, chauffer);
    basculements.noter({
      piece_uuid: s.piece.uuid,
      temperature: s.temperature,
      humidite: s.humidite,
      chauffe: chauffer,
      consigne,
      mesure_le: new Date().toISOString(),
    });
    envoyerBasculements();
    const n = prisesDe(s.piece).length;
    console.log(`[${s.piece.nom}] ${s.temperature} °C, consigne ${consigne ?? 'aucune'} → ${n > 1 ? `${n} prises` : 'radiateur'} ${chauffer ? 'ON' : 'OFF'}`);
  }
}

/**
 * L'échange : ce qui a été réglé ici part, l'état d'après arbitrage revient.
 *
 * Il a lieu AVANT la lecture de la configuration : Scutti doit avoir reçu
 * les réglages locaux avant de dire ce qu'il faut chauffer, sans quoi le
 * boîtier recevrait l'ancienne valeur et la rejouerait.
 */
async function echangerAvecScutti() {
  const retour = await echanger(local.pourEchange());
  dernierEchange = { le: new Date().toISOString(), ok: Boolean(retour) };
  if (retour) local.appliquerRetour(retour);
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
      state.set(piece.uuid, { piece, temperature: null, humidite: null, chauffe: false, releveLe: null });
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
      chauffe: s.chauffe,
      consigne: capteurVivant(s) ? consigneEnVigueur(s.piece) : null,
      mesure_le: s.releveLe,
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

const contexte = {
  get nom() { return nomBoitier; },
  scuttiUrl: config.scutti.url,
  etatEchange: () => dernierEchange,
  appairageRestant: () => Math.max(0, Math.round((appairageJusqua - Date.now()) / 1000)),

  pieces: () => [...state.values()].map((s) => ({
    uuid: s.piece.uuid,
    nom: s.piece.nom,
    mode: s.piece.mode,
    consigne: capteurVivant(s) ? consigneEnVigueur(s.piece) : null,
    temperature: s.temperature,
    chauffe: s.chauffe,
    note: s.releveLe ? `Mesuré ${new Date(s.releveLe).toLocaleTimeString('fr-FR')}` : 'Aucune mesure',
  })),

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
