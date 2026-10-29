import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import { demarrerInterfaceLocale } from './web.js';
import Acces from './acces.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const CODE = 'le-code-de-l-atelier';

/** Un vérificateur fait comme Scutti le fait (N réduit pour la vitesse). */
function verificateurPour(code) {
  const sel = randomBytes(16);
  const empreinte = scryptSync(code, sel, 32, { N: 1024, r: 8, p: 1 });
  return `scrypt$1024$8$1$${sel.toString('base64')}$${empreinte.toString('base64')}`;
}

// Un vrai certificat, fait comme install.sh le fait : l'interface ne sait
// parler qu'en HTTPS, et c'est ainsi qu'on la teste.
let dossier;
let tls;
before(() => {
  dossier = mkdtempSync(join(tmpdir(), 'boitier-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '1', '-subj', '/CN=boitier.local',
    '-keyout', join(dossier, 'k'), '-out', join(dossier, 'c')], { stdio: 'ignore' });
  tls = { cert: readFileSync(join(dossier, 'c')), key: readFileSync(join(dossier, 'k')) };
});
after(() => rmSync(dossier, { recursive: true, force: true }));

/** Un boîtier de pacotille : l'interface ne fait que montrer et demander. */
function contexteDeTest() {
  const appels = [];
  return {
    appels,
    nom: 'Boîtier de l’atelier',
    scuttiUrl: 'https://scutti.example.fr',
    etatEchange: () => ({ ok: true, le: new Date().toISOString() }),
    appairageRestant: () => 0,
    pieces: () => [{
      uuid: UUID,
      nom: 'Atelier <b>chaud</b>',
      mode: 'auto',
      consigne: 19,
      temperature: 18.5,
      chauffe: true,
      capteur: 'scutti/thermometre',
      prise: 'scutti/prise'
    }],
    appareils: () => [{ ieee: '0x00124b', libelle: 'Thermomètre', type: 'capteur', modele: 'WSDCGQ11LM', batterie: 88 }],
    reglerPiece: async (...args) => appels.push(['reglerPiece', ...args]),
    nommerAppareil: async (...args) => appels.push(['nommerAppareil', ...args]),
    appairer: async () => appels.push(['appairer']),
    echanger: async () => appels.push(['echanger']),
    piece: (uuid) => (uuid === UUID
      ? {
        uuid,
        nom: 'Atelier <b>chaud</b>',
        radiateurs: [{ nom: 'Fenêtre', prises: ['atelier/prise-1', 'atelier/prise-2'] }, { nom: 'Porte <i>', prises: ['atelier/prise-3'] }],
        forcage: null,
      }
      : null),
    forcer: async (...args) => appels.push(['forcer', ...args]),
    arreterForcage: async (...args) => appels.push(['arreterForcage', ...args]),
  };
}

/** Une demande au boîtier. Le certificat est celui du test : on ne le vérifie pas ici. */
function demander(port, chemin, { method = 'GET', headers = {}, corps } = {}) {
  const contenu = corps ? new URLSearchParams(corps).toString() : '';
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: chemin, method, rejectUnauthorized: false,
      headers: { ...(contenu ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
    }, (reponse) => {
      let texte = '';
      reponse.on('data', (m) => { texte += m; });
      reponse.on('end', () => resolve({ status: reponse.statusCode, headers: reponse.headers, texte }));
    });
    req.on('error', reject);
    req.end(contenu);
  });
}

/**
 * Un boîtier qui tourne, et de quoi lui parler : `poster` envoie l'origine
 * d'une page du boîtier, comme le ferait le navigateur depuis l'une d'elles.
 */
async function surUnServeur(travail, { verificateur = verificateurPour(CODE), contexte = contexteDeTest() } = {}) {
  let v = verificateur;
  const acces = new Acces(() => v);
  const serveur = demarrerInterfaceLocale(contexte, 0, { tls, acces });
  await new Promise((resolve) => serveur.once('listening', resolve));
  const port = serveur.address().port;
  const origine = `https://127.0.0.1:${port}`;
  const outils = {
    contexte,
    acces,
    changerCode: (nouveau) => { v = nouveau; },
    get: (chemin, headers) => demander(port, chemin, { headers }),
    poster: (chemin, corps, headers = {}) => demander(port, chemin, { method: 'POST', corps, headers: { origin: origine, ...headers } }),
    async connecter(code = CODE) {
      const reponse = await outils.poster('/connexion', { code });
      const cookie = reponse.headers['set-cookie']?.[0]?.split(';')[0];
      return { reponse, cookie };
    },
  };
  try {
    await travail(outils);
  } finally {
    serveur.close();
  }
}

test('sans code posé dans Scutti, rien ne s’ouvre', async () => {
  await surUnServeur(async ({ get, poster, contexte }) => {
    for (const chemin of ['/', '/appareils', '/reglages', '/connexion']) {
      const reponse = await get(chemin);
      assert.equal(reponse.status, 503, chemin);
      assert.match(reponse.texte, /Aucun code d’accès/);
    }
    assert.equal((await poster('/connexion', { code: CODE })).status, 503);
    assert.equal((await poster('/appairer', {})).status, 503);
    assert.deepEqual(contexte.appels, []);
  }, { verificateur: null });
});

test('sans session, les pages renvoient à la connexion et rien ne se commande', async () => {
  await surUnServeur(async ({ get, poster, contexte }) => {
    for (const chemin of ['/', '/appareils', '/reglages']) {
      const reponse = await get(chemin);
      assert.equal(reponse.status, 303, chemin);
      assert.equal(reponse.headers.location, '/connexion');
    }
    assert.equal((await poster(`/pieces/${UUID}`, { champ: 'mode', valeur: 'off' })).status, 403);
    assert.equal((await poster('/appairer', {})).status, 403);
    // Un jeton inventé ne vaut pas mieux.
    assert.equal((await poster('/appairer', {}, { cookie: 'boitier_session=invente' })).status, 403);
    assert.deepEqual(contexte.appels, []);
  });
});

test('le bon code ouvre une session dans un cookie fermé, le mauvais non', async () => {
  await surUnServeur(async ({ connecter }) => {
    const mauvais = await connecter('pas-le-bon');
    assert.equal(mauvais.reponse.status, 401);
    assert.equal(mauvais.cookie, undefined);
    assert.match(mauvais.reponse.texte, /Code incorrect/);

    const bon = await connecter();
    assert.equal(bon.reponse.status, 303);
    assert.equal(bon.reponse.headers.location, '/');
    const cookie = bon.reponse.headers['set-cookie'][0];
    for (const drapeau of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.match(cookie, new RegExp(drapeau));
  });
});

test('trop d’essais : la connexion se ferme, même au bon code', async () => {
  await surUnServeur(async ({ connecter }) => {
    for (let i = 0; i < 5; i++) assert.equal((await connecter(`essai-${i}`)).reponse.status, 401);
    const bloque = await connecter();
    assert.equal(bloque.reponse.status, 429);
    assert.equal(bloque.cookie, undefined);
    assert.match(bloque.reponse.texte, /Trop d’essais/);
  });
});

test('connecté, les trois pages rendent', async () => {
  await surUnServeur(async ({ get, connecter }) => {
    const { cookie } = await connecter();
    for (const chemin of ['/', '/appareils', '/reglages']) {
      const reponse = await get(chemin, { cookie });
      assert.equal(reponse.status, 200, chemin);
      assert.match(reponse.texte, /<html lang="fr"/);
      assert.match(reponse.texte, /kit\.css/);
    }
  });
});

test('chaque réponse interdit les cadres, les scripts étrangers et le cache', async () => {
  await surUnServeur(async ({ get, connecter }) => {
    const { cookie } = await connecter();
    for (const reponse of [await get('/connexion'), await get('/', { cookie }), await get('/kit.css')]) {
      assert.match(reponse.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.match(reponse.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(reponse.headers['x-frame-options'], 'DENY');
      assert.equal(reponse.headers['cache-control'], 'no-store');
    }
  });
});

test('un formulaire posté depuis un autre site est refusé, même avec la session', async () => {
  await surUnServeur(async ({ poster, connecter, contexte }) => {
    const { cookie } = await connecter();
    const ailleurs = await poster('/appairer', {}, { cookie, origin: 'https://ailleurs.example' });
    assert.equal(ailleurs.status, 403);
    const sansOrigine = await poster('/appairer', {}, { cookie, origin: '' });
    assert.equal(sansOrigine.status, 403);
    assert.deepEqual(contexte.appels, []);
  });
});

test('le nom d’une pièce est échappé', async () => {
  // Un nom venu de Scutti ne doit pas pouvoir écrire du HTML ici.
  await surUnServeur(async ({ get, connecter }) => {
    const { cookie } = await connecter();
    const html = (await get('/', { cookie })).texte;
    assert.match(html, /Atelier &lt;b&gt;chaud&lt;\/b&gt;/);
    assert.doesNotMatch(html, /Atelier <b>chaud<\/b>/);
  });
});

test('un réglage de pièce arrive au boîtier et renvoie sur la page d’où il vient', async () => {
  await surUnServeur(async ({ poster, connecter, contexte }) => {
    const { cookie } = await connecter();
    const reponse = await poster(`/pieces/${UUID}`, { champ: 'consigne_manuelle', valeur: '21' },
      { cookie, referer: 'https://127.0.0.1/reglages' });
    assert.equal(reponse.status, 303);
    assert.equal(reponse.headers.location, '/reglages');
    assert.deepEqual(contexte.appels, [['reglerPiece', UUID, 'consigne_manuelle', '21']]);
  });
});

test('un renvoi vers l’extérieur n’est pas suivi', async () => {
  await surUnServeur(async ({ poster, connecter }) => {
    const { cookie } = await connecter();
    const reponse = await poster('/appairer', {}, { cookie, referer: 'https://ailleurs.example/' });
    assert.equal(reponse.headers.location, '/');
  });
});

test('un identifiant qui n’en est pas un rend 404 sans rien appeler', async () => {
  await surUnServeur(async ({ get, poster, connecter, contexte }) => {
    const { cookie } = await connecter();
    assert.equal((await poster('/pieces/pas-un-uuid', {}, { cookie })).status, 404);
    assert.equal((await get('/inconnue', { cookie })).status, 404);
    assert.deepEqual(contexte.appels, []);
  });
});

test('se déconnecter ferme la session', async () => {
  await surUnServeur(async ({ get, poster, connecter }) => {
    const { cookie } = await connecter();
    const sortie = await poster('/deconnexion', {}, { cookie });
    assert.equal(sortie.status, 303);
    assert.match(sortie.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await get('/', { cookie })).status, 303);
  });
});

test('un code changé dans Scutti met dehors les sessions ouvertes', async () => {
  await surUnServeur(async ({ get, connecter, changerCode }) => {
    const { cookie } = await connecter();
    changerCode(verificateurPour('un-tout-autre-code'));
    assert.equal((await get('/', { cookie })).status, 303);
  });
});

test('une panne du boîtier rend une page lisible, pas une trace', async () => {
  const contexte = contexteDeTest();
  contexte.echanger = async () => { throw new Error('réseau coupé'); };
  await surUnServeur(async ({ poster, connecter }) => {
    const { cookie } = await connecter();
    const reponse = await poster('/echanger', {}, { cookie });
    assert.equal(reponse.status, 500);
    assert.doesNotMatch(reponse.texte, /réseau coupé/);
  }, { contexte });
});

// ── La chauffe forcée ───────────────────────────────────────────────────────

test('forcer la chauffe : une page qui coche tous les radiateurs et propose 30 min à 4 h', async () => {
  await surUnServeur(async ({ get, connecter }) => {
    const { cookie } = await connecter();
    const liste = (await get('/', { cookie })).texte;
    assert.match(liste, new RegExp(`href="/pieces/${UUID}/forcer"[^>]*>Forcer la chauffe<`));

    const reponse = await get(`/pieces/${UUID}/forcer`, { cookie });
    assert.equal(reponse.status, 200);
    const html = reponse.texte;
    assert.equal((html.match(/name="radiateur" value="\d" checked/g) ?? []).length, 2);
    assert.match(html, /atelier\/prise-1, atelier\/prise-2/);
    assert.match(html, /Porte &lt;i&gt;/);
    for (const libelle of ['30 min', '1 h', '2 h', '4 h']) assert.match(html, new RegExp(`>${libelle}</option>`));
    assert.match(html, /<option value="60" selected>/);
    assert.doesNotMatch(html, /\u2014/);
    assert.equal((await get('/pieces/99999999-2222-3333-4444-555555555555/forcer', { cookie })).status, 404);
  });
});

test('le forçage posté arrive au boîtier avec les radiateurs cochés et la durée, puis revient à la liste', async () => {
  await surUnServeur(async ({ poster, connecter, contexte }) => {
    const { cookie } = await connecter();
    const corps = new URLSearchParams([['minutes', '120'], ['radiateur', '0'], ['radiateur', '1']]);
    const reponse = await poster(`/pieces/${UUID}/forcer`, corps, { cookie, referer: `https://127.0.0.1/pieces/${UUID}/forcer` });
    assert.equal(reponse.status, 303);
    assert.equal(reponse.headers.location, '/');
    assert.deepEqual(contexte.appels, [['forcer', UUID, ['0', '1'], '120']]);
    await poster(`/pieces/${UUID}/arreter`, {}, { cookie });
    assert.deepEqual(contexte.appels.at(-1), ['arreterForcage', UUID]);
  });
});

test('un forçage en cours se lit dans la liste, avec « Arrêter »', async () => {
  const contexte = contexteDeTest();
  const pieces = contexte.pieces;
  contexte.pieces = () => pieces().map((p) => ({ ...p, forcage: { resume: 'Chauffe forcée jusqu’à 15 h 30, 2 radiateurs', suspendu: false } }));
  await surUnServeur(async ({ get, connecter }) => {
    const { cookie } = await connecter();
    const html = (await get('/', { cookie })).texte;
    assert.match(html, /Chauffe forcée jusqu’à 15 h 30, 2 radiateurs/);
    assert.match(html, new RegExp(`action="/pieces/${UUID}/arreter"`));
    assert.doesNotMatch(html, new RegExp(`/pieces/${UUID}/forcer"`));
  }, { contexte });
});

test('sans session, ni la page du forçage ni ses formulaires ne passent', async () => {
  await surUnServeur(async ({ get, poster, contexte }) => {
    assert.equal((await get(`/pieces/${UUID}/forcer`)).status, 303);
    assert.equal((await poster(`/pieces/${UUID}/forcer`, { minutes: '60', radiateur: '0' })).status, 403);
    assert.equal((await poster(`/pieces/${UUID}/arreter`, {})).status, 403);
    assert.deepEqual(contexte.appels, []);
  });
});
