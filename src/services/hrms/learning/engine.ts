// HRMS phase 10 (Learning): the pure rules, reproduced from the dashboard's lib/hrms/people/learningEngine.ts so both
// sides agree on who must take what, which assignment is current, how a quiz is marked and how a certificate is
// numbered. No database access; "today" is always passed in.

export { todayIst } from '../timesheets/engine';

export const PASS_MARK = 70;
/** Days a refresher gets when the certificate it replaces has already lapsed. */
export const LAPSED_REFRESHER_DAYS = 14;

export interface Audience { departmentIds: string[]; designationIds: string[]; locationIds: string[] }
export interface Lesson { title: string; body: string }
export interface QuizQuestion { q: string; options: string[]; answer: number }

export const EVERYONE: Audience = { departmentIds: [], designationIds: [], locationIds: [] };

export function addDays(iso: string, n: number): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Add whole months, keeping the day where it exists and otherwise using the last day of the month (the dashboard's addMonthsISO). */
export function addMonthsISO(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : []);

/** A stored audience, whatever its shape: the three id lists, de-duplicated. */
export function normaliseAudience(v: unknown): Audience {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { departmentIds: ids(o.departmentIds), designationIds: ids(o.designationIds), locationIds: ids(o.locationIds) };
}

export interface Person { id: string; status: string; department_id: string; designation_id: string; location_id: string }

/** People who can be given training: working or serving notice. Joiners are assigned on their start date, leavers are done. */
export const isLearner = (e: Pick<Person, 'status'>): boolean => e.status === 'active' || e.status === 'on_notice';

export function inAudience(a: Audience, e: Pick<Person, 'department_id' | 'designation_id' | 'location_id'>): boolean {
  return (a.departmentIds.length === 0 || a.departmentIds.includes(e.department_id))
    && (a.designationIds.length === 0 || a.designationIds.includes(e.designation_id))
    && (a.locationIds.length === 0 || a.locationIds.includes(e.location_id));
}

export interface CourseRule { id: string; mandatory: boolean; audience: Audience; due_days: number }
/** People a rule makes the course compulsory for. Empty when the course is only recommended. */
export const requiredFor = (c: CourseRule, people: Person[]): Person[] => (c.mandatory ? people.filter((e) => isLearner(e) && inAudience(c.audience, e)) : []);

export interface AsgKey { id: string; employee_id: string; course_id: string; assigned_on: string; completed_on?: string | null }

/** The most recent assignment for each person and course (a refresher replaces the older one): the dashboard's rule. */
export function currentAssignments<T extends AsgKey>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const a of rows) {
    const k = `${a.employee_id}|${a.course_id}`;
    const cur = best.get(k);
    if (!cur || a.assigned_on > cur.assigned_on || (a.assigned_on === cur.assigned_on && a.id > cur.id)) best.set(k, a);
  }
  return [...best.values()];
}

/** Pairs the rules require that nobody has been assigned yet (any assignment, done or not, counts as made). */
export function missingAssignments(courses: CourseRule[], people: Person[], rows: AsgKey[]): { employee_id: string; course_id: string }[] {
  const have = new Set(rows.map((a) => `${a.employee_id}|${a.course_id}`));
  const out: { employee_id: string; course_id: string }[] = [];
  for (const c of courses) for (const e of requiredFor(c, people)) if (!have.has(`${e.id}|${c.id}`)) out.push({ employee_id: e.id, course_id: c.id });
  return out;
}

export interface QuizResult { correct: number; total: number; score: number; passed: boolean }
export function gradeQuiz(quiz: QuizQuestion[], answers: (number | null | undefined)[]): QuizResult {
  const total = quiz.length;
  const correct = quiz.reduce((t, q, i) => t + (answers[i] === q.answer ? 1 : 0), 0);
  const score = total ? Math.round((correct / total) * 100) : 0;
  return { correct, total, score, passed: score >= PASS_MARK };
}

/** CERT-2026-0007: the year of issue and the org's running number (the dashboard's certificateId). */
export const certificateNumber = (seq: number, issuedOn: string): string => `CERT-${issuedOn.slice(0, 4)}-${String(seq).padStart(4, '0')}`;

/** The certificate's expiry: the refresher interval after issue, or none for a one-off course. */
export const certificateExpiry = (issuedOn: string, refresherMonths: number): string | null => (refresherMonths > 0 ? addMonthsISO(issuedOn, refresherMonths) : null);

/** A refresher is due when the certificate lapses, or in 14 days if it already has (the dashboard's assignRefresher). */
export const refresherDue = (expiresOn: string | null | undefined, today: string): string =>
  (expiresOn && expiresOn > today ? expiresOn : addDays(today, LAPSED_REFRESHER_DAYS));

/** A stored lesson / question list, whatever its shape. */
export function lessonsOf(v: unknown): Lesson[] {
  return (Array.isArray(v) ? v : []).filter((l) => l && typeof l === 'object').map((l) => ({ title: String((l as Lesson).title ?? ''), body: String((l as Lesson).body ?? '') }));
}
export function quizOf(v: unknown): QuizQuestion[] {
  return (Array.isArray(v) ? v : []).filter((q) => q && typeof q === 'object').map((q) => {
    const o = q as QuizQuestion;
    return { q: String(o.q ?? ''), options: Array.isArray(o.options) ? o.options.map(String) : [], answer: Number.isInteger(o.answer) ? o.answer : 0 };
  });
}
