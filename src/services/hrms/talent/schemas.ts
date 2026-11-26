import { z } from 'zod';

// Request validation for the Talent API (phase 12). zod checks TYPES / ranges; the plain-sentence rules whose words the
// dashboard already has ("Pick a level from 0 to 4.", "Give a short reason (at least 5 characters)...", "Write a rationale
// of at least 10 characters...") are applied in the service so the reason is the dashboard's, unprefixed. So `note`,
// `reason`, `rationale` are optional here and the length rule runs in the service.

const uuid = z.string().uuid('Must be an id');
const readiness = z.enum(['now', '1-2y', '3y+']);

export const setRating = z.object({
  employee_id: uuid,
  skill_id: z.string().min(1, 'Pick a skill').max(40, 'Too long'),
  level: z.number(),
  note: z.string().max(2000, 'Too long').optional(),
  assessor: z.string().max(200, 'Too long').optional(),
});

export const addSuccessor = z.object({
  employee_id: uuid,
  readiness,
  actions: z.array(z.string().max(400, 'Too long')).max(20, 'Too many actions').optional(),
  reason: z.string().max(1000, 'Too long').optional(),
});

export const successorRef = z.object({ employee_id: uuid, reason: z.string().max(1000, 'Too long').optional() });

export const setReadiness = z.object({ employee_id: uuid, readiness, reason: z.string().max(1000, 'Too long').optional() });

export const placeEmployee = z.object({
  employee_id: uuid,
  performance: z.number(),
  potential: z.number(),
  rationale: z.string().max(2000, 'Too long').optional(),
});

export const clearPlacement = z.object({ employee_id: uuid });

export const reviewOpened = z.object({ group: z.string().max(200, 'Too long').optional() });
