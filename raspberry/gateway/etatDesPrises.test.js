import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  etatLu, rattraper, prisesReellementAllumees,
  DELAI_AVANT_RATTRAPAGE, RATTRAPAGES_MAX, FENETRE_RATTRAPAGE,
} from './etatDesPrises.js';

const t0 = Date.parse('2026-11-26T12:32:00Z');

test('lit l’état que la prise rapporte', () => {
  assert.equal(etatLu({ state: 'ON', power: 1608 }), true);
  assert.equal(etatLu({ state: 'OFF' }), false);
  assert.equal(etatLu({ power: 1608 }), null);
  assert.equal(etatLu(null), null);
});

test('La Calade, 26/11 : coupée à 12 h 32, la prise reste allumée → l’ordre repart', () => {
  const r = rattraper({ voulue: false, reelle: true, derniereCommande: t0, maintenant: t0 + 60_000 });
  assert.equal(r.renvoyer, true);
  assert.deepEqual(r.essais, [t0 + 60_000]);
});

test('on laisse à l’ordre le temps d’arriver', () => {
  const r = rattraper({ voulue: false, reelle: true, derniereCommande: t0, maintenant: t0 + DELAI_AVANT_RATTRAPAGE - 1 });
  assert.equal(r.renvoyer, false);
});

test('une prise d’accord efface les essais', () => {
  const r = rattraper({ voulue: false, reelle: false, essais: [t0], maintenant: t0 + 60_000 });
  assert.deepEqual(r, { renvoyer: false, essais: [], abandon: false });
});

test('on ne s’acharne pas : un appui volontaire sur le bouton finit par gagner', () => {
  let essais = [];
  let r;
  for (let i = 0; i < RATTRAPAGES_MAX; i++) {
    r = rattraper({ voulue: false, reelle: true, essais, maintenant: t0 + i * 60_000 });
    assert.equal(r.renvoyer, true);
    essais = r.essais;
  }
  r = rattraper({ voulue: false, reelle: true, essais, maintenant: t0 + RATTRAPAGES_MAX * 60_000 });
  assert.equal(r.renvoyer, false);
  assert.equal(r.abandon, true);
  // La fenêtre passée, on réessaie.
  r = rattraper({ voulue: false, reelle: true, essais, maintenant: t0 + FENETRE_RATTRAPAGE + RATTRAPAGES_MAX * 60_000 });
  assert.equal(r.renvoyer, true);
});

test('juste après un redémarrage, le boîtier ne contredit pas une prise sans rien vouloir', () => {
  const r = rattraper({ voulue: null, reelle: true, maintenant: t0 });
  assert.equal(r.renvoyer, false);
});

test('les prises réellement allumées : l’état rapporté passe avant la demande', () => {
  const prises = ['scutti/priseradiateurpich', 'scutti/priseradiateuaudrey'];
  const etats = new Map([['scutti/priseradiateurpich', true]]);
  // Le boîtier croit avoir tout coupé ; la prise de Pich dit le contraire,
  // celle d'Audrey n'a rien dit : on garde la demande.
  assert.deepEqual(prisesReellementAllumees(prises, [], etats), ['scutti/priseradiateurpich']);
  etats.set('scutti/priseradiateuaudrey', false);
  assert.deepEqual(prisesReellementAllumees(prises, prises, etats), ['scutti/priseradiateurpich']);
});
