import config from './config.js';
import { subscribe, unsubscribe, setPlug, onInventaire, onVu, requeteBridge } from './mqtt.js';
import { consigneEnVigueur, doitChauffer } from './thermostat.js';
import { fetchConfiguration, pushReleves, fetchCommandes, ackCommande, putAppareils } from './scutti.js';
import { construireAppareils } from './devices.js';

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

function appliquer(pieces) {
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
// renommage), et chaque appareil qui parle dit sa batterie et sa date. On
// remonte à Scutti à chaque changement, et au plus une fois toutes les cinq
// minutes : sans ce plancher, un réseau bavard enverrait la liste entière à
// chaque relevé.

/** nom Zigbee2MQTT -> { batterie, vuLe } */
const vus = new Map();
let inventaire = [];
let envoiAppareils = null;
let dernierEnvoi = 0;

function envoyerAppareils() {
  envoiAppareils = null;
  dernierEnvoi = Date.now();
  putAppareils(construireAppareils(inventaire, vus));
}

/** Programme l'envoi, en respectant le plancher entre deux. */
function planifierAppareils() {
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
    return requeteBridge('permit_join', { time: Number(commande.charge?.time) || 240 });
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
 * Un passage : la configuration, puis les commandes en attente. Le prochain
 * passage est programmé ici, rapproché tant que Scutti dit qu'il reste
 * quelque chose à faire.
 */
async function pull() {
  const configuration = await fetchConfiguration();
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
