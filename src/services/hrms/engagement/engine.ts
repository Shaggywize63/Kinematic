// Engagement rules that run on the server with the same words as the dashboard's engagementEngine.ts /
// engagementActions.ts. Pure functions, no database access.

export { todayIst } from '../timesheets/engine';

export type QType = 'rating' | 'yesno' | 'text';
export const Q_TYPES: ReadonlySet<QType> = new Set<QType>(['rating', 'yesno', 'text']);

export type AnswerValue = number | boolean | string;

export interface SurveyQuestionInput { text: string; type: QType }
export interface SurveyQuestion { id: string; type: QType; text: string }

/** Validate a pulse a person is building — the dashboard's validateSurvey, same order and words. */
export function validateSurvey(title: string, questions: SurveyQuestionInput[]): string[] {
  const problems: string[] = [];
  if (title.trim().length < 3) problems.push('Give the pulse a name.');
  if (questions.length === 0) problems.push('Add at least one question.');
  if (questions.length > 5) problems.push('A pulse has at most 5 questions.');
  questions.forEach((q, i) => { if (q.text.trim().length < 5) problems.push(`Question ${i + 1} needs some text.`); });
  return problems;
}

/** Give the questions their ids (q1, q2, ...), trimming the text — exactly as the dashboard's sendPulse does. */
export const numberQuestions = (questions: SurveyQuestionInput[]): SurveyQuestion[] =>
  questions.map((q, i) => ({ id: `q${i + 1}`, type: q.type, text: q.text.trim() }));

/**
 * Clean the answers a response carries to the question type, the dashboard's submitResponse rules:
 *  - rating: a whole number 1..5;
 *  - yesno: a boolean;
 *  - text: a non-empty string, trimmed, at most 400 characters.
 * Anything else for a question is dropped. The caller refuses a response that ends up empty.
 */
export function cleanAnswers(questions: SurveyQuestion[], answers: Record<string, unknown>): Record<string, AnswerValue> {
  const clean: Record<string, AnswerValue> = {};
  for (const q of questions) {
    const v = answers[q.id];
    if (q.type === 'rating' && typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 5) clean[q.id] = Math.round(v);
    else if (q.type === 'yesno' && typeof v === 'boolean') clean[q.id] = v;
    else if (q.type === 'text' && typeof v === 'string' && v.trim()) clean[q.id] = v.trim().slice(0, 400);
  }
  return clean;
}

export const EXIT_RETURNS: ReadonlySet<string> = new Set(['yes', 'maybe', 'no']);
