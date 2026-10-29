import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vitesseMesuree, apprendre, CHAUFFE_MIN_MS, LISSAGE } from './vitesse.js';

const t0 = Date.parse('2026-10-28T05:00:00Z');
const a = (minutes, temperature) => ({ le: t0 + minutes * 60_000, temperature });

test('les réglages : 15 min de chauffe au moins, une nouvelle mesure pèse 0,3', () => {
  assert.equal(CHAUFFE_MIN_MS, 15 * 60_000);
  assert.equal(LISSAGE, 0.3);
});

test('une chauffe de 30 min qui gagne 1 °C mesure 2 °C/h', () =>
  assert.equal(vitesseMesuree(a(0, 17), a(30, 18)), 2));

test('une chauffe trop courte, sans gain, ou interrompue n’apprend rien', () => {
  assert.equal(vitesseMesuree(a(0, 17), a(14, 18)), null);
  assert.equal(vitesseMesuree(a(0, 17), a(30, 17)), null);
  assert.equal(vitesseMesuree(a(0, 17), a(30, 16.5)), null);
  assert.equal(vitesseMesuree(a(0, 17), a(30, 18), true), null);
  assert.equal(vitesseMesuree(null, a(30, 18)), null);
  assert.equal(vitesseMesuree(a(0, null), a(30, 18)), null);
});

test('une mesure hors de l’ordinaire est ramenée entre 0,2 et 5 °C/h', () => {
  assert.equal(vitesseMesuree(a(0, 15), a(15, 18)), 5);          // 12 °C/h : un capteur posé sur le radiateur
  assert.equal(vitesseMesuree(a(0, 15), a(180, 15.1)), 0.2);     // 0,03 °C/h
});

test('la première mesure fait la vitesse, les suivantes la corrigent à 30 %', () => {
  assert.equal(apprendre(null, 2), 2);
  assert.equal(apprendre(2, 1), 1.7);
  assert.equal(apprendre(1.7, 1), 1.49);
});

test('sans mesure, la vitesse reste ; une vitesse rangée illisible repart de la mesure', () => {
  assert.equal(apprendre(1.8, null), 1.8);
  assert.equal(apprendre(null, null), null);
  assert.equal(apprendre(42, 2), 2);
});
