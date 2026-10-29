import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';
import Acces, { verifierCode } from './acces.js';

/** Un vérificateur fait comme Scutti le fait (N réduit ici pour la vitesse, sauf où le contrat est testé). */
function verificateurPour(code, N = 1024) {
  const sel = randomBytes(16);
  const empreinte = scryptSync(code.normalize('NFC'), sel, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${sel.toString('base64')}$${empreinte.toString('base64')}`;
}

/** Une horloge qu'on avance à la main. */
function horloge() {
  let t = 1_000_000;
  const maintenant = () => t;
  maintenant.avancer = (ms) => { t += ms; };
  return maintenant;
}

test('le code se vérifie avec les paramètres du contrat de Scutti', async () => {
  const v = verificateurPour('chaudiere-2026', 32768);
  assert.equal(await verifierCode('chaudiere-2026', v), true);
  assert.equal(await verifierCode('chaudiere-2027', v), false);
});

test('un code saisi sous une autre forme Unicode est le même code', async () => {
  // « é » composé ou décomposé, selon le clavier du téléphone.
  const v = verificateurPour('café-de-la-calade');
  assert.equal(await verifierCode('café-de-la-calade', v), true);
});

test('les espaces de bord ne comptent pas, comme dans Scutti', async () => {
  // Scutti calcule le vérificateur sur le code débarrassé de ses espaces de bord.
  const v = verificateurPour('code-du-hall');
  assert.equal(await verifierCode('  code-du-hall ', v), true);
  assert.equal(await verifierCode('code du hall', v), false);
  assert.equal(await verifierCode('   ', v), false);
});

test('un vérificateur abîmé ou démesuré ne vérifie rien', async () => {
  const bon = verificateurPour('un-code-solide');
  const [, , r, p, sel, empreinte] = bon.split('$');
  for (const v of [
    null, '', 'md5$abc', bon.replace('scrypt', 'bcrypt'),
    `scrypt$1048576$${r}$${p}$${sel}$${empreinte}`,   // un gigaoctet demandé au Raspberry
    `scrypt$1000$${r}$${p}$${sel}$${empreinte}`,      // N qui n'est pas une puissance de deux
    `scrypt$1024$${r}$${p}$${sel}$AAAA`,              // empreinte trop courte
  ]) {
    assert.equal(await verifierCode('un-code-solide', v), false, String(v));
  }
  assert.equal(await verifierCode('', bon), false);
});

test('sans code posé dans Scutti, la porte est fermée', async () => {
  const acces = new Acces(() => null);
  assert.equal(acces.ouvert(), false);
  assert.equal(await acces.connecter('nimporte-quoi'), null);
});

test('le bon code ouvre une session, le mauvais non', async () => {
  const v = verificateurPour('le-bon-code');
  const acces = new Acces(() => v);
  assert.equal(await acces.connecter('le-mauvais'), null);
  const jeton = await acces.connecter('le-bon-code');
  assert.match(jeton, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(acces.valide(jeton), true);
  assert.equal(acces.valide('un-jeton-invente'), false);
  assert.equal(acces.valide(null), false);
});

test('cinq erreurs ferment la porte un quart d’heure, même au bon code', async () => {
  const maintenant = horloge();
  const v = verificateurPour('le-bon-code');
  const acces = new Acces(() => v, maintenant);
  for (let i = 0; i < 5; i++) assert.equal(await acces.connecter(`essai-${i}`), null);
  assert.ok(acces.attente() > 0);
  assert.equal(await acces.connecter('le-bon-code'), null);
  maintenant.avancer(15 * 60_000 + 1);
  assert.equal(acces.attente(), 0);
  assert.ok(await acces.connecter('le-bon-code'));
});

test('des essais lancés ensemble ne passent pas sous la limite', async () => {
  const v = verificateurPour('le-bon-code');
  const acces = new Acces(() => v);
  const resultats = await Promise.all(Array.from({ length: 20 }, (_, i) => acces.connecter(`rafale-${i}`)));
  assert.ok(resultats.every((r) => r === null));
  // Les vingt ont été comptés : le bon code est refusé lui aussi.
  assert.equal(await acces.connecter('le-bon-code'), null);
});

test('un bon code ne consomme pas d’essai', async () => {
  const v = verificateurPour('le-bon-code');
  const acces = new Acces(() => v);
  for (let i = 0; i < 10; i++) assert.ok(await acces.connecter('le-bon-code'));
  assert.equal(acces.attente(), 0);
});

test('changer le code dans Scutti ferme les sessions ouvertes', async () => {
  let v = verificateurPour('ancien-code');
  const acces = new Acces(() => v);
  const jeton = await acces.connecter('ancien-code');
  assert.equal(acces.valide(jeton), true);
  v = verificateurPour('nouveau-code');
  assert.equal(acces.valide(jeton), false);
  v = null;
  assert.equal(acces.ouvert(), false);
});

test('une session oubliée douze heures expire, une session active tient sept jours au plus', async () => {
  const maintenant = horloge();
  const v = verificateurPour('le-bon-code');
  const acces = new Acces(() => v, maintenant);

  const oubliee = await acces.connecter('le-bon-code');
  maintenant.avancer(12 * 3600_000 + 1);
  assert.equal(acces.valide(oubliee), false);

  const active = await acces.connecter('le-bon-code');
  // Revue toutes les onze heures : 15 × 11 h = 165 h, encore sous les sept jours (168 h).
  for (let passage = 0; passage < 15; passage++) {
    maintenant.avancer(11 * 3600_000);
    assert.equal(acces.valide(active), true);
  }
  maintenant.avancer(11 * 3600_000);
  assert.equal(acces.valide(active), false);
});

test('se déconnecter ferme la session', async () => {
  const v = verificateurPour('le-bon-code');
  const acces = new Acces(() => v);
  const jeton = await acces.connecter('le-bon-code');
  acces.deconnecter(jeton);
  assert.equal(acces.valide(jeton), false);
});
