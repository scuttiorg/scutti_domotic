import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Agent } from 'undici';
import config from './config.js';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.scuti.token}`,
};

// Dispatcher dédié : TLS vérifié, CA interne possible, pas de redirection suivie.
const dispatcher = new Agent({ connect: { ca: config.scuti.ca, rejectUnauthorized: true } });

async function call(method, path, body) {
  const res = await fetch(`${config.scuti.url}/api/heating/gateway${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    dispatcher,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/** Récupère les pièces du site (avec règles et mode). Cache local en cas de panne réseau. */
export async function fetchRooms() {
  try {
    const rooms = await call('GET', '/config');
    writeFileSync(config.cacheFile, JSON.stringify(rooms), { mode: 0o600 });
    return rooms;
  } catch (e) {
    console.warn('[scuti] config injoignable :', e.message);
    if (existsSync(config.cacheFile)) return JSON.parse(readFileSync(config.cacheFile, 'utf8'));
    return null;
  }
}

/** Envoie les relevés et l'état courant de chaque pièce. */
export async function pushReadings(readings) {
  try { await call('POST', '/readings', { readings }); }
  catch (e) { console.warn('[scuti] push échoué :', e.message); }
}
