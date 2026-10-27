import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Agent } from 'undici';
import config from './config.js';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.scutti.token}`,
};

// Dispatcher dédié : TLS vérifié, CA interne possible, pas de redirection suivie.
const dispatcher = new Agent({ connect: { ca: config.scutti.ca, rejectUnauthorized: true } });

async function call(method, path, body) {
  const res = await fetch(`${config.scutti.url}/api/public/domotique/passerelle${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    dispatcher,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  const json = await res.json();
  return json.data;
}

/** La configuration de la passerelle (pièces de tous les espaces admis, avec règles et mode). Cache local en cas de panne réseau. */
export async function fetchConfiguration() {
  try {
    const configuration = await call('GET', '/configuration');
    writeFileSync(config.cacheFile, JSON.stringify(configuration), { mode: 0o600 });
    return configuration;
  } catch (e) {
    console.warn('[scutti] configuration injoignable :', e.message);
    if (existsSync(config.cacheFile)) return JSON.parse(readFileSync(config.cacheFile, 'utf8'));
    return null;
  }
}

/** Envoie les relevés et l'état courant de chaque pièce. */
export async function pushReleves(releves) {
  try { await call('POST', '/releves', { releves }); }
  catch (e) { console.warn('[scutti] envoi des relevés échoué :', e.message); }
}
