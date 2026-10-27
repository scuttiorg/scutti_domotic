import { randomBytes, createHash } from 'node:crypto';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/**
 * Accès base. Suppose `db` de type better-sqlite3 (prepare/get/all/run).
 * À adapter si scuti utilise un autre driver : seules ces 4 méthodes sont utilisées.
 */
export default function heatingService(db) {
  const q = (sql) => db.prepare(sql);

  const parseRule = (r) => ({ ...r, enabled: !!r.enabled, days: JSON.parse(r.days) });
  const parseRoom = (r) => ({ ...r, enabled: !!r.enabled });

  const sites = {
    list: () => q('SELECT id, name, created_at, last_seen FROM heating_sites ORDER BY name').all(),
    get: (id) => q('SELECT id, name, created_at, last_seen FROM heating_sites WHERE id = ?').get(id),
    /** Le token n'est renvoyé qu'ici, une seule fois. */
    create: ({ name }) => {
      const token = newToken();
      const { lastInsertRowid } = q('INSERT INTO heating_sites (name, token_hash) VALUES (?, ?)').run(name, hashToken(token));
      return { id: lastInsertRowid, name, token };
    },
    rotateToken: (id) => {
      const token = newToken();
      q('UPDATE heating_sites SET token_hash = ? WHERE id = ?').run(hashToken(token), id);
      return { id, token };
    },
    remove: (id) => q('DELETE FROM heating_sites WHERE id = ?').run(id).changes > 0,
    // Recherche par hash : la comparaison SQL sur un hash n'expose rien par timing.
    byToken: (token) => q('SELECT id, name FROM heating_sites WHERE token_hash = ?').get(hashToken(token)),
    touch: (id) => q("UPDATE heating_sites SET last_seen = datetime('now') WHERE id = ?").run(id),
  };

  const rooms = {
    list: () => q('SELECT * FROM heating_rooms ORDER BY site_id, name').all().map(parseRoom),
    get: (id) => {
      const r = q('SELECT * FROM heating_rooms WHERE id = ?').get(id);
      return r && parseRoom(r);
    },
    bySite: (siteId) => q('SELECT * FROM heating_rooms WHERE site_id = ?').all(siteId).map(parseRoom),
    create: (d) => {
      const { lastInsertRowid } = q(`
        INSERT INTO heating_rooms (site_id, name, sensor_name, plug_name, default_setpoint, hysteresis, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(d.site_id, d.name, d.sensor_name, d.plug_name, d.default_setpoint, d.hysteresis, +d.enabled);
      return rooms.get(lastInsertRowid);
    },
    update: (id, d) => {
      q(`UPDATE heating_rooms SET site_id=?, name=?, sensor_name=?, plug_name=?, default_setpoint=?, hysteresis=?, enabled=?
         WHERE id=?`)
        .run(d.site_id, d.name, d.sensor_name, d.plug_name, d.default_setpoint, d.hysteresis, +d.enabled, id);
      return rooms.get(id);
    },
    setMode: (id, m) => {
      q('UPDATE heating_rooms SET mode=?, manual_setpoint=?, manual_until=? WHERE id=?')
        .run(m.mode, m.manual_setpoint ?? null, m.manual_until ?? null, id);
      return rooms.get(id);
    },
    remove: (id) => q('DELETE FROM heating_rooms WHERE id = ?').run(id).changes > 0,
  };

  const rules = {
    byRoom: (roomId) => q('SELECT * FROM heating_rules WHERE room_id = ? ORDER BY priority, id').all(roomId).map(parseRule),
    get: (id) => {
      const r = q('SELECT * FROM heating_rules WHERE id = ?').get(id);
      return r && parseRule(r);
    },
    create: (d) => {
      const { lastInsertRowid } = q(`
        INSERT INTO heating_rules (room_id, name, priority, enabled, days, time_from, time_to, setpoint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(d.room_id, d.name, d.priority, +d.enabled, JSON.stringify(d.days), d.time_from, d.time_to, d.setpoint);
      return rules.get(lastInsertRowid);
    },
    update: (id, d) => {
      q(`UPDATE heating_rules SET room_id=?, name=?, priority=?, enabled=?, days=?, time_from=?, time_to=?, setpoint=?
         WHERE id=?`)
        .run(d.room_id, d.name, d.priority, +d.enabled, JSON.stringify(d.days), d.time_from, d.time_to, d.setpoint, id);
      return rules.get(id);
    },
    remove: (id) => q('DELETE FROM heating_rules WHERE id = ?').run(id).changes > 0,
  };

  const readings = {
    insertMany: (list) => {
      const stmt = q(`
        INSERT INTO heating_readings (room_id, temperature, humidity, heating, setpoint, measured_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      db.transaction((rows) => {
        for (const r of rows) stmt.run(r.room_id, r.temperature, r.humidity, +r.heating, r.setpoint, r.measured_at);
      })(list);
    },
    latest: (roomId) =>
      q('SELECT * FROM heating_readings WHERE room_id = ? ORDER BY measured_at DESC LIMIT 1').get(roomId) ?? null,
    history: (roomId, hours) =>
      q(`SELECT temperature, humidity, heating, setpoint, measured_at FROM heating_readings
         WHERE room_id = ? AND measured_at >= datetime('now', ?) ORDER BY measured_at`)
        .all(roomId, `-${hours} hours`),
  };

  /** Vue complète pour l'interface et la passerelle. */
  const roomWithDetails = (room) => ({
    ...room,
    rules: rules.byRoom(room.id),
    last: readings.latest(room.id),
  });

  return { sites, rooms, rules, readings, roomWithDetails };
}
