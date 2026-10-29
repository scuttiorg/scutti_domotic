import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consigneEnVigueur, doitChauffer, mesurePiece, avance, prisesDe, prisesAPoser } from './thermostat.js';

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

const t0 = Date.parse('2026-10-28T12:00:00Z');
const il = (min) => new Date(t0 - min * 60_000).toISOString();
const mesures = new Map([
  ['salon', { temperature: 20, humidite: 50, le: il(1) }],
  ['fenetre', { temperature: 17, humidite: 60, le: il(2) }],
  ['muet', { temperature: 10, humidite: 90, le: il(30) }],
]);
const trois = { capteurs: [{ nom: 'salon', compte: true }, { nom: 'fenetre', compte: true }, { nom: 'muet', compte: true }] };
const vingtMin = 20 * 60_000;

test('plusieurs capteurs : moyenne de ceux qui parlent, muet écarté', () =>
  assert.deepEqual(mesurePiece({ ...trois, calcul: 'moyenne' }, mesures, t0, vingtMin), { temperature: 18.5, humidite: 55, le: il(1) }));
test('plusieurs capteurs : le plus froid', () =>
  assert.equal(mesurePiece({ ...trois, calcul: 'plus_froid' }, mesures, t0, vingtMin).temperature, 17));
test('un capteur qui ne compte pas est ignoré', () => {
  const piece = { calcul: 'plus_froid', capteurs: [{ nom: 'salon', compte: true }, { nom: 'fenetre', compte: false }] };
  assert.equal(mesurePiece(piece, mesures, t0, vingtMin).temperature, 20);
});
test('tous les capteurs qui comptent sont muets → aucune mesure', () =>
  assert.equal(mesurePiece({ capteurs: [{ nom: 'muet', compte: true }] }, mesures, t0, vingtMin), null));
test('configuration d’avant les listes : `capteur` seul', () =>
  assert.equal(mesurePiece({ capteur: 'fenetre' }, mesures, t0, vingtMin).temperature, 17));

// Mardi 6h50 à Paris : la règle de semaine commence à 7h00.
const mardi6h50 = new Date('2026-10-27T05:50:00Z');
const dehors = (temperature, date) => ({ temperature, le: date.toISOString() });
const reglee = (exterieur) => ({ ...piece, anticipation: true, coupure_exterieur: true, exterieur });

test('avance : 3 min par degré sous 15 °C, 45 au plus', () => {
  assert.equal(avance(15), 0);
  assert.equal(avance(10), 15);
  assert.equal(avance(-10), 45);
});
test('par temps froid, la plage plus chaude démarre avant son heure', () =>
  assert.equal(consigneEnVigueur(reglee(dehors(5, mardi6h50)), mardi6h50), 19));
test('sans anticipation, elle attend son heure', () =>
  assert.equal(consigneEnVigueur({ ...reglee(dehors(5, mardi6h50)), anticipation: false }, mardi6h50), 16));
test('au-dessus de 17 °C dehors, pas de chauffe', () =>
  assert.equal(consigneEnVigueur(reglee(dehors(18, mardi10h)), mardi10h), null));
test('le manuel prime quand il fait doux', () =>
  assert.equal(consigneEnVigueur({ ...reglee(dehors(18, mardi10h)), mode: 'manuel', consigne_manuelle: 21 }, mardi10h), 21));
test('une température extérieure de plus de trois heures ne compte plus', () =>
  assert.equal(consigneEnVigueur(reglee(dehors(18, new Date(mardi10h.getTime() - 4 * 3_600_000))), mardi10h), 19));

// ── Plusieurs radiateurs, plusieurs prises ──────────────────────────────────

test('les prises d’une pièce : la liste, sans doublon, ou la seule d’avant', () => {
  assert.deepEqual(prisesDe({ prise: 'a', prises: ['a', 'b', 'a'] }), ['a', 'b']);
  assert.deepEqual(prisesDe({ prise: 'a' }), ['a']);
  assert.deepEqual(prisesDe({ prise: 'a', prises: [] }), ['a']);
});

const etat = (uuid, prises, chauffe) => [uuid, { piece: { uuid, prises }, chauffe }];

test('une pièce neuve : toutes ses prises éteintes', () => {
  assert.deepEqual(prisesAPoser(new Map(), [{ uuid: 'p1', prises: ['a', 'b'] }]), [['a', false], ['b', false]]);
});

test('rien ne change : aucun ordre, la régulation suffit', () => {
  const avant = new Map([etat('p1', ['a', 'b'], true)]);
  assert.deepEqual(prisesAPoser(avant, [{ uuid: 'p1', prises: ['b', 'a'] }]), []);
});

test('une prise ajoutée prend l’état de la pièce, une prise retirée est coupée', () => {
  const avant = new Map([etat('p1', ['a', 'b'], true)]);
  assert.deepEqual(prisesAPoser(avant, [{ uuid: 'p1', prises: ['a', 'c'] }]), [['b', false], ['c', true]]);
});

test('une prise passée d’une pièce à l’autre prend l’état de la nouvelle, dans les deux ordres', () => {
  const avant = new Map([etat('p1', ['a', 'b'], false), etat('p2', ['c'], true)]);
  for (const pieces of [
    [{ uuid: 'p1', prises: ['a'] }, { uuid: 'p2', prises: ['c', 'b'] }],
    [{ uuid: 'p2', prises: ['c', 'b'] }, { uuid: 'p1', prises: ['a'] }],
  ]) {
    assert.deepEqual(prisesAPoser(avant, pieces), [['b', true]]);
  }
});

test('une pièce supprimée : ses prises coupées, sauf celles reprises ailleurs', () => {
  const avant = new Map([etat('p1', ['a', 'b'], true), etat('p2', ['c'], false)]);
  assert.deepEqual(prisesAPoser(avant, [{ uuid: 'p2', prises: ['c', 'b'] }]), [['a', false], ['b', false]]);
});
