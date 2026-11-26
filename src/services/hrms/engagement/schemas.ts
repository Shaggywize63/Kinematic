import { z } from 'zod';

// Request validation for the Engagement API (phase 11). zod checks TYPES / ranges; the plain-sentence rules whose words
// the dashboard already has ("Give the pulse a name.", "Pick who you are thanking.", "Pick at least one reason.") are
// applied in the service so the reason is the dashboard's, unprefixed.

const uuid = z.string().uuid('Must be an id');

export const sendPulse = z.object({
  title: z.string().max(200, 'Too long'),
  questions: z.array(z.object({
    text: z.string().max(400, 'Too long'),
    type: z.enum(['rating', 'yesno', 'text']),
  })).max(50, 'Too many questions'),
});

/** An answer is a number, a boolean, a string or null (unanswered). The service cleans it to the question type. */
const answerValue = z.union([z.number(), z.boolean(), z.string(), z.null()]);
export const submitResponse = z.object({
  team_id: z.string().min(1, 'Pick a team').max(60, 'Too long'),
  answers: z.record(answerValue),
});

export const giveKudos = z.object({
  to_id: z.string().max(80, 'Too long'),
  value_id: z.string().max(40, 'Too long'),
  message: z.string().max(1000, 'Too long'),
});

export const completeExit = z.object({
  exit_id: uuid.optional(),
  employee_id: uuid.optional(),
  label: z.string().max(200, 'Too long').optional(),
  reasons: z.array(z.string().max(80)).max(20, 'Too many reasons'),
  would_return: z.string().max(10),
  text: z.string().max(4000, 'Too long').optional(),
});

export const openExit = z.object({ employee_id: uuid.optional() });
