import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pilotage, radiateursDe, nouveauForcage, forcageEnVigueur, prisesAllumees, memesPrises, radiateursForces,
  tropChaud, heureEnClair, resumeForcage, libelleDuree, DUREES_FORCAGE, FORCAGE_MAX_MINUTES, TEMPERATURE_MAX_FORCAGE,
} from './forcage.js';

// La salle : le radiateur de la fenêtre sur deux prises, celui de la porte
// sur la multiprise qu'il partage avec le premier, celui du fond seul.
const salle = {
  uuid: '11111111-2222-3333-4444-555555555555',
  prises: ['salle/prise-1', 'salle/multiprise', 'salle/fond'],
  radiateurs: [
    { nom: 'Fenêtre', prises: ['salle/prise-1', 'salle/multiprise'] },
    { nom: 'Porte', prises: ['salle/multiprise'] },
    { nom: 'Fond', prises: ['salle/fond'] },
  ],
};
const t0 = Date.parse('2026-10-29T13:00:00Z');
const dans = (minutes) => new Date(t0 + minutes * 60_000).toISOString();
const champ = (valeur, le = new Date(t0).toISOString()) => ({ valeur, le });

test('les garde-fous ont leurs valeurs : 30 min à 4 h, 28 °C', () => {
  assert.deepEqual(DUREES_FORCAGE, [30, 60, 120, 240]);
  assert.equal(FORCAGE_MAX_MINUTES, 240);
  assert.equal(TEMPERATURE_MAX_FORCAGE, 28);
});

test('les radiateurs de la pièce, ou une prise par radiateur pour un Scutti d’avant', () => {
  assert.deepEqual(radiateursDe(salle).map((r) => r.nom), ['Fenêtre', 'Porte', 'Fond']);
  assert.deepEqual(radiateursDe({ prises: ['a/p', 'b/p'] }), [{ nom: 'a/p', prises: ['a/p'] }, { nom: 'b/p', prises: ['b/p'] }]);
  assert.deepEqual(radiateursDe({ prise: 'a/p' }), [{ nom: 'a/p', prises: ['a/p'] }]);
  // Une prise que la pièce ne pilote plus ne se force pas.
  assert.deepEqual(radiateursDe({ ...salle, prises: ['salle/fond'] }), [{ nom: 'Fond', prises: ['salle/fond'] }]);
});

test('un forçage demandé : les prises des radiateurs cochés, une échéance absolue', () => {
  assert.deepEqual(nouveauForcage(salle, ['0'], 60, t0), {
    prises: ['salle/prise-1', 'salle/multiprise'], jusqua: dans(60),
  });
  assert.deepEqual(nouveauForcage(salle, [1, 0, 1], '30', t0).prises, ['salle/multiprise', 'salle/prise-1']);
});

test('refusé au-delà de quatre heures, pour une durée non proposée, ou sans radiateur', () => {
  assert.equal(nouveauForcage(salle, [0], 241, t0), null);
  assert.equal(nouveauForcage(salle, [0], 480, t0), null);
  assert.equal(nouveauForcage(salle, [0], 45, t0), null);
  assert.equal(nouveauForcage(salle, [0], 'n’importe', t0), null);
  assert.equal(nouveauForcage(salle, [], 60, t0), null);
  assert.equal(nouveauForcage(salle, [7, 'x', -1], 60, t0), null);
});

test('en vigueur jusqu’à son échéance, puis plus', () => {
  const f = champ({ prises: ['salle/fond'], jusqua: dans(30) });
  assert.deepEqual(forcageEnVigueur(f, salle, t0 + 29 * 60_000), { prises: ['salle/fond'], jusqua: dans(30) });
  assert.equal(forcageEnVigueur(f, salle, t0 + 30 * 60_000), null);
  assert.equal(forcageEnVigueur(champ(null), salle, t0), null);
  assert.equal(forcageEnVigueur(undefined, salle, t0), null);
  assert.equal(forcageEnVigueur(champ({ prises: 'salle/fond', jusqua: dans(30) }), salle, t0), null);
  assert.equal(forcageEnVigueur(champ({ prises: ['salle/fond'], jusqua: 'demain' }), salle, t0), null);
});

test('plus de quatre heures, d’où qu’il vienne, ne s’applique pas', () => {
  // Posé il y a une minute pour 4 h 30 : refusé.
  assert.equal(forcageEnVigueur(champ({ prises: ['salle/fond'], jusqua: dans(270) }, dans(-1)), salle, t0), null);
  // Sans date de pose lisible, l'échéance se juge depuis maintenant.
  assert.equal(forcageEnVigueur({ valeur: { prises: ['salle/fond'], jusqua: dans(300) } }, salle, t0), null);
  // Quatre heures pile, avec une horloge de Scutti en avance d'une minute : admis.
  assert.ok(forcageEnVigueur(champ({ prises: ['salle/fond'], jusqua: dans(241) }, dans(1)), salle, t0));
});

test('ne garde que les prises que la pièce pilote encore', () => {
  const f = champ({ prises: ['salle/fond', 'ailleurs/prise'], jusqua: dans(60) });
  assert.deepEqual(forcageEnVigueur(f, salle, t0).prises, ['salle/fond']);
  assert.equal(forcageEnVigueur(champ({ prises: ['ailleurs/prise'], jusqua: dans(60) }), salle, t0), null);
});

test('les prises allumées : les forcées, et toutes quand la régulation chauffe', () => {
  const forcage = { prises: ['salle/fond'], jusqua: dans(60) };
  assert.deepEqual(prisesAllumees(salle, false, forcage), ['salle/fond']);
  assert.deepEqual(prisesAllumees(salle, true, forcage), salle.prises);
  assert.deepEqual(prisesAllumees(salle, false, null), []);
  assert.deepEqual(prisesAllumees(salle, true, null), salle.prises);
  assert.ok(memesPrises(['a', 'b'], ['a', 'b']));
  assert.ok(!memesPrises(['a'], ['a', 'b']));
  assert.ok(memesPrises([], undefined));
});

test('au-dessus de 28 °C, trop chaud ; sans mesure, rien à dire', () => {
  assert.equal(tropChaud(28), false);
  assert.equal(tropChaud(28.1), true);
  assert.equal(tropChaud(null), false);
});

test('ce que l’écran dit d’un forçage', () => {
  // Forcer la fenêtre alimente aussi la porte, sur la même multiprise.
  const fenetre = { prises: ['salle/prise-1', 'salle/multiprise'], jusqua: '2026-10-29T14:30:00Z' };
  assert.equal(radiateursForces(salle, fenetre), 2);
  assert.equal(resumeForcage(salle, fenetre, 'Europe/Paris'), 'Chauffe forcée jusqu’à 15 h 30, 2 radiateurs');
  assert.equal(resumeForcage(salle, { prises: ['salle/fond'], jusqua: '2026-10-29T15:00:00Z' }, 'Europe/Paris'),
    'Chauffe forcée jusqu’à 16 h, 1 radiateur');
  assert.equal(heureEnClair('2026-10-29T08:05:00Z', 'Europe/Paris'), '9 h 05');
  assert.deepEqual(DUREES_FORCAGE.map(libelleDuree), ['30 min', '1 h', '2 h', '4 h']);
});

// ── Ce que la régulation fait des prises (pilotage) ─────────────────────────

const forcee = champ({ prises: ['salle/fond'], jusqua: dans(60) });
const etatSalle = (autre = {}) => ({ piece: salle, chauffe: false, temperature: 19, allumees: [], forceJusqua: null, ...autre });

test('un forçage qui commence : ses prises s’allument, les autres suivent la régulation, un relevé part', () => {
  const p = pilotage(etatSalle(), forcee, t0);
  assert.deepEqual(p.allumees, ['salle/fond']);
  assert.equal(p.forceJusqua, dans(60));
  assert.equal(p.commander, true);
  assert.equal(p.arreter, false);
  // Le même état au passage suivant : rien à commander.
  assert.equal(pilotage(etatSalle({ allumees: p.allumees, forceJusqua: p.forceJusqua }), forcee, t0 + 60_000).commander, false);
});

test('pendant le forçage, la régulation qui chauffe allume le reste, puis le rend', () => {
  const pendant = { allumees: ['salle/fond'], forceJusqua: dans(60) };
  assert.deepEqual(pilotage(etatSalle({ ...pendant, chauffe: true }), forcee, t0).allumees, salle.prises);
  const p = pilotage(etatSalle({ allumees: salle.prises, forceJusqua: dans(60), chauffe: false }), forcee, t0);
  assert.deepEqual(p.allumees, ['salle/fond']);
  assert.equal(p.commander, true);
});

test('à l’échéance, les prises forcées reprennent l’état de la pièce', () => {
  const pendant = { allumees: ['salle/fond'], forceJusqua: dans(60) };
  const apres = pilotage(etatSalle(pendant), forcee, t0 + 61 * 60_000);
  assert.deepEqual(apres.allumees, []);
  assert.equal(apres.forceJusqua, null);
  assert.equal(apres.commander, true);
  // La pièce chauffait de toute façon : rien ne s'éteint, mais la fin se dit.
  const chaude = pilotage(etatSalle({ allumees: salle.prises, forceJusqua: dans(60), chauffe: true }), forcee, t0 + 61 * 60_000);
  assert.deepEqual(chaude.allumees, salle.prises);
  assert.equal(chaude.commander, true);
});

test('« Arrêter » (le champ effacé) rend la régulation normale', () => {
  const p = pilotage(etatSalle({ allumees: ['salle/fond'], forceJusqua: dans(60) }), champ(null, dans(5)), t0 + 5 * 60_000);
  assert.deepEqual(p.allumees, []);
  assert.equal(p.commander, true);
});

test('au-dessus de 28 °C, le forçage s’arrête, même en cours', () => {
  const p = pilotage(etatSalle({ temperature: 28.2, allumees: ['salle/fond'], forceJusqua: dans(60) }), forcee, t0);
  assert.equal(p.arreter, true);
  assert.deepEqual(p.allumees, []);
  assert.equal(p.commander, true);
  // À 28 °C pile, il continue.
  assert.equal(pilotage(etatSalle({ temperature: 28 }), forcee, t0).arreter, false);
});

test('sans capteur vivant, le forçage est suspendu, pas effacé, et reprend avec la mesure', () => {
  const muet = pilotage(etatSalle({ temperature: null, allumees: ['salle/fond'], forceJusqua: dans(60) }), forcee, t0);
  assert.deepEqual(muet.allumees, []);
  assert.equal(muet.arreter, false);
  const retour = pilotage(etatSalle({ allumees: [], forceJusqua: null }), forcee, t0 + 60_000);
  assert.deepEqual(retour.allumees, ['salle/fond']);
});

test('après un redémarrage, un forçage rangé reprend avec son échéance d’origine', () => {
  // Rien n'a été commandé depuis le démarrage : allumees et forceJusqua absents.
  const p = pilotage({ piece: salle, chauffe: false, temperature: 19 }, forcee, t0 + 30 * 60_000);
  assert.deepEqual(p.allumees, ['salle/fond']);
  assert.equal(p.forceJusqua, dans(60));
  assert.equal(p.commander, true);
  // Une pièce neuve, sans forçage ni chauffe : rien à commander, comme avant.
  assert.equal(pilotage({ piece: salle, chauffe: false, temperature: 19 }, undefined, t0).commander, false);
});
