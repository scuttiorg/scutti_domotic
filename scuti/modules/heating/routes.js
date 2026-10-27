import rateLimit from '@fastify/rate-limit';
import heatingService from './service.js';
import * as s from './schema.js';

/**
 * Plugin Fastify.
 *
 *   app.register(heatingRoutes, {
 *     prefix: '/api/heating',
 *     db,
 *     requireUser: async (req, reply) => { ... },        // hook d'auth scuti : refuse si non connecté
 *     isAdmin:    (req) => req.user.role === 'admin',     // qui peut créer/modifier sites et pièces
 *   })
 *
 * Lecture + modes/règles : tout utilisateur connecté. Sites/pièces : admin.
 * Passerelles : token de site (Bearer), haché en base, rate-limité.
 */
export default async function heatingRoutes(app, { db, requireUser, isAdmin }) {
  const svc = heatingService(db);
  const parse = (schema, data) => schema.parse(data);
  const notFound = (reply) => reply.code(404).send({ error: 'Introuvable' });
  const requireAdmin = async (req, reply) => {
    if (!isAdmin(req)) reply.code(403).send({ error: 'Réservé aux administrateurs' });
  };

  // Zod → 400 propre, sans fuite de stack
  app.setErrorHandler((err, req, reply) => {
    if (err.name === 'ZodError') return reply.code(400).send({ error: 'Données invalides', issues: err.issues });
    req.log.error(err);
    reply.code(err.statusCode ?? 500).send({ error: err.statusCode ? err.message : 'Erreur interne' });
  });

  // ================= Utilisateurs =================
  app.register(async (user) => {
    user.addHook('onRequest', requireUser);

    // ---------- Sites (admin) ----------
    user.get('/sites', () => svc.sites.list());
    user.post('/sites', { onRequest: requireAdmin }, (req, reply) =>
      reply.code(201).send(svc.sites.create(parse(s.siteInput, req.body))));
    user.post('/sites/:id/rotate-token', { onRequest: requireAdmin }, (req, reply) => {
      const { id } = parse(s.idParam, req.params);
      return svc.sites.get(id) ? svc.sites.rotateToken(id) : notFound(reply);
    });
    user.delete('/sites/:id', { onRequest: requireAdmin }, (req, reply) =>
      svc.sites.remove(parse(s.idParam, req.params).id) ? reply.code(204).send() : notFound(reply));

    // ---------- Pièces ----------
    user.get('/rooms', () => svc.rooms.list().map(svc.roomWithDetails));
    user.get('/rooms/:id', (req, reply) => {
      const room = svc.rooms.get(parse(s.idParam, req.params).id);
      return room ? svc.roomWithDetails(room) : notFound(reply);
    });
    user.get('/rooms/:id/history', (req) =>
      svc.readings.history(parse(s.idParam, req.params).id, parse(s.historyQuery, req.query).hours));
    user.post('/rooms', { onRequest: requireAdmin }, (req, reply) =>
      reply.code(201).send(svc.rooms.create(parse(s.roomInput, req.body))));
    user.put('/rooms/:id', { onRequest: requireAdmin }, (req, reply) => {
      const { id } = parse(s.idParam, req.params);
      return svc.rooms.get(id) ? svc.rooms.update(id, parse(s.roomInput, req.body)) : notFound(reply);
    });
    user.delete('/rooms/:id', { onRequest: requireAdmin }, (req, reply) =>
      svc.rooms.remove(parse(s.idParam, req.params).id) ? reply.code(204).send() : notFound(reply));
    user.put('/rooms/:id/mode', (req, reply) => {
      const { id } = parse(s.idParam, req.params);
      return svc.rooms.get(id) ? svc.rooms.setMode(id, parse(s.roomModeInput, req.body)) : notFound(reply);
    });

    // ---------- Règles ----------
    user.post('/rules', (req, reply) => {
      const data = parse(s.ruleInput, req.body);
      return svc.rooms.get(data.room_id) ? reply.code(201).send(svc.rules.create(data)) : notFound(reply);
    });
    user.put('/rules/:id', (req, reply) => {
      const { id } = parse(s.idParam, req.params);
      return svc.rules.get(id) ? svc.rules.update(id, parse(s.ruleInput, req.body)) : notFound(reply);
    });
    user.delete('/rules/:id', (req, reply) =>
      svc.rules.remove(parse(s.idParam, req.params).id) ? reply.code(204).send() : notFound(reply));
  });

  // ================= Passerelles =================
  app.register(async (gw) => {
    await gw.register(rateLimit, { max: 60, timeWindow: '1 minute' });

    gw.addHook('onRequest', async (req, reply) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      req.site = token.length >= 32 ? svc.sites.byToken(token) : null;
      if (!req.site) return reply.code(401).send({ error: 'Token invalide' });
      svc.sites.touch(req.site.id);
    });

    gw.get('/config', (req) =>
      svc.rooms.bySite(req.site.id).map((room) => ({ ...room, rules: svc.rules.byRoom(room.id) })));

    gw.post('/readings', { bodyLimit: 64 * 1024 }, (req, reply) => {
      const { readings } = parse(s.readingsInput, req.body);
      const allowed = new Set(svc.rooms.bySite(req.site.id).map((r) => r.id));
      svc.readings.insertMany(readings.filter((r) => allowed.has(r.room_id)));
      reply.code(204).send();
    });
  }, { prefix: '/gateway' });
}
