import type { Row } from '../payroll/common';
import { lessonsOf, normaliseAudience, quizOf } from './engine';

// Rows -> the wire for Learning. Pure functions, no database access. Top-level keys snake_case; a course's audience,
// lessons and quiz pass through in the dashboard's own camelCase shapes, as the other phase mappings do with their
// nested shapes. A certificate goes out under its number (the dashboard's Certificate.id IS the number).

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const int = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v)));

export const courseOut = (r: Row): Row => ({
  id: r.id,
  code: str(r.code),
  title: str(r.title),
  category: r.category === 'skill' ? 'skill' : 'compliance',
  mode: r.mode === 'classroom' ? 'classroom' : 'self_paced',
  duration_min: int(r.duration_min),
  summary: str(r.summary),
  mandatory: !!r.mandatory,
  audience: normaliseAudience(r.audience),
  refresher_months: int(r.refresher_months),
  due_days: int(r.due_days),
  owner: str(r.owner),
  lessons: lessonsOf(r.lessons),
  quiz: quizOf(r.quiz),
  updated_at: r.updated_at ?? null,
});

export const assignmentOut = (r: Row): Row => ({
  id: r.id,
  employee_id: r.employee_id,
  course_id: r.course_id,
  assigned_on: iso(r.assigned_on),
  due_on: iso(r.due_on),
  source: r.source === 'rule' || r.source === 'refresher' ? r.source : 'manual',
  steps_done: int(r.steps_done),
  attempts: int(r.attempts),
  completed_on: iso(r.completed_on),
  score: r.score === null || r.score === undefined ? null : int(r.score),
  certificate_id: r.certificate_no ?? null,
});

export const certificateOut = (r: Row): Row => ({
  id: str(r.number),
  assignment_id: r.assignment_id,
  employee_id: r.employee_id,
  course_id: r.course_id,
  issued_on: iso(r.issued_on),
  expires_on: iso(r.expires_on),
  score: int(r.score),
});

export const reminderOut = (r: Row): Row => ({
  id: r.id,
  on: iso(r.reminded_on),
  by: str(r.reminded_by),
  employee_id: r.employee_id,
  course_id: r.course_id,
  assignment_id: r.assignment_id,
});

export const logOut = (r: Row): Row => ({
  id: r.id,
  at: r.at ? String(r.at) : null,
  by: str(r.by_name),
  action: str(r.action),
  detail: r.detail ?? null,
});
