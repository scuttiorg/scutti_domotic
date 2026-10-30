import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { instant, dateDe } from './horloge.js';

test('sans saut, l’heure d’un instant est stable d’une lecture à l’autre', () => {
  const vu = instant();
  assert.equal(dateDe(vu).getTime(), dateDe(vu).getTime());
  assert.ok(Math.abs(dateDe(vu).getTime() - Date.now()) < 1000);
});

test('le 30/10 : l’horloge saute de 2 h 24 après le relevé, l’heure du relevé suit', (t) => {
  t.mock.method(console, 'log', () => {});
  const vu = instant();
  const avant = dateDe(vu).getTime();
  const reel = Date.now;
  const saut = (2 * 60 + 24) * 60_000;
  mock.method(Date, 'now', () => reel() + saut);
  try {
    // Le relevé n'a pas vieilli : il est daté de l'heure juste, deux heures plus tard.
    assert.ok(Math.abs(dateDe(vu).getTime() - (avant + saut)) < 1000);
    assert.ok(Math.abs(dateDe(vu).getTime() - Date.now()) < 1000);
  } finally {
    Date.now.mock.restore();
  }
});
