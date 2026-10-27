import mqtt from 'mqtt';
import config from './config.js';

const { url, username, password, baseTopic } = config.mqtt;
const client = mqtt.connect(url, { username, password });
const listeners = new Map(); // deviceName -> fn(reading)

client.on('connect', () => console.log('[mqtt] connecté'));
client.on('error', (e) => console.error('[mqtt]', e.message));

/** Ne laisse passer que des nombres plausibles ; tout le reste est ignoré. */
function sanitize(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  const inRange = (v, min, max) => (typeof v === 'number' && v >= min && v <= max ? v : undefined);
  const reading = {
    temperature: inRange(payload.temperature, -30, 60),
    humidity: inRange(payload.humidity, 0, 100),
  };
  return reading.temperature === undefined && reading.humidity === undefined ? null : reading;
}

client.on('message', (topic, buffer) => {
  const name = topic.slice(baseTopic.length + 1);
  const fn = listeners.get(name);
  if (!fn) return;
  let reading;
  try { reading = sanitize(JSON.parse(buffer.toString())); }
  catch { reading = null; }
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
