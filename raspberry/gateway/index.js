import config from './config.js';
import { subscribe, unsubscribe, setPlug } from './mqtt.js';
import { consigneEnVigueur, doitChauffer } from './thermostat.js';
import { fetchConfiguration, pushReleves } from './scutti.js';

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

async function pull() {
  const configuration = await fetchConfiguration();
  if (configuration) appliquer(configuration.pieces);
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
setInterval(pull, config.pullInterval);
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
