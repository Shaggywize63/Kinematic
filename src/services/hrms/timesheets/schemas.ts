import { z } from 'zod';

// Request validation for the Timesheets API (phase 9). zod checks TYPES / ranges; the plain-sentence rules whose words the
// dashboard already has ("This week is locked.", "Enter some hours before submitting.", "Mon: use steps of 0.25 hour.",
// the setPolicy ranges, "Say what to fix when returning a week ...") are applied in the services so the reason is the
// dashboard's, unprefixed.

const uuid = z.string().uuid('Must be an id');
const num = z.number({ invalid_type_error: 'Must be a number', required_error: 'Required' }).finite('Must be a number');
const hours = num.min(0, 'Must be zero or more').max(100000, 'Too large');

export const projectCreate = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1, 'Enter a project name').max(120, 'At most 120 characters'),
  client: z.string().trim().max(120, 'At most 120 characters').optional().default(''),
  kind: z.enum(['client', 'internal']),
  billable: z.boolean(),
  budget_hours: hours.optional().default(0),
  prior_hours: hours.optional().default(0),
  rate: num.min(0, 'Must be zero or more').max(1_000_000, 'Too large').optional().default(0),
});

export const projectUpdate = z.object({
  name: z.string().trim().min(1, 'Enter a project name').max(120, 'At most 120 characters').optional(),
  client: z.string().trim().max(120, 'At most 120 characters').optional(),
  kind: z.enum(['client', 'internal']).optional(),
  billable: z.boolean().optional(),
  budget_hours: hours.optional(),
  prior_hours: hours.optional(),
  rate: num.min(0, 'Must be zero or more').max(1_000_000, 'Too large').optional(),
  archived: z.boolean().optional(),
}).refine((o) => Object.values(o).some((v) => v !== undefined), 'Nothing to change');

export const policySet = z.object({
  max_per_day: num.optional(),
  weekly_cap: num.optional(),
  standard_week: num.optional(),
}).refine((o) => o.max_per_day !== undefined || o.weekly_cap !== undefined || o.standard_week !== undefined, 'Nothing to change');

export const trackedSet = z.object({ employee_ids: z.array(uuid).max(5000, 'Too many people') });

/** A draft week's lines: each a project and its seven days of hours. Hours are range-checked here; steps / future days /
 * the daily limit are the submit check, as on the dashboard (a draft may hold a value that is not submittable yet). */
export const linesSet = z.object({
  lines: z.array(z.object({
    projectId: uuid,
    hours: z.array(num.min(0, 'Hours must be a number from 0.').max(24, 'At most 24 hours in a day')).length(7, 'Seven days of hours'),
  })).max(50, 'At most 50 project rows'),
});

export const sheetDecide = z.object({
  decision: z.enum(['approved', 'returned']),
  comment: z.preprocess((v) => (v == null ? '' : v), z.string().max(2000, 'At most 2000 characters')),
});
