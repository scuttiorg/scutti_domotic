import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Agent } from 'undici';
import config from './config.js';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.scutti.token}`,
  // Scutti l'affiche à côté du code d'accès (config.js, lireTls).
  ...(config.tls ? { 'X-Boitier-Empreinte-Tls': config.tls.empreinte } : {}),
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

/**
 * Les commandes à exécuter. LES LIRE, C'EST LES PRENDRE : Scutti ne les
 * rendra pas deux fois, et une fenêtre d'appairage ne se rouvre donc pas
 * toute seule au passage suivant.
 */
export async function fetchCommandes() {
  try {
    const data = await call('GET', '/commandes');
    return data.commandes ?? [];
  } catch (e) {
    console.warn('[scutti] commandes injoignables :', e.message);
    return [];
  }
}

/** Ce que le bridge a répondu : rien si tout s'est bien passé. */
export async function ackCommande(id, erreur = null) {
  try { await call('POST', `/commandes/${id}/acquitter`, { erreur }); }
  catch (e) { console.warn('[scutti] acquittement échoué :', e.message); }
}

/**
 * L'ÉCHANGE : on pose ce qui a été réglé ici, on repart avec l'état
 * d'après arbitrage. Aucun des deux côtés ne gagne : chaque champ porte sa
 * date, et la plus récente l'emporte, champ par champ.
 *
 * Un échec n'est pas une perte : l'état local garde ses dates, et le
 * prochain échange les posera. C'est ce qui rend le boîtier utilisable
 * pendant une coupure.
 */
export async function echanger(corps) {
  try {
    return await call('POST', '/echange', corps);
  } catch (e) {
    console.warn('[scutti] échange impossible :', e.message);
    return null;
  }
}

/**
 * La liste des appareils du réseau Zigbee. Elle REMPLACE la précédente :
 * c'est la passerelle qui sait ce qui est branché, et un appareil retiré
 * doit disparaître des écrans.
 */
export async function putAppareils(appareils) {
  try { await call('PUT', '/appareils', { appareils }); return true; }
  catch (e) { console.warn('[scutti] envoi des appareils échoué :', e.message); return false; }
}
