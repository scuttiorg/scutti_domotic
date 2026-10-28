import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const required = (key) => {
  if (!process.env[key]) throw new Error(`Variable manquante : ${key}`);
  return process.env[key];
};
const seconds = (key, def) => Number(process.env[key] ?? def) * 1000;

const scuttiUrl = required('SCUTTI_URL').replace(/\/$/, '');
if (!scuttiUrl.startsWith('https://')) throw new Error('SCUTTI_URL doit être en https://');

export default {
  mqtt: {
    url: process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883',
    username: required('MQTT_USER'),
    password: required('MQTT_PASSWORD'),
    baseTopic: process.env.MQTT_BASE_TOPIC ?? 'zigbee2mqtt',
  },
  scutti: {
    url: scuttiUrl,
    token: required('SCUTTI_TOKEN'),
    ca: process.env.SCUTTI_CA ? readFileSync(process.env.SCUTTI_CA) : undefined,
  },
  pushInterval: seconds('PUSH_INTERVAL', 300),
  pullInterval: seconds('PULL_INTERVAL', 60),
  // Tant qu'une commande attend, on revient vite : ouvrir l'appairage depuis
  // Scutti ne doit pas demander d'attendre une minute devant l'appareil.
  pullIntervalRapide: seconds('PULL_INTERVAL_RAPIDE', 10),
  // Le plancher entre deux envois de la batterie et de la date de dernière
  // vue des appareils. Un changement du réseau (arrivée, départ, nom,
  // modèle) n'attend pas : il part tout de suite.
  appareilsInterval: seconds('APPAREILS_INTERVAL', 300),
  sensorTimeout: seconds('SENSOR_TIMEOUT', 1200),
  cacheFile: 'config.cache.json',
  // L'état local : ce qui a été réglé sur le boîtier, avec la date de chaque
  // champ. Il survit au redémarrage, sinon un réglage fait pendant une
  // coupure serait perdu sans rien dire.
  // STATE_DIRECTORY est posé par systemd (`StateDirectory=`) : le service
  // tourne avec ProtectSystem=strict, et c'est le seul dossier où il a le
  // droit d'écrire. Hors systemd (développement), le dossier courant.
  etatFile: join(process.env.STATE_DIRECTORY ?? '.', 'local.json'),
  // L'interface locale, servie sur le réseau du bâtiment. Le boîtier
  // n'ouvre toujours aucun port vers l'extérieur : c'est lui qui appelle.
  localPort: Number(process.env.LOCAL_PORT ?? 8080),
};
