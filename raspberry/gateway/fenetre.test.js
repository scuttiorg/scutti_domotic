import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  suivreFenetre, noterMesure, chuteBrutale, SUIVI_VIDE,
  CHUTE_FENETRE, CHUTE_FENETRE_MS, COUPURE_FENETRE_MS, REMONTEE_FENETRE,
} from './fenetre.js';

const t0 = Date.parse('2026-10-28T12:00:00Z');
const min = (n) => t0 + n * 60_000;
const mesure = (minutes, temperature) => ({ temperature, le: new Date(min(minutes)).toISOString() });

/** Rejoue une suite de mesures `[minute, °C]`, chacune lue à son instant. */
function rejouer(mesures, suivi = SUIVI_VIDE) {
  for (const [minutes, temperature] of mesures) suivi = suivreFenetre(suivi, mesure(minutes, temperature), min(minutes));
  return suivi;
}

test('les seuils : 1 °C en 5 min, 30 min de coupure, 0,5 °C de remontée', () => {
  assert.equal(CHUTE_FENETRE, 1);
  assert.equal(CHUTE_FENETRE_MS, 5 * 60_000);
  assert.equal(COUPURE_FENETRE_MS, 30 * 60_000);
  assert.equal(REMONTEE_FENETRE, 0.5);
});

test('l’historique oublie ce qui a plus de 5 min, et ne note pas deux fois la même mesure', () => {
  let h = noterMesure([], mesure(0, 20));
  h = noterMesure(h, mesure(3, 19.8));
  h = noterMesure(h, mesure(3, 19.8));
  assert.equal(h.length, 2);
  h = noterMesure(h, mesure(6, 19.6));
  assert.deepEqual(h.map((m) => m.temperature), [19.8, 19.6]);
  assert.equal(noterMesure(h, null), h);
  assert.equal(noterMesure(h, { temperature: null, le: new Date(min(7)).toISOString() }), h);
});

test('une baisse de 1 °C en 5 min ou moins coupe la pièce pour 30 min', () => {
  const suivi = rejouer([[0, 20.3], [2, 19.9], [4, 19.3]]);
  assert.deepEqual(suivi.fenetre, { jusqua: min(4) + COUPURE_FENETRE_MS, plancher: 19.3 });
  // Au dixième près : 20,3 − 19,3 fait bien un degré.
  assert.ok(chuteBrutale([{ t: min(0), temperature: 20.3 }, { t: min(4), temperature: 19.3 }]));
});

test('une baisse plus lente, ou plus petite, ne coupe rien', () => {
  // Un degré, mais en 6 min : le refroidissement ordinaire d'une nuit froide.
  assert.equal(rejouer([[0, 20], [3, 19.5], [6, 19]]).fenetre, null);
  // 0,9 °C en 4 min.
  assert.equal(rejouer([[0, 20], [4, 19.1]]).fenetre, null);
});

test('pendant la coupure, la pièce qui continue de refroidir ne relance pas la détection', () => {
  let suivi = rejouer([[0, 20], [3, 19]]);
  const fin = suivi.fenetre.jusqua;
  suivi = rejouer([[5, 18.2], [8, 17.4], [10, 17.2]], suivi);
  assert.equal(suivi.fenetre.jusqua, fin);
  assert.equal(suivi.fenetre.plancher, 17.2);
});

test('une remontée de 0,5 °C depuis le point le plus bas : fenêtre refermée, fin de la coupure', () => {
  let suivi = rejouer([[0, 20], [3, 19], [6, 18.4], [9, 18.8]]);
  assert.ok(suivi.fenetre, '0,4 °C ne suffit pas');
  suivi = rejouer([[11, 18.9]], suivi);
  assert.equal(suivi.fenetre, null);
});

test('la chute qui a coupé ne recoupe pas une fois la fenêtre refermée', () => {
  // 20 → 18,5 → 19,0 en 4 min : refermée, et 20 − 19 fait un degré, mais
  // l'historique est reparti de 19,0.
  let suivi = rejouer([[0, 20], [2, 18.5], [4, 19]]);
  assert.equal(suivi.fenetre, null);
  // Sans ce nouveau départ, 20 (à 0 min) − 19 (à 5 min) recouperait.
  suivi = rejouer([[5, 19]], suivi);
  assert.equal(suivi.fenetre, null);
});

test('à l’échéance, la régulation normale reprend, et la détection avec elle', () => {
  let suivi = rejouer([[0, 20], [3, 19]]);
  // Plus aucune mesure : la coupure tient jusqu'à l'échéance, puis tombe.
  assert.ok(suivreFenetre(suivi, null, min(32)).fenetre);
  suivi = suivreFenetre(suivi, mesure(34, 16.5), min(34));
  assert.equal(suivi.fenetre, null);
  // Une nouvelle chute, après l'échéance, coupe de nouveau.
  suivi = rejouer([[36, 16], [38, 15.5]], suivi);
  assert.ok(suivi.fenetre);
});

test('l’option coupée : aucune coupure, et celle en cours tombe', () => {
  const vive = rejouer([[0, 20]]);
  assert.equal(suivreFenetre(vive, mesure(3, 18), min(3), false).fenetre, null);
  const coupee = rejouer([[0, 20], [3, 19]]);
  assert.equal(suivreFenetre(coupee, mesure(4, 18.9), min(4), false).fenetre, null);
});
