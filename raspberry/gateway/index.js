import config from './config.js';
import { subscribe, unsubscribe, setPlug, onInventaire, onVu, requeteBridge } from './mqtt.js';
import { consigneEnVigueur, doitChauffer } from './thermostat.js';
import { fetchConfiguration, pushReleves, fetchCommandes, ackCommande, putAppareils, echanger } from './scutti.js';
import { construireAppareils, signature } from './devices.js';
import EtatLocal from './local.js';
import { valeur } from './fusion.js';
import { demarrerInterfaceLocale } from './web.js';

/** Ce qui a été réglé ICI, avec la date de chaque champ (local.js). */
const local = new EtatLocal(config.etatFile);
let dernierEchange = { le: null, ok: false };
let appairageJusqua = 0;
/** Le nom du boîtier vient de Scutti : il est posé à la déclaration, là-bas. */
let nomBoitier = 'Boîtier';

/** pieceUuid -> { piece, temperature, humidite, chauffe, releveLe } */
const state = new Map();

/** Sans relevé récent, on ne pilote pas à l'aveugle : radiateur coupé. */
const capteurVivant = (s) => s.releveLe && Date.now() - Date.parse(s.releveLe) < config.sensorTimeout;

function onReleve(uuid, releve) {
  const s = state.get(uuid);
  if (!s) return;
  if (releve.temperature !== undefined) s.temperature = releve.temperature;
  if (releve.humidite !== undefined) s.humidite = releve.humidite;
  s.releveLe = new Date().toISOString();
  reguler(s);
}

function reguler(s) {
  const consigne = capteurVivant(s) ? consigneEnVigueur(s.piece) : null;
  const chauffer = doitChauffer(consigne, s.temperature, s.chauffe, s.piece.hysteresis);
  if (!capteurVivant(s) && s.chauffe) console.warn(`[${s.piece.nom}] capteur muet → coupure de sécurité`);
  if (chauffer !== s.chauffe) {
    s.chauffe = chauffer;
    setPlug(s.piece.prise, chauffer);
    console.log(`[${s.piece.nom}] ${s.temperature} °C, consigne ${consigne ?? 'aucune'} → radiateur ${chauffer ? 'ON' : 'OFF'}`);
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
  const vues = new Set();
  for (const piece of pieces) {
    vues.add(piece.uuid);
    const existant = state.get(piece.uuid);
    if (existant) {
      if (existant.piece.capteur !== piece.capteur) {
        unsubscribe(existant.piece.capteur);
        subscribe(piece.capteur, (r) => onReleve(piece.uuid, r));
      }
      if (existant.piece.prise !== piece.prise) setPlug(existant.piece.prise, false);
      existant.piece = piece;
      reguler(existant);
    } else {
      state.set(piece.uuid, { piece, temperature: null, humidite: null, chauffe: false, releveLe: null });
      subscribe(piece.capteur, (r) => onReleve(piece.uuid, r));
      setPlug(piece.prise, false);
    }
  }
  // Une pièce qui n'est plus dans la configuration (supprimée, désactivée,
  // espace retiré) : on la coupe et on l'oublie.
  for (const [uuid, s] of state) {
    if (vues.has(uuid)) continue;
    unsubscribe(s.piece.capteur);
    setPlug(s.piece.prise, false);
    state.delete(uuid);
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

/** nom Zigbee2MQTT -> { batterie, vuLe } */
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
  vus.set(nom, { batterie, vuLe: new Date().toISOString() });
});

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
  if (configuration) appliquer(configuration.pieces);
  if (configuration?.commandes_en_attente) await traiter(await fetchCommandes());
  // Après une commande exécutée, on revient vite : le renommage change
  // l'inventaire, et l'appairage fait apparaître un appareil.
  const vite = Boolean(configuration?.commandes_en_attente);
  setTimeout(pull, vite ? config.pullIntervalRapide : config.pullInterval);
}

function push() {
  const releves = [...state.values()]
    .filter((s) => s.releveLe)
    .map((s) => ({
      piece_uuid: s.piece.uuid,
      temperature: s.temperature,
      humidite: s.humidite,
      chauffe: s.chauffe,
      consigne: capteurVivant(s) ? consigneEnVigueur(s.piece) : null,
      mesure_le: s.releveLe,
    }));
  if (releves.length) pushReleves(releves);
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

demarrerInterfaceLocale(contexte, config.localPort);

// Réévaluation périodique : les règles horaires changent sans nouveau relevé.
setInterval(() => state.forEach(reguler), 60_000);
setInterval(push, config.pushInterval);

// Arrêt propre : tout couper avant de quitter.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    state.forEach((s) => setPlug(s.piece.prise, false));
    setTimeout(() => process.exit(0), 500);
  });
}

await pull();
console.log(`[gateway] ${state.size} pièce(s) pilotée(s)`);
