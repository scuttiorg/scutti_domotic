import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consigneEnVigueur, doitChauffer } from './thermostat.js';

const piece = {
  mode: 'auto', consigne_defaut: 16, consigne_manuelle: null, manuel_jusqua: null,
  regles: [
    { actif: true, priorite: 10, jours: [1, 2, 3, 4, 5], heure_debut: '07:00', heure_fin: '22:00', consigne: 19 },
    { actif: true, priorite: 5, jours: [6, 7], heure_debut: '22:00', heure_fin: '06:00', consigne: 14 },
  ],
};
// Des instants en heure de Paris (UTC+1 fin octobre), quel que soit le fuseau du système.
const mardi10h = new Date('2026-10-27T09:00:00Z');
const mardi23h = new Date('2026-10-27T22:00:00Z');
const dimanche2h = new Date('2026-11-01T01:00:00Z');
const lundi2h = new Date('2026-11-02T01:00:00Z');

test('règle de jour en semaine', () => assert.equal(consigneEnVigueur(piece, mardi10h), 19));
test('hors règle → consigne par défaut', () => assert.equal(consigneEnVigueur(piece, mardi23h), 16));
test('plage traversant minuit, le matin suivant aussi', () => {
  assert.equal(consigneEnVigueur(piece, dimanche2h), 14);
  assert.equal(consigneEnVigueur(piece, lundi2h), 14);
});
test('mode off', () => assert.equal(consigneEnVigueur({ ...piece, mode: 'off' }, mardi10h), null));
test('manuel prime sur les règles', () =>
  assert.equal(consigneEnVigueur({ ...piece, mode: 'manuel', consigne_manuelle: 21 }, mardi10h), 21));
test('manuel expiré → retour aux règles', () =>
  assert.equal(consigneEnVigueur({ ...piece, mode: 'manuel', consigne_manuelle: 21, manuel_jusqua: '2026-10-27T08:00:00Z' }, mardi10h), 19));

test('hystérésis : allume sous consigne − h/2', () => assert.equal(doitChauffer(19, 18.5, false, 0.5), true));
test('hystérésis : conserve l’état dans la bande', () => {
  assert.equal(doitChauffer(19, 19, false, 0.5), false);
  assert.equal(doitChauffer(19, 19, true, 0.5), true);
});
test('hystérésis : éteint au-dessus de consigne + h/2', () => assert.equal(doitChauffer(19, 19.4, true, 0.5), false));
test('sans température → jamais chauffer', () => assert.equal(doitChauffer(19, null, true, 0.5), false));
