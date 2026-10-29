import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deduireType, construireAppareils, signature } from './devices.js';

test('un appareil qui mesure une température est un capteur', () => {
  const definition = { exposes: [{ property: 'temperature', access: 1 }, { property: 'battery', access: 1 }] };
  assert.equal(deduireType(definition), 'capteur');
});

test('un appareil qui mesure une humidité seule est un capteur', () => {
  assert.equal(deduireType({ exposes: [{ property: 'humidity', access: 1 }] }), 'capteur');
});

test('un état commandable fait une prise', () => {
  // access 7 = lecture, écriture et interrogation : une prise ordinaire.
  assert.equal(deduireType({ exposes: [{ property: 'state', access: 7 }] }), 'prise');
});

test('un état seulement lisible n’est pas une prise', () => {
  // Le contact d’une porte expose `state`, mais en lecture seule (access 1).
  assert.equal(deduireType({ exposes: [{ property: 'state', access: 1 }] }), 'autre');
});

test('une propriété imbriquée dans un composite est vue', () => {
  const definition = { exposes: [{ type: 'switch', features: [{ property: 'state', access: 7 }] }] };
  assert.equal(deduireType(definition), 'prise');
});

test('un appareil sans exposes connu reste « autre »', () => {
  assert.equal(deduireType(undefined), 'autre');
  assert.equal(deduireType({ exposes: [] }), 'autre');
});

test('le coordinateur ne fait pas partie des appareils', () => {
  const liste = construireAppareils([
    { type: 'Coordinator', ieee_address: '0x0001', friendly_name: 'Coordinator' },
    { type: 'EndDevice', ieee_address: '0x0002', friendly_name: 'atelier/thermo', definition: { model: 'SNZB-02', exposes: [{ property: 'temperature', access: 1 }] } },
  ]);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].nom_z2m, 'atelier/thermo');
  assert.equal(liste[0].modele, 'SNZB-02');
});

test('la batterie, la température et la dernière vue viennent de ce que l’appareil a dit', () => {
  const vus = new Map([['atelier/thermo', { batterie: 72, temperature: 18.4, vuLe: '2026-10-28T09:00:00.000Z' }]]);
  const [appareil] = construireAppareils(
    [{ type: 'EndDevice', ieee_address: '0x0002', friendly_name: 'atelier/thermo', definition: { exposes: [] } }],
    vus,
  );
  assert.equal(appareil.batterie, 72);
  assert.equal(appareil.temperature, 18.4);
  assert.equal(appareil.vu_le, '2026-10-28T09:00:00.000Z');
});

test('un appareil dont on n’a rien entendu n’invente ni batterie ni date', () => {
  const [appareil] = construireAppareils([
    { type: 'EndDevice', ieee_address: '0x0003', friendly_name: 'atelier/radiateur', definition: { exposes: [{ property: 'state', access: 7 }] } },
  ]);
  assert.equal(appareil.batterie, null);
  assert.equal(appareil.temperature, null);
  assert.equal(appareil.vu_le, null);
  assert.equal(appareil.type, 'prise');
});

test('la batterie, la température et la date de dernière vue ne changent pas la signature', () => {
  const avant = [{ ieee: '0x0002', nom_z2m: 'atelier/thermo', type: 'capteur', modele: 'SNZB-02', batterie: 72, temperature: 18.4, vu_le: '2026-10-28T10:00:00Z' }];
  const apres = [{ ...avant[0], batterie: 71, temperature: 18.9, vu_le: '2026-10-28T10:05:00Z' }];
  assert.equal(signature(avant), signature(apres));
});

test('un appareil qui arrive, puis qui livre son modèle, change la signature à chaque fois', () => {
  const avant = [{ ieee: '0x0002', nom_z2m: 'atelier/thermo', type: 'capteur', modele: 'SNZB-02' }];
  const arrive = [...avant, { ieee: '0x0003', nom_z2m: '0x0003', type: 'autre', modele: null }];
  const interroge = [...avant, { ieee: '0x0003', nom_z2m: '0x0003', type: 'capteur', modele: 'SNZB-02' }];
  assert.notEqual(signature(avant), signature(arrive));
  assert.notEqual(signature(arrive), signature(interroge));
});

test('l’ordre de la liste ne change pas la signature', () => {
  const a = { ieee: '0x0002', nom_z2m: 'a', type: 'capteur', modele: null };
  const b = { ieee: '0x0003', nom_z2m: 'b', type: 'prise', modele: null };
  assert.equal(signature([a, b]), signature([b, a]));
});
