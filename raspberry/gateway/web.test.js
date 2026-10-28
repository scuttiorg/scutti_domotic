import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demarrerInterfaceLocale } from './web.js';

const UUID = '11111111-2222-3333-4444-555555555555';

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
    echanger: async () => appels.push(['echanger'])
  };
}

async function surUnServeur(travail) {
  const contexte = contexteDeTest();
  const serveur = demarrerInterfaceLocale(contexte, 0);
  await new Promise((resolve) => serveur.once('listening', resolve));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    await travail(base, contexte);
  } finally {
    serveur.close();
  }
}

test('les trois pages rendent', async () => {
  await surUnServeur(async (base) => {
    for (const chemin of ['/', '/appareils', '/reglages']) {
      const reponse = await fetch(base + chemin);
      assert.equal(reponse.status, 200, chemin);
      const html = await reponse.text();
      assert.match(html, /<html lang="fr"/);
      assert.match(html, /kit\.css/);
    }
  });
});

test('le nom d’une pièce est échappé', async () => {
  // Un nom venu de Scutti ne doit pas pouvoir écrire du HTML ici.
  await surUnServeur(async (base) => {
    const html = await (await fetch(base)).text();
    assert.match(html, /Atelier &lt;b&gt;chaud&lt;\/b&gt;/);
    assert.doesNotMatch(html, /Atelier <b>chaud<\/b>/);
  });
});

test('un réglage de pièce arrive au boîtier et renvoie sur la page d’où il vient', async () => {
  await surUnServeur(async (base, contexte) => {
    const reponse = await fetch(`${base}/pieces/${UUID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${base}/reglages` },
      body: new URLSearchParams({ champ: 'consigne_manuelle', valeur: '21' }),
      redirect: 'manual'
    });
    assert.equal(reponse.status, 303);
    assert.equal(reponse.headers.get('location'), '/reglages');
    assert.deepEqual(contexte.appels, [['reglerPiece', UUID, 'consigne_manuelle', '21']]);
  });
});

test('un renvoi vers l’extérieur n’est pas suivi', async () => {
  await surUnServeur(async (base) => {
    const reponse = await fetch(`${base}/appairer`, {
      method: 'POST',
      headers: { referer: 'https://ailleurs.example/' },
      redirect: 'manual'
    });
    assert.equal(reponse.headers.get('location'), '/');
  });
});

test('un identifiant qui n’en est pas un rend 404 sans rien appeler', async () => {
  await surUnServeur(async (base, contexte) => {
    const reponse = await fetch(`${base}/pieces/pas-un-uuid`, { method: 'POST', redirect: 'manual' });
    assert.equal(reponse.status, 404);
    assert.equal(await (await fetch(`${base}/inconnue`)).status, 404);
    assert.deepEqual(contexte.appels, []);
  });
});

test('une panne du boîtier rend une page lisible, pas une trace', async () => {
  const contexte = contexteDeTest();
  contexte.echanger = async () => { throw new Error('réseau coupé'); };
  const serveur = demarrerInterfaceLocale(contexte, 0);
  await new Promise((resolve) => serveur.once('listening', resolve));
  try {
    const reponse = await fetch(`http://127.0.0.1:${serveur.address().port}/echanger`, { method: 'POST', redirect: 'manual' });
    assert.equal(reponse.status, 500);
    assert.doesNotMatch(await reponse.text(), /réseau coupé/);
  } finally {
    serveur.close();
  }
});
