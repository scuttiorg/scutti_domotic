import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'format HH:MM');
const setpoint = z.number().min(5).max(30);

export const siteInput = z.object({
  name: z.string().min(1).max(60),
}).strict();

export const roomInput = z.object({
  site_id: z.number().int().positive(),
  name: z.string().min(1).max(60),
  sensor_name: z.string().min(1).max(100),
  plug_name: z.string().min(1).max(100),
  default_setpoint: setpoint.default(17),
  hysteresis: z.number().min(0.2).max(3).default(0.5),
  enabled: z.boolean().default(true),
}).strict();

export const roomModeInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('auto') }),
  z.object({
    mode: z.literal('manual'),
    manual_setpoint: setpoint,
    manual_until: z.string().datetime().nullable().default(null),
  }),
]);

export const ruleInput = z.object({
  room_id: z.number().int().positive(),
  name: z.string().min(1).max(60),
  priority: z.number().int().min(0).max(100).default(10),
  enabled: z.boolean().default(true),
  days: z.array(z.number().int().min(1).max(7)).min(1),
  time_from: hhmm,
  time_to: hhmm,
  setpoint,
}).strict();

const H24 = 24 * 3_600_000;
const recentDate = z.string().datetime().refine((iso) => {
  const t = Date.parse(iso);
  return t <= Date.now() + 5 * 60_000 && t >= Date.now() - H24;
}, 'horodatage hors plage (max 24 h dans le passé, 5 min dans le futur)');

export const readingsInput = z.object({
  readings: z.array(z.object({
    room_id: z.number().int().positive(),
    temperature: z.number().min(-30).max(60).nullable(),
    humidity: z.number().min(0).max(100).nullable(),
    heating: z.boolean(),
    setpoint: setpoint.nullable(),
    measured_at: recentDate,
  })).min(1).max(100),
}).strict();

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const historyQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
}).strict();
