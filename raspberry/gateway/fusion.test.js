import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fusionnerChamps, poser, valeur } from './fusion.js';

const VIEUX = '2026-10-28T09:00:00.000Z';
const RECENT = '2026-10-28T10:00:00.000Z';

test('le champ le plus récent gagne, qu’il vienne d’ici ou de là-bas', () => {
  assert.deepEqual(
    fusionnerChamps({ nom: { valeur: 'Ici', le: VIEUX } }, { nom: { valeur: 'Là-bas', le: RECENT } }),
    { nom: { valeur: 'Là-bas', le: RECENT } }
  );
  assert.deepEqual(
    fusionnerChamps({ nom: { valeur: 'Ici', le: RECENT } }, { nom: { valeur: 'Là-bas', le: VIEUX } }),
    { nom: { valeur: 'Ici', le: RECENT } }
  );
});

test('deux modifications sur deux champs se gardent toutes les deux', () => {
  // C'est ce que « champ par champ » veut dire : réglé le mode ici pendant
  // qu'on renommait la pièce là-bas, les deux survivent.
  const sortie = fusionnerChamps(
    { mode: { valeur: 'manuel', le: RECENT }, nom: { valeur: 'Atelier', le: VIEUX } },
    { nom: { valeur: 'Grand atelier', le: RECENT }, mode: { valeur: 'auto', le: VIEUX } }
  );
  assert.deepEqual(sortie, {
    mode: { valeur: 'manuel', le: RECENT },
    nom: { valeur: 'Grand atelier', le: RECENT }
  });
});

test('l’égalité ne renverse pas', () => {
  // Deux horloges ne sont jamais exactement d'accord : une égalité qui
  // bascule ferait osciller la valeur à chaque échange.
  const sortie = fusionnerChamps({ mode: { valeur: 'auto', le: RECENT } }, { mode: { valeur: 'off', le: RECENT } });
  assert.equal(sortie.mode.valeur, 'auto');
});

test('un champ que l’autre ne porte pas est gardé tel quel', () => {
  const sortie = fusionnerChamps({ nom: { valeur: 'Atelier', le: VIEUX } }, { mode: { valeur: 'auto', le: VIEUX } });
  assert.deepEqual(Object.keys(sortie).sort(), ['mode', 'nom']);
});

test('une date illisible est ignorée plutôt que de valoir zéro', () => {
  // Date.parse rend NaN : sans garde, la comparaison serait fausse et le
  // champ passerait, ou pire remplacerait une valeur datée.
  const sortie = fusionnerChamps({ nom: { valeur: 'Atelier', le: VIEUX } }, { nom: { valeur: 'X', le: 'hier' } });
  assert.equal(sortie.nom.valeur, 'Atelier');
  assert.deepEqual(fusionnerChamps({}, { nom: { valeur: 'X', le: 'hier' } }), {});
});

test('poser date la valeur à l’instant, et valeur relit le champ', () => {
  const champ = poser(19.5);
  assert.equal(champ.valeur, 19.5);
  assert.ok(Date.now() - Date.parse(champ.le) < 5000);
  assert.equal(valeur({ consigne: champ }, 'consigne'), 19.5);
  assert.equal(valeur({}, 'consigne', 19), 19);
  assert.equal(valeur(undefined, 'consigne', 19), 19);
});
