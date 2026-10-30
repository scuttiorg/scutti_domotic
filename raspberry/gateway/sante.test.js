import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  causeDuDemarrage, relanceZigbeeDue, wifiDbm, etatMiseAJour, lireCycle, ecrireCycle, deposerDemande,
  SILENCE_AVANT_RELANCE_MS, ENTRE_DEUX_RELANCES_MS, ENTRE_DEUX_RELANCES_MAX_MS,
} from './sante.js';

// ── Pourquoi le boîtier a démarré ───────────────────────────────────────────

const boot = 'b-2';
const boitierLe = Date.parse('2026-10-30T11:53:40Z');
const avant = (cycle) => ({ boot_id: 'b-1', version: 'v1', demarre_le: '2026-10-29T14:55:39Z', ...cycle });
const cause = (precedent, autre = {}) =>
  causeDuDemarrage({ precedent, bootId: boot, version: 'v1', boitierLe, reseauLe: null, ...autre });

test('premier démarrage : installation', () => assert.equal(cause(null), 'installation'));

test('le 30/10 : éteint sans arrêt propre, puis rallumé → coupure de courant', () =>
  assert.equal(cause(avant({ arret_le: null })), 'coupure'));

test('arrêt propre puis nouveau démarrage du système → redémarrage demandé', () =>
  assert.equal(cause(avant({ arret_le: '2026-10-30T09:00:00Z' })), 'redemarrage'));

test('redémarré par le chien de garde du réseau juste avant ce démarrage', () => {
  const reseauLe = boitierLe - 90_000;
  assert.equal(cause(avant({ arret_le: '2026-10-30T11:52:00Z' }), { reseauLe }), 'reseau');
  // Un redémarrage du réseau d'il y a trois jours n'explique rien.
  assert.equal(cause(avant({ arret_le: '2026-10-30T11:52:00Z' }), { reseauLe: boitierLe - 3 * 86_400_000 }), 'redemarrage');
});

test('même démarrage du système : la passerelle seule a redémarré', () => {
  assert.equal(cause(avant({ boot_id: boot, arret_le: '2026-10-30T12:00:00Z' })), 'relance');
  assert.equal(cause(avant({ boot_id: boot, version: 'v0', arret_le: '2026-10-30T12:00:00Z' })), 'mise_a_jour');
  // Aucun arrêt noté : elle est tombée, systemd l'a relancée.
  assert.equal(cause(avant({ boot_id: boot, arret_le: null })), 'plantage');
});

// ── Relancer Zigbee2MQTT et Mosquitto ───────────────────────────────────────

const t = 100 * 3600_000;
const sain = { mqtt: true, mqttDepuis: 0, zigbee: true, zigbeeDepuis: 0 };
const jamais = { derniere: null, suite: 0 };

test('tout répond : aucune relance', () => assert.equal(relanceZigbeeDue(sain, jamais, t), false));

test('Zigbee hors ligne depuis dix minutes : relance', () => {
  const hors = { ...sain, zigbee: false, zigbeeDepuis: t - SILENCE_AVANT_RELANCE_MS };
  assert.equal(relanceZigbeeDue(hors, jamais, t), true);
  assert.equal(relanceZigbeeDue({ ...hors, zigbeeDepuis: t - 60_000 }, jamais, t), false);
});

test('Zigbee muet depuis le démarrage compte comme hors ligne', () =>
  assert.equal(relanceZigbeeDue({ ...sain, zigbee: null, zigbeeDepuis: t - SILENCE_AVANT_RELANCE_MS }, jamais, t), true));

test('MQTT coupé : c’est lui qui compte, Zigbee n’en dit plus rien', () => {
  const coupe = { ...sain, mqtt: false, mqttDepuis: t - SILENCE_AVANT_RELANCE_MS };
  assert.equal(relanceZigbeeDue(coupe, jamais, t), true);
  assert.equal(relanceZigbeeDue({ ...coupe, mqttDepuis: t - 1000 }, jamais, t), false);
});

test('les relances sans effet s’espacent : 30 min, 1 h, 2 h… jusqu’à 6 h', () => {
  const hors = { ...sain, zigbee: false, zigbeeDepuis: 0 };
  const apres = (suite, attente) => relanceZigbeeDue(hors, { derniere: t - attente, suite }, t);
  assert.equal(apres(1, ENTRE_DEUX_RELANCES_MS - 1), false);
  assert.equal(apres(1, ENTRE_DEUX_RELANCES_MS), true);
  assert.equal(apres(2, ENTRE_DEUX_RELANCES_MS), false);
  assert.equal(apres(2, 2 * ENTRE_DEUX_RELANCES_MS), true);
  assert.equal(apres(10, ENTRE_DEUX_RELANCES_MAX_MS - 1), false);
  assert.equal(apres(10, ENTRE_DEUX_RELANCES_MAX_MS), true);
});

// ── Ce que le système dit ───────────────────────────────────────────────────

test('le wifi se lit dans /proc/net/wireless, comme sur le boîtier', () => {
  const texte = `Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 wlan0: 0000   70.  -34.  -256        0      0      0      7      0        0`;
  assert.equal(wifiDbm(texte), -34);
  assert.equal(wifiDbm(texte.split('\n').slice(0, 2).join('\n')), null);
  assert.equal(wifiDbm(null), null);
});

test('la mise à jour : version, version refusée, dernière vérification ; le reste écarté', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'boitier-'));
  try {
    assert.deepEqual(etatMiseAJour(dossier), { version: null, version_refusee: null, verifiee_le: null, resultat: null });
    writeFileSync(join(dossier, 'VERSION'), `${'a'.repeat(40)}\n`);
    writeFileSync(join(dossier, 'VERSION_REFUSEE'), 'pas une version\n');
    writeFileSync(join(dossier, 'MAJ_ETAT'), '{"le":"2026-10-30T12:00:00Z","resultat":"a_jour"}\n');
    assert.deepEqual(etatMiseAJour(dossier), {
      version: 'a'.repeat(40), version_refusee: null, verifiee_le: '2026-10-30T12:00:00Z', resultat: 'a_jour',
    });
    writeFileSync(join(dossier, 'MAJ_ETAT'), 'abîmé');
    assert.equal(etatMiseAJour(dossier).resultat, null);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('le cycle s’écrit et se relit ; illisible, il vaut une première fois', () => {
  const dossier = mkdtempSync(join(tmpdir(), 'boitier-'));
  try {
    const fichier = join(dossier, 'cycle.json');
    assert.equal(lireCycle(fichier), null);
    ecrireCycle(fichier, { boot_id: 'b', arret_le: null });
    assert.deepEqual(lireCycle(fichier), { boot_id: 'b', arret_le: null });
    writeFileSync(fichier, '{');
    assert.equal(lireCycle(fichier), null);
    assert.equal(deposerDemande(dossier, 'zigbee'), true);
    assert.ok(readFileSync(join(dossier, 'demande-zigbee'), 'utf8'));
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});
