import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reglagesManquants } from './rapports.js';

/** Un thermomètre tel que `bridge/devices` le décrit. */
const thermometre = (configured_reportings = []) => ({
  friendly_name: 'Thermomètre atelier',
  endpoints: {
    1: {
      clusters: { input: ['genBasic', 'genPowerCfg', 'msTemperatureMeasurement', 'msRelativeHumidity'], output: [] },
      configured_reportings,
    },
  },
});

const reglage = (cluster, reportable_change, maximum_report_interval) => ({
  cluster, attribute: 'measuredValue', minimum_report_interval: 10, maximum_report_interval, reportable_change,
});

test('un thermomètre d’usine : température et humidité à régler', () => {
  const manquants = reglagesManquants(thermometre());
  assert.deepEqual(manquants.map((m) => [m.id, m.endpoint, m.cluster, m.reportable_change, m.maximum_report_interval]), [
    ['Thermomètre atelier', 1, 'msTemperatureMeasurement', 25, 300],
    ['Thermomètre atelier', 1, 'msRelativeHumidity', 300, 300],
  ]);
});

test('déjà réglé comme il faut, ou mieux : rien à demander', () => {
  assert.deepEqual(reglagesManquants(thermometre([
    reglage('msTemperatureMeasurement', 25, 300),
    reglage('msRelativeHumidity', 100, 120),
  ])), []);
});

test('un seuil d’un demi-degré ou un intervalle d’une heure ne conviennent pas', () => {
  const manquants = reglagesManquants(thermometre([
    reglage('msTemperatureMeasurement', 50, 300),
    reglage('msRelativeHumidity', 300, 3600),
  ]));
  assert.equal(manquants.length, 2);
});

test('un intervalle maximal nul (pas de rapport périodique) ne convient pas', () => {
  const manquants = reglagesManquants(thermometre([reglage('msTemperatureMeasurement', 10, 0), reglage('msRelativeHumidity', 100, 300)]));
  assert.deepEqual(manquants.map((m) => m.cluster), ['msTemperatureMeasurement']);
});

test('une prise, ou un appareil sans description, n’a rien à régler', () => {
  assert.deepEqual(reglagesManquants({ friendly_name: 'Prise', endpoints: { 1: { clusters: { input: ['genOnOff'] } } } }), []);
  assert.deepEqual(reglagesManquants({ friendly_name: 'Muet' }), []);
  assert.deepEqual(reglagesManquants(undefined), []);
});

test('le cluster sur un autre endpoint que le premier', () => {
  const appareil = { friendly_name: 'Sonde', endpoints: { 2: { clusters: { input: ['msTemperatureMeasurement'] } } } };
  assert.deepEqual(reglagesManquants(appareil).map((m) => m.endpoint), [2]);
});
