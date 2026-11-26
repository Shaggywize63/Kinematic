import type { Row } from '../payroll/common';
import { type QType, Q_TYPES } from './engine';

// Rows -> the wire for Engagement. Pure functions, no database access. Top-level keys snake_case; a survey's questions and
// a response's answers pass through in the dashboard's own shapes, as the other phase mappings do. A value goes out under
// its stable key (the dashboard's CompanyValue.id IS the key).

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const qType = (v: unknown): QType => (Q_TYPES.has(v as QType) ? (v as QType) : 'text');

const questionsOf = (v: unknown): Row[] =>
  (Array.isArray(v) ? v : []).map((q, i) => ({ id: str((q as Row)?.id) || `q${i + 1}`, type: qType((q as Row)?.type), text: str((q as Row)?.text) }));

export const valueOut = (r: Row): Row => ({ id: str(r.key), name: str(r.name), blurb: str(r.blurb) });

export const surveyOut = (r: Row): Row => ({
  id: r.id,
  title: str(r.title),
  sent_on: iso(r.sent_on),
  closes_on: iso(r.closes_on),
  status: r.status === 'closed' ? 'closed' : 'open',
  questions: questionsOf(r.questions),
  updated_at: r.updated_at ?? null,
});

/** A response carries ONLY the team and the answers — never a person, never a usable time. */
export const responseOut = (r: Row): Row => ({
  id: r.id,
  survey_id: r.survey_id,
  team_id: str(r.team_id),
  answers: r.answers && typeof r.answers === 'object' ? r.answers : {},
});

export const kudosOut = (r: Row): Row => ({
  id: r.id,
  from_name: str(r.from_name),
  to_id: r.to_id,
  value_id: str(r.value_id),
  message: str(r.message),
  on: iso(r.on_date),
});

export const exitInterviewOut = (r: Row): Row => ({
  id: r.id,
  exit_id: r.exit_id ?? null,
  employee_id: r.employee_id ?? null,
  label: str(r.label),
  completed_on: iso(r.completed_on),
  reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [],
  would_return: r.would_return === 'yes' || r.would_return === 'maybe' || r.would_return === 'no' ? r.would_return : 'maybe',
  text: str(r.text),
  by: str(r.by_name),
});

export const logOut = (r: Row): Row => ({
  id: r.id,
  at: r.at ?? null,
  by: str(r.by_name),
  action: str(r.action),
  detail: r.detail ?? null,
});
