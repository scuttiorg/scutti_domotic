import config from './config.js';
import { subscribe, unsubscribe, setPlug } from './mqtt.js';
import { shouldHeat, currentSetpoint } from './thermostat.js';
import { fetchRooms, pushReadings } from './scuti.js';

/** roomId -> { room, temperature, humidity, heating, updatedAt } */
const state = new Map();

function onReading(roomId, payload) {
  const s = state.get(roomId);
  if (!s) return;
  if (payload.temperature !== undefined) s.temperature = payload.temperature;
  if (payload.humidity !== undefined) s.humidity = payload.humidity;
  s.updatedAt = new Date().toISOString();
  regulate(s);
}

/** Sans relevé récent, on ne pilote pas à l'aveugle : radiateur coupé. */
const sensorAlive = (s) => s.updatedAt && Date.now() - Date.parse(s.updatedAt) < config.sensorTimeout;

function regulate(s) {
  const heat = sensorAlive(s) && shouldHeat(s.room, s.temperature, s.heating);
  if (!sensorAlive(s) && s.heating) console.warn(`[${s.room.name}] capteur muet → coupure de sécurité`);
  if (heat !== s.heating) {
    s.heating = heat;
    setPlug(s.room.plug_name, heat);
    console.log(`[${s.room.name}] ${s.temperature}°C → radiateur ${heat ? 'ON' : 'OFF'}`);
  }
}

function applyRooms(rooms) {
  const seen = new Set();
  for (const room of rooms) {
    seen.add(room.id);
    const existing = state.get(room.id);
    if (existing) {
      if (existing.room.sensor_name !== room.sensor_name) {
        unsubscribe(existing.room.sensor_name);
        subscribe(room.sensor_name, (p) => onReading(room.id, p));
      }
      existing.room = room;
      regulate(existing);
    } else {
      state.set(room.id, { room, temperature: null, humidity: null, heating: false, updatedAt: null });
      subscribe(room.sensor_name, (p) => onReading(room.id, p));
      setPlug(room.plug_name, false);
    }
  }
  for (const [id, s] of state) {
    if (seen.has(id)) continue;
    unsubscribe(s.room.sensor_name);
    setPlug(s.room.plug_name, false);
    state.delete(id);
  }
}

async function pull() {
  const rooms = await fetchRooms();
  if (rooms) applyRooms(rooms);
}

function push() {
  const readings = [...state.values()]
    .filter((s) => s.updatedAt)
    .map((s) => ({
      room_id: s.room.id,
      temperature: s.temperature,
      humidity: s.humidity,
      heating: s.heating,
      setpoint: currentSetpoint(s.room),
      measured_at: s.updatedAt,
    }));
  if (readings.length) pushReadings(readings);
}

// Réévaluation périodique : les règles horaires changent sans nouveau relevé.
setInterval(() => state.forEach(regulate), 60_000);
setInterval(pull, config.pullInterval);
setInterval(push, config.pushInterval);

// Arrêt propre : tout couper avant de quitter.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    state.forEach((s) => setPlug(s.room.plug_name, false));
    setTimeout(() => process.exit(0), 500);
  });
}

await pull();
console.log(`[gateway] ${state.size} pièce(s) pilotée(s)`);
