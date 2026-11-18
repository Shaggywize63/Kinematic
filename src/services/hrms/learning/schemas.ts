import { z } from 'zod';

// Request validation for the Learning API (phase 10). zod checks TYPES / ranges; the plain-sentence rules whose words
// the dashboard already has ("Pick a due date that is today or later.", "The refresher interval is between 0 and 60
// months. ...", "Pick at least one person.") are applied in the services so the reason is the dashboard's, unprefixed.

const uuid = z.string().uuid('Must be an id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');

export const rulesSet = z.object({
  mandatory: z.boolean(),
  audience: z.object({
    departmentIds: z.array(uuid).max(500, 'Too many departments'),
    designationIds: z.array(uuid).max(500, 'Too many designations'),
    locationIds: z.array(uuid).max(500, 'Too many locations'),
  }),
  refresher_months: z.number({ invalid_type_error: 'Must be a number', required_error: 'Required' }).finite('Must be a number'),
});

export const assignSet = z.object({
  employee_ids: z.array(uuid).max(5000, 'Too many people'),
  due_on: isoDate.optional(),
});

/** The step being finished, so a repeated click does not skip a lesson. Optional for older callers. */
export const lessonDone = z.object({ steps_done: z.number().int().min(0).max(1000).optional() });

/** One answer per question: the index of the chosen option, or null for an unanswered one. */
export const quizAnswers = z.object({ answers: z.array(z.number().int().min(0).max(50).nullable()).max(200, 'Too many answers') });
