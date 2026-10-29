import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EtatLocal from './local.js';

const fichierNeuf = () => join(mkdtempSync(join(tmpdir(), 'etat-')), 'local.json');

test('un réglage survit au redémarrage', () => {
  // C'est la raison d'être du fichier : réglé pendant une coupure, le
  // boîtier redémarre avec le réglage et le fera gagner au prochain échange.
  const fichier = fichierNeuf();
  const avant = new EtatLocal(fichier);
  avant.poserPiece('p1', 'consigne_manuelle', 21);
  avant.poserAppareil('0x01', 'libelle', 'Thermomètre');

  const apres = new EtatLocal(fichier);
  assert.equal(apres.champsPiece('p1').consigne_manuelle.valeur, 21);
  assert.equal(apres.champsAppareil('0x01').libelle.valeur, 'Thermomètre');
});

test('un fichier abîmé n’empêche pas le démarrage', () => {
  const fichier = fichierNeuf();
  writeFileSync(fichier, '{pas du json');
  const etat = new EtatLocal(fichier);
  assert.deepEqual(etat.pourEchange(), { pieces: [], appareils: [] });
});

test('l’écriture ne laisse pas de fichier provisoire derrière elle', () => {
  const fichier = fichierNeuf();
  const etat = new EtatLocal(fichier);
  etat.poserPiece('p1', 'mode', 'manuel');
  assert.equal(existsSync(`${fichier}.tmp`), false);
  assert.equal(JSON.parse(readFileSync(fichier, 'utf8')).pieces.p1.mode.valeur, 'manuel');
});

test('le retour de l’échange ne perd pas un réglage fait pendant l’appel', () => {
  // L'échange part, et pendant qu'il voyage quelqu'un règle la pièce ici.
  // La réponse porte l'état d'avant ce réglage : la refusion le garde.
  const etat = new EtatLocal(fichierNeuf());
  etat.poserPiece('p1', 'consigne_manuelle', 21);
  etat.appliquerRetour({
    pieces: [{ uuid: 'p1', champs: { consigne_manuelle: { valeur: 18, le: '2026-10-28T09:00:00.000Z' } } }],
    appareils: []
  });
  assert.equal(etat.champsPiece('p1').consigne_manuelle.valeur, 21);
});

test('une pièce absente de la réponse disparaît d’ici', () => {
  // Supprimée dans Scutti : sans cela le boîtier chaufferait pour une pièce
  // qui n'existe plus.
  const etat = new EtatLocal(fichierNeuf());
  etat.poserPiece('p1', 'mode', 'manuel');
  etat.poserPiece('p2', 'mode', 'manuel');
  etat.appliquerRetour({ pieces: [{ uuid: 'p2', champs: {} }], appareils: [] });
  assert.deepEqual(etat.pieces().map((p) => p.uuid), ['p2']);
});

test('ce qui part à l’échange porte chaque champ avec sa date', () => {
  const etat = new EtatLocal(fichierNeuf());
  etat.poserPiece('p1', 'mode', 'auto');
  const { pieces } = etat.pourEchange();
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].uuid, 'p1');
  assert.ok(pieces[0].champs.mode.le);
});

test('la vitesse de chauffe apprise survit au redémarrage, et ne part pas à l’échange', () => {
  const fichier = fichierNeuf();
  const avant = new EtatLocal(fichier);
  avant.poserVitesse('p1', 1.8);
  const apres = new EtatLocal(fichier);
  assert.equal(apres.vitesse('p1'), 1.8);
  assert.equal(apres.vitesse('p2'), null);
  assert.deepEqual(Object.keys(apres.pourEchange()), ['pieces', 'appareils']);
});

test('le retour de l’échange garde la vitesse des pièces qui restent, oublie celle des pièces supprimées', () => {
  const etat = new EtatLocal(fichierNeuf());
  etat.poserVitesse('p1', 1.8);
  etat.poserVitesse('p2', 2.4);
  etat.appliquerRetour({ pieces: [{ uuid: 'p2', champs: {} }], appareils: [] });
  assert.equal(etat.vitesse('p1'), null);
  assert.equal(etat.vitesse('p2'), 2.4);
});

test('un état d’avant les vitesses se lit, sans vitesse', () => {
  const fichier = fichierNeuf();
  writeFileSync(fichier, JSON.stringify({ pieces: { p1: {} }, appareils: {} }));
  const etat = new EtatLocal(fichier);
  assert.equal(etat.vitesse('p1'), null);
  etat.poserVitesse('p1', 0.9);
  assert.equal(JSON.parse(readFileSync(fichier, 'utf8')).vitesses.p1, 0.9);
});
