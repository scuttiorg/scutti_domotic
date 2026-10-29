import { test } from 'node:test';
import assert from 'node:assert/strict';
import Basculements from './basculements.js';

const releve = (minutesAvant, maintenant) => ({
  piece_uuid: '11111111-2222-3333-4444-555555555555',
  temperature: 19.5, humidite: null, chauffe: true, consigne: 20,
  mesure_le: new Date(maintenant - minutesAvant * 60_000).toISOString(),
});

test('les basculements partent dans l’ordre, et sortent de la file une fois arrivés', () => {
  const t = Date.now();
  const file = new Basculements(() => t);
  file.noter(releve(2, t));
  file.noter(releve(1, t));
  const lot = file.aEnvoyer();
  assert.equal(lot.length, 2);
  assert.ok(Date.parse(lot[0].mesure_le) < Date.parse(lot[1].mesure_le));
  file.envoyes(lot.length);
  assert.deepEqual(file.aEnvoyer(), []);
});

test('un envoi raté les garde pour le suivant', () => {
  const t = Date.now();
  const file = new Basculements(() => t);
  file.noter(releve(1, t));
  file.aEnvoyer();             // l'envoi échoue : on n'appelle pas envoyes()
  assert.equal(file.aEnvoyer().length, 1);
});

test('au-delà de vingt-trois heures, oubliés : Scutti refuserait le lot entier', () => {
  const t = Date.now();
  const file = new Basculements(() => t);
  file.noter(releve(23 * 60 + 1, t));
  file.noter(releve(5, t));
  const lot = file.aEnvoyer();
  assert.equal(lot.length, 1);
  assert.equal(lot[0].mesure_le, releve(5, t).mesure_le);
});

test('cent par envoi au plus, et une longue coupure ne remplit pas la mémoire', () => {
  const t = Date.now();
  const file = new Basculements(() => t);
  for (let i = 600; i > 0; i--) file.noter(releve(i, t));
  assert.equal(file.aEnvoyer().length, 100);
  assert.equal(file.file.length, 500);
});
