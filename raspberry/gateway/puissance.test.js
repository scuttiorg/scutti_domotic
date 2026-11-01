import { test } from 'node:test';
import assert from 'node:assert/strict';
import { puissanceLue, energieLue, puissanceMesuree, MESURE_VALIDE_MS, APRES_BASCULE_MS } from './puissance.js';

const T = Date.parse('2026-11-01T12:00:00Z');
const il = (ms) => new Date(T - ms).toISOString();

test('la puissance et l’énergie se lisent si elles sont plausibles', () => {
  assert.equal(puissanceLue({ power: 1486 }), 1486);
  assert.equal(puissanceLue({ power: -3 }), null);
  assert.equal(puissanceLue({ power: 99_999 }), null);
  assert.equal(puissanceLue({ state: 'ON' }), null);
  assert.equal(energieLue({ energy: 12.34 }), 12.34);
  assert.equal(energieLue({ energy: 'beaucoup' }), null);
});

test('une pièce tire la somme de ses prises', () => {
  const vus = new Map([
    ['atelier/prise1', { puissance: 1486.4, puissanceLe: il(60_000) }],
    ['atelier/prise2', { puissance: 0, puissanceLe: il(120_000) }],
  ]);
  assert.equal(puissanceMesuree(['atelier/prise1', 'atelier/prise2'], vus, new Map(), T), 1486);
});

test('une prise sans mesure, ou une mesure trop vieille, et la pièce n’a pas de mesure', () => {
  const vus = new Map([['a', { puissance: 1500, puissanceLe: il(60_000) }]]);
  assert.equal(puissanceMesuree(['a', 'b'], vus, new Map(), T), null);
  const vieille = new Map([['a', { puissance: 1500, puissanceLe: il(MESURE_VALIDE_MS + 1) }]]);
  assert.equal(puissanceMesuree(['a'], vieille, new Map(), T), null);
  assert.equal(puissanceMesuree([], vus, new Map(), T), null);
});

test('la mesure qui suit de trop près une commande est encore celle d’avant', () => {
  const vus = new Map([['a', { puissance: 0, puissanceLe: il(50_000) }]]);
  const commandes = new Map([['a', T - 60_000]]);
  assert.equal(puissanceMesuree(['a'], vus, commandes, T), null);
  const apres = new Map([['a', { puissance: 1490, puissanceLe: il(60_000 - APRES_BASCULE_MS) }]]);
  assert.equal(puissanceMesuree(['a'], apres, commandes, T), 1490);
});
