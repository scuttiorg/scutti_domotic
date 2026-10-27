import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentSetpoint, shouldHeat } from './thermostat.js';

const room = {
  enabled: true, mode: 'auto', default_setpoint: 16, hysteresis: 0.5,
  rules: [
    { enabled: true, priority: 10, days: [1, 2, 3, 4, 5], time_from: '07:00', time_to: '22:00', setpoint: 19 },
    { enabled: true, priority: 5, days: [6, 7], time_from: '22:00', time_to: '06:00', setpoint: 14 },
  ],
};
const mardi10h = new Date('2026-10-27T10:00:00');
const mardi23h = new Date('2026-10-27T23:00:00');
const dimanche2h = new Date('2026-11-01T02:00:00');

test('règle de jour en semaine', () => assert.equal(currentSetpoint(room, mardi10h), 19));
test('hors règle → consigne par défaut', () => assert.equal(currentSetpoint(room, mardi23h), 16));
test('plage traversant minuit', () => assert.equal(currentSetpoint(room, dimanche2h), 14));
test('mode off', () => assert.equal(currentSetpoint({ ...room, mode: 'off' }, mardi10h), null));
test('pièce désactivée', () => assert.equal(currentSetpoint({ ...room, enabled: false }, mardi10h), null));

test('manuel prime sur les règles', () =>
  assert.equal(currentSetpoint({ ...room, mode: 'manual', manual_setpoint: 21, manual_until: null }, mardi10h), 21));
test('manuel expiré → retour aux règles', () =>
  assert.equal(currentSetpoint({ ...room, mode: 'manual', manual_setpoint: 21, manual_until: '2026-10-27T09:00:00' }, mardi10h), 19));

test('hystérésis : allume sous consigne − h/2', () => assert.equal(shouldHeat(room, 18.5, false, mardi10h), true));
test('hystérésis : conserve l’état dans la bande', () => {
  assert.equal(shouldHeat(room, 19, false, mardi10h), false);
  assert.equal(shouldHeat(room, 19, true, mardi10h), true);
});
test('hystérésis : éteint au-dessus de consigne + h/2', () => assert.equal(shouldHeat(room, 19.4, true, mardi10h), false));
test('sans température → jamais chauffer', () => assert.equal(shouldHeat(room, null, true, mardi10h), false));
