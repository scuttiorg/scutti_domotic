/**
 * Logique pure, sans I/O : à partir d'une pièce (config + règles + mode),
 * d'une température et de l'état actuel du radiateur, décide on/off.
 */

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function ruleMatches(rule, date) {
  if (!rule.enabled) return false;
  const day = date.getDay() === 0 ? 7 : date.getDay(); // 1=lundi … 7=dimanche
  if (!rule.days.includes(day)) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const from = toMinutes(rule.time_from);
  const to = toMinutes(rule.time_to);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/** Retourne la consigne en vigueur (null = chauffage coupé). */
export function currentSetpoint(room, date = new Date()) {
  if (!room.enabled || room.mode === 'off') return null;

  if (room.mode === 'manual') {
    const expired = room.manual_until && new Date(room.manual_until) < date;
    if (!expired) return room.manual_setpoint;
  }

  const rule = [...room.rules]
    .sort((a, b) => a.priority - b.priority)
    .find((r) => ruleMatches(r, date));

  return rule ? rule.setpoint : room.default_setpoint;
}

/** Hystérésis : n'allume qu'en dessous de consigne−h/2, n'éteint qu'au-dessus de consigne+h/2. */
export function shouldHeat(room, temperature, heating, date = new Date()) {
  const setpoint = currentSetpoint(room, date);
  if (setpoint === null || temperature === null) return false;
  const half = (room.hysteresis ?? 0.5) / 2;
  if (temperature < setpoint - half) return true;
  if (temperature > setpoint + half) return false;
  return heating;
}
