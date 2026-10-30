import mqtt from 'mqtt';
import config from './config.js';
import { instant } from './horloge.js';

const { url, username, password, baseTopic } = config.mqtt;
const client = mqtt.connect(url, { username, password });
const listeners = new Map(); // deviceName -> fn(reading)
const vus = []; // fn(deviceName, payload) : tout ce qui parle, pour la batterie et la date
const inventaires = []; // fn(devices) : la liste du bridge
const attentes = new Map(); // sujet de requête -> { repondre }

/**
 * Où en est la liaison (sante.js) : Mosquitto répond-il, et Zigbee2MQTT
 * derrière lui ? `zigbee` vaut null tant que le bridge n'a rien dit.
 * `…Depuis` : le dernier changement, sur le chronomètre (horloge.js).
 */
const etat = { mqtt: false, mqttDepuis: instant(), zigbee: null, zigbeeDepuis: instant(), zigbeeVersion: null };
const changements = [];

function poser(champ, valeur) {
  if (etat[champ] === valeur) return;
  etat[champ] = valeur;
  etat[`${champ}Depuis`] = instant();
  changements.forEach((fn) => fn());
}

client.on('connect', () => {
  console.log('[mqtt] connecté');
  poser('mqtt', true);
  // L'état du bridge est RETENU : il arrive dès l'abonnement. Hors ligne
  // veut dire que Zigbee2MQTT est tombé (Mosquitto le dit à sa place).
  client.subscribe(`${baseTopic}/bridge/state`);
  client.subscribe(`${baseTopic}/bridge/info`);
  // La liste des appareils est RETENUE par le bridge : on la reçoit dès
  // l'abonnement, puis à chaque changement du réseau (appairage, départ,
  // renommage). C'est elle qui déclenche la remontée vers Scutti.
  client.subscribe(`${baseTopic}/bridge/devices`);
  client.subscribe(`${baseTopic}/bridge/response/#`);
});
client.on('error', (e) => console.error('[mqtt]', e.message));
client.on('close', () => poser('mqtt', false));

/** Ne laisse passer que des nombres plausibles ; tout le reste est ignoré. */
function sanitize(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  const inRange = (v, min, max) => (typeof v === 'number' && v >= min && v <= max ? v : undefined);
  const reading = {
    temperature: inRange(payload.temperature, -30, 60),
    humidite: inRange(payload.humidity, 0, 100),
  };
  return reading.temperature === undefined && reading.humidite === undefined ? null : reading;
}

client.on('message', (topic, buffer) => {
  const name = topic.slice(baseTopic.length + 1);

  // Zigbee2MQTT 1 écrit `online` en clair, Zigbee2MQTT 2 `{"state":"online"}`.
  if (name === 'bridge/state') {
    const texte = buffer.toString();
    let brut = texte;
    try { brut = JSON.parse(texte)?.state ?? texte; } catch { /* en clair */ }
    poser('zigbee', brut === 'online');
    return;
  }

  let payload;
  try { payload = JSON.parse(buffer.toString()); } catch { payload = null; }

  if (name === 'bridge/info') {
    if (typeof payload?.version === 'string') etat.zigbeeVersion = payload.version.slice(0, 40);
    return;
  }

  if (name === 'bridge/devices') {
    if (Array.isArray(payload)) inventaires.forEach((fn) => fn(payload));
    return;
  }

  // La réponse d'une requête au bridge : elle arrive sur le sujet demandé,
  // et `status` vaut « ok » ou « error ».
  if (name.startsWith('bridge/response/')) {
    attentes.get(name.slice('bridge/response/'.length))?.repondre(payload);
    return;
  }

  if (name.startsWith('bridge/') || name.endsWith('/set')) return;

  // Tout ce qu'un appareil publie dit au moins qu'il est vivant : la date et
  // la batterie en viennent, et elles ne sont pas dans `bridge/devices`.
  if (payload) vus.forEach((fn) => fn(name, payload));

  const fn = listeners.get(name);
  if (!fn) return;
  const reading = sanitize(payload);
  if (reading) fn(reading);
  else console.warn('[mqtt] relevé invalide ignoré sur', topic);
});

export function subscribe(deviceName, fn) {
  if (listeners.has(deviceName)) return;
  listeners.set(deviceName, fn);
  client.subscribe(`${baseTopic}/${deviceName}`);
}

export function unsubscribe(deviceName) {
  listeners.delete(deviceName);
  client.unsubscribe(`${baseTopic}/${deviceName}`);
}

export function setPlug(deviceName, on) {
  client.publish(`${baseTopic}/${deviceName}/set`, JSON.stringify({ state: on ? 'ON' : 'OFF' }));
}

/** À chaque changement du réseau Zigbee : la liste entière des appareils. */
export function onInventaire(fn) {
  inventaires.push(fn);
}

/** À chaque message d'un appareil : de quoi tenir sa batterie et sa date. */
export function onVu(fn) {
  vus.push(fn);
}

/**
 * Une requête au bridge, et sa réponse.
 *
 * Zigbee2MQTT répond sur `bridge/response/<sujet>`, SANS identifiant de
 * corrélation : deux requêtes du même sujet en vol se mélangeraient. On n'en
 * laisse donc qu'une à la fois par sujet, et on refuse la suivante plutôt
 * que de lui rendre la réponse de l'autre. Les commandes arrivent en file et
 * s'exécutent l'une après l'autre, donc le cas ne se présente pas.
 */
export function requeteBridge(sujet, payload, delai = 15_000) {
  if (attentes.has(sujet)) return Promise.reject(new Error(`requête ${sujet} déjà en cours`));
  return new Promise((resolve, reject) => {
    const minuterie = setTimeout(() => {
      attentes.delete(sujet);
      reject(new Error(`le boîtier n’a pas répondu (${sujet})`));
    }, delai);

    attentes.set(sujet, {
      repondre(reponse) {
        clearTimeout(minuterie);
        attentes.delete(sujet);
        if (reponse?.status === 'error') reject(new Error(reponse.error ?? 'refusé par le boîtier'));
        else resolve(reponse?.data ?? {});
      },
    });

    client.publish(`${baseTopic}/bridge/request/${sujet}`, JSON.stringify(payload));
  });
}

/** Où en est la liaison avec Mosquitto et Zigbee2MQTT (une copie). */
export function liaison() {
  return { ...etat };
}

/** À chaque fois que Mosquitto ou Zigbee2MQTT tombe ou revient. */
export function onLiaison(fn) {
  changements.push(fn);
}
