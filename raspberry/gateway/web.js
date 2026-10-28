// L'INTERFACE LOCALE DU BOÎTIER : trois pages servies sur le réseau du
// bâtiment, pour que le chauffage reste réglable sans Scutti.
//
// POURQUOI ELLE EXISTE : une box en panne, une fibre coupée, ou simplement
// quelqu'un qui n'a pas de compte, et le chauffage devenait impilotable
// alors que le Raspberry est là, sur le même wifi. Ce n'est pas une version
// dégradée de Scutti : les deux côtés écrivent, et la chronologie tranche
// champ par champ (fusion.js).
//
// SANS CADRE NI DÉPENDANCE : `node:http`, des pages rendues en chaînes, des
// formulaires qui se postent et redirigent. Un Raspberry qui chauffe un
// bâtiment n'a pas à embarquer un serveur d'application, et une page qui
// marche sans JavaScript marche aussi quand le JavaScript ne charge pas.
//
// LE STYLE RESTE SÉPARÉ DU GABARIT ET DU JAVASCRIPT : `web/kit.css` est la
// copie engendrée du kit de Scutti, `web/boitier.js` le seul script, et
// aucun gestionnaire n'est écrit dans le HTML.
//
// PAS D'AUTHENTIFICATION, ET C'EST VOULU : l'autorisation est l'accès au
// réseau local, comme pour une box ou une imprimante. Mettre un mot de
// passe sur l'interface de secours, c'est la rendre inutilisable le jour où
// elle sert. Le boîtier n'est jamais exposé à l'Internet : il n'ouvre aucun
// port vers l'extérieur, et c'est lui qui appelle Scutti.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { valeur } from './fusion.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const MODES = { off: 'Arrêt', auto: 'Auto', manuel: 'Manuel' };
const TYPES_APPAREIL = { capteur: 'Capteur', prise: 'Prise', autre: 'Autre' };

/** Rien de ce qui vient d'un champ posé ailleurs n'entre dans une page sans ceci. */
const echapper = (texte) => String(texte ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** « il y a 2 min », « hier », pour une date ISO ou null. */
function depuis(iso) {
  if (!iso) return 'jamais';
  const secondes = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(secondes)) return 'jamais';
  if (secondes < 60) return `il y a ${Math.max(0, secondes)} s`;
  if (secondes < 3600) return `il y a ${Math.round(secondes / 60)} min`;
  if (secondes < 86_400) return `il y a ${Math.round(secondes / 3600)} h`;
  return `il y a ${Math.round(secondes / 86_400)} j`;
}

/** « 1 pièce », « 3 pièces » : jamais « pièce(s) ». */
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

const degres = (n) => (n === null || n === undefined ? '' : `${Number(n).toFixed(1).replace('.', ',')} &deg;C`);

function page(titre, corps) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${echapper(titre)}</title>
  <link rel="stylesheet" href="/kit.css">
  <link rel="stylesheet" href="/boitier.css">
  <script src="/boitier.js" defer></script>
</head>
<body>
  <div class="list-page-layout boitier-page">
${corps}
  </div>
</body>
</html>`;
}

function entete(titre, sousTitre, actions) {
  return `    <div class="k-page-header">
      <div>
        <h1 class="k-page-title">${echapper(titre)}</h1>
        <p class="k-page-subtitle">${sousTitre}</p>
      </div>
      <div class="k-page-header-actions">${actions}</div>
    </div>`;
}

function pagePieces(contexte) {
  const echange = contexte.etatEchange();
  const lignes = contexte.pieces().map((p) => `
          <tr>
            <td data-role="primary">
              <div class="k-cell-info">
                <div class="k-cell-info-title">${echapper(p.nom)}</div>
                <div class="k-cell-info-subtitle">${echapper(p.note)}</div>
              </div>
            </td>
            <td data-role="meta">${degres(p.consigne)}</td>
            <td data-role="status" class="text-right">${p.temperature === null ? '' : `<span class="k-amount">${degres(p.temperature)}</span>`}</td>
            <td data-role="amount" class="text-right">${p.chauffe ? 'En chauffe' : 'Au repos'} <span class="k-status-dot" data-color="${p.chauffe ? 'orange' : 'gray'}"></span></td>
            <td>
              <form method="post" action="/pieces/${encodeURIComponent(p.uuid)}" class="boitier-rangee" data-auto>
                <input type="hidden" name="champ" value="mode">
                <span class="k-input">
                  <select name="valeur" aria-label="Mode de ${echapper(p.nom)}">
                    ${Object.entries(MODES).map(([v, l]) => `<option value="${v}"${p.mode === v ? ' selected' : ''}>${l}</option>`).join('')}
                  </select>
                </span>
                <button type="submit" class="k-button" data-variant="outline" data-size="small" data-sans-js>Valider</button>
              </form>
            </td>
          </tr>`).join('');

  return page('Pièces', `${entete(
    contexte.nom,
    `Boîtier local &middot; ${pluriel(contexte.pieces().length, 'pièce')}`,
    `<a href="/appareils" class="k-button" data-variant="outline">Appareils</a>
       <a href="/reglages" class="k-button" data-variant="outline">Réglages</a>`
  )}

    <div class="k-card">
      <div class="k-card-body">
        <div class="k-table k-table--fixed">
          <table><tbody><tr>
            <td data-role="primary">
              <div class="k-cell-info">
                <div class="k-cell-info-title">Scutti</div>
                <div class="k-cell-info-subtitle">Échange ${depuis(echange.le)}</div>
              </div>
            </td>
            <td class="text-right" style="width: 22%;">${echange.ok ? 'À jour' : 'Injoignable'} <span class="k-status-dot" data-color="${echange.ok ? 'green' : 'red'}"></span></td>
          </tr></tbody></table>
        </div>
      </div>
    </div>

    <div class="k-table-wrapper">
      <div class="k-table k-table--fixed k-table--filets k-table--comfortable k-table--stacked">
        <table>
          <thead>
            <tr>
              <th style="width: 28%;">Pièce</th>
              <th style="width: 20%;">Consigne</th>
              <th class="text-right" style="width: 12%;">Mesuré</th>
              <th class="text-right" style="width: 16%;">État</th>
              <th style="width: 24%;">Mode</th>
            </tr>
          </thead>
          <tbody>${lignes || '<tr><td colspan="5">Aucune pièce. Créez-en une depuis Scutti.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`);
}

function pageAppareils(contexte) {
  const restant = contexte.appairageRestant();
  const lignes = contexte.appareils().map((a) => `
          <tr>
            <td data-role="primary">
              <form method="post" action="/appareils/${encodeURIComponent(a.ieee)}" class="boitier-rangee">
                <div class="k-input boitier-nom">
                  <input type="text" name="libelle" value="${echapper(a.libelle ?? '')}" placeholder="${echapper(a.nom_z2m)}" aria-label="Nom de ${echapper(a.libelle || a.nom_z2m)}">
                </div>
                <button type="submit" class="k-button" data-variant="outline" data-size="small">Enregistrer</button>
              </form>
            </td>
            <td data-role="meta">${TYPES_APPAREIL[a.type] ?? 'Autre'}</td>
            <td data-role="status">${depuis(a.vu_le)}</td>
            <td data-role="amount" class="text-right">${a.batterie === null || a.batterie === undefined ? '' : `${Math.round(a.batterie)} %`}</td>
          </tr>`).join('');

  const encart = restant > 0
    ? `    <div class="k-alert" data-variant="info">
      Appairage ouvert, ${Math.floor(restant / 60)}:${String(restant % 60).padStart(2, '0')}. Appuyez sur le bouton d'appairage de l'appareil, ou rebranchez-le.
    </div>`
    : '';

  return page('Appareils', `${entete(
    'Appareils',
    `${contexte.nom} &middot; ${pluriel(contexte.appareils().length, 'appareil')} sur le réseau Zigbee`,
    `<a href="/" class="k-button" data-variant="outline">Pièces</a>
       <form method="post" action="/appairer">
         <button type="submit" class="k-button" data-variant="filled" data-theme="primary"${restant > 0 ? ' disabled' : ''}>Appairer un appareil</button>
       </form>`
  )}

${encart}
    <div class="k-table-wrapper">
      <div class="k-table k-table--fixed k-table--filets k-table--stacked">
        <table>
          <thead>
            <tr>
              <th>Appareil</th>
              <th style="width: 14%;">Type</th>
              <th style="width: 18%;">Dernière vue</th>
              <th class="text-right" style="width: 12%;">Batterie</th>
            </tr>
          </thead>
          <tbody>${lignes || '<tr><td colspan="4">Aucun appareil. Ouvrez l’appairage, puis mettez votre capteur en appairage.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`);
}

function pageReglages(contexte) {
  const echange = contexte.etatEchange();
  const rangee = (titre, detail, valeurAffichee, action = '') => `
            <tr>
              <td data-role="primary">
                <div class="k-cell-info">
                  <div class="k-cell-info-title">${echapper(titre)}</div>
                  <div class="k-cell-info-subtitle">${echapper(detail)}</div>
                </div>
              </td>
              <td data-role="meta">${echapper(valeurAffichee)}</td>
              <td data-role="actions" class="text-right">${action}</td>
            </tr>`;

  return page('Réglages du boîtier', `${entete(
    'Réglages du boîtier',
    echapper(contexte.nom),
    '<a href="/" class="k-button" data-variant="outline">Pièces</a>'
  )}

    <div class="k-card">
      <div class="k-card-header"><h2 class="k-card-title">Lien avec Scutti</h2></div>
      <div class="k-card-body">
        <div class="k-table k-table--fixed k-table--stacked">
          <table>
            <thead><tr><th>Réglage</th><th style="width: 40%;">Valeur</th><th class="text-right" style="width: 180px;"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
${rangee('Adresse de Scutti', 'Le serveur avec lequel le boîtier échange.', contexte.scuttiUrl)}
${rangee(
    'Dernier échange',
    echange.ok ? 'Tout est passé.' : 'Les réglages faits ici partiront dès le retour du réseau.',
    depuis(echange.le),
    `<form method="post" action="/echanger"><button type="submit" class="k-button" data-variant="outline" data-size="small">Échanger</button></form>`
  )}
${rangee('Horloge', 'C’est elle qui départage deux modifications : elle se règle sur le temps du réseau.', new Date().toLocaleString('fr-FR'))}
            </tbody>
          </table>
        </div>
      </div>
    </div>`);
}

/** Le corps d'un POST de formulaire, borné : rien d'autre n'arrive ici. */
function lireCorps(requete) {
  return new Promise((resolve, reject) => {
    let brut = '';
    requete.on('data', (morceau) => {
      brut += morceau;
      if (brut.length > 8192) reject(new Error('corps trop long'));
    });
    requete.on('end', () => resolve(new URLSearchParams(brut)));
    requete.on('error', reject);
  });
}

function fichierStatique(nom, reponse) {
  const chemin = join(WEB, nom);
  if (!chemin.startsWith(WEB) || !existsSync(chemin)) return false;
  reponse.writeHead(200, { 'content-type': TYPES[nom.slice(nom.lastIndexOf('.'))] ?? 'application/octet-stream' });
  reponse.end(readFileSync(chemin));
  return true;
}

/** Les trois pages du boîtier, et leur rendu. */
const RENDUS = { '/': pagePieces, '/appareils': pageAppareils, '/reglages': pageReglages };
const PAGES = Object.keys(RENDUS);

/**
 * La page où revenir après un POST : celle d'où venait le formulaire, et
 * seulement si c'est une page du boîtier. On ne renvoie jamais vers une
 * adresse lue dans l'en-tête : un lien envoyé de l'extérieur ferait alors
 * sortir du boîtier après un réglage.
 */
function retour(referer) {
  try {
    const chemin = new URL(referer, 'http://boitier').pathname;
    return PAGES.includes(chemin) ? chemin : '/';
  } catch {
    return '/';
  }
}

/**
 * Démarre l'interface locale.
 *
 * @param contexte ce que les pages lisent et ce qu'elles déclenchent : le
 *   boîtier décide, l'interface ne fait que montrer et demander.
 */
export function demarrerInterfaceLocale(contexte, port) {
  const serveur = createServer(async (requete, reponse) => {
    const url = new URL(requete.url, 'http://boitier');
    const chemin = url.pathname;

    try {
      if (requete.method === 'GET') {
        if (['/kit.css', '/boitier.css', '/boitier.js'].includes(chemin)) {
          if (fichierStatique(chemin.slice(1), reponse)) return;
        }
        const rendu = RENDUS[chemin];
        if (!rendu) return reponse.writeHead(404).end('Page introuvable');
        reponse.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return reponse.end(rendu(contexte));
      }

      if (requete.method === 'POST') {
        const corps = await lireCorps(requete);
        const piece = chemin.match(/^\/pieces\/([0-9a-f-]{36})$/);
        const appareil = chemin.match(/^\/appareils\/([A-Za-z0-9x]{3,32})$/);

        if (piece) await contexte.reglerPiece(piece[1], corps.get('champ'), corps.get('valeur'));
        else if (appareil) await contexte.nommerAppareil(appareil[1], corps.get('libelle'));
        else if (chemin === '/appairer') await contexte.appairer();
        else if (chemin === '/echanger') await contexte.echanger();
        else return reponse.writeHead(404).end('Page introuvable');

        // 303 : le rechargement de la page après un POST ne rejoue pas le POST.
        return reponse.writeHead(303, { location: retour(requete.headers.referer) }).end();
      }

      return reponse.writeHead(405).end('Méthode non admise');
    } catch (erreur) {
      console.warn('[web]', erreur.message);
      reponse.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return reponse.end('Le boîtier n’a pas pu traiter la demande.');
    }
  });

  serveur.listen(port, () => console.log(`[web] interface locale sur le port ${serveur.address().port}`));
  return serveur;
}
