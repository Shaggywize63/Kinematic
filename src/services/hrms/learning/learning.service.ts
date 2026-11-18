import crypto from 'crypto';
import { db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound, now } from '../payroll/common';
import { logger } from '../../../lib/logger';
import { STANDARD_COURSES } from './library';
import { assignmentOut, certificateOut, courseOut, logOut, reminderOut } from './mapping';
import {
  addDays, certificateExpiry, certificateNumber, currentAssignments, gradeQuiz, isLearner, lessonsOf, missingAssignments, normaliseAudience,
  type AsgKey, type Audience, type CourseRule, type Person, quizOf, refresherDue, todayIst, type QuizResult,
} from './engine';

// HRMS phase 10: Learning on the server. Mirrors the dashboard's lib/hrms/people/learningActions.ts with the same rules
// and words, against today in India:
//  - the catalogue starts empty; "load the standard library" adds the ten standard courses (by code, idempotent);
//  - "who it is for" (mandatory + audience + refresher interval) is edited per course; "Apply rules" creates the
//    assignments a mandatory rule calls for and nobody has made yet;
//  - a course is given to people by hand (anyone with it open is skipped);
//  - lessons are finished in order, the quiz is last and is MARKED HERE (never trusted from the browser); a pass issues
//    a certificate numbered per org;
//  - reminders are logged, not sent; a refresher is a new assignment for a certificate that is lapsing.
// Every step that moves an assignment is a conditional update on the state it expects, so a double click or two people
// acting at once cannot skip a lesson, count an attempt twice or issue two certificates. Every change is logged.

const C = 'hrms_learn_courses';
const A = 'hrms_learn_assignments';
const CE = 'hrms_learn_certificates';
const R = 'hrms_learn_reminders';
const L = 'hrms_learn_log';

const ALREADY_DONE = 'This course is already completed.';
const MOVED_ON = 'Someone else just changed this assignment. Open it again to see where it stands.';

/**
 * A time-ordered uuid (version 7 layout) for assignments. The dashboard picks the current assignment of a person and
 * course by assigned_on and then by id, so ids must sort in creation order: a refresher assigned on the same day as the
 * assignment it replaces then still counts as the current one, on both sides.
 */
export function timeOrderedUuid(at = Date.now()): string {
  const ts = Math.max(0, Math.floor(at)).toString(16).padStart(12, '0').slice(-12);
  const r = crypto.randomBytes(10).toString('hex');
  const variant = (8 + (parseInt(r[3]!, 16) & 3)).toString(16);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${r.slice(0, 3)}-${variant}${r.slice(4, 7)}-${r.slice(8, 20)}`;
}

// ───────────────────────────── reads ─────────────────────────────
export const listCourses = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(C).select('*'), s).order('created_at', { ascending: true }).order('code', { ascending: true }).range(from, to));
export const listAssignments = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(A).select('*'), s).order('assigned_on', { ascending: true }).order('id', { ascending: true }).range(from, to));
export const listCertificates = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(CE).select('*'), s).order('seq', { ascending: true }).range(from, to));
export const listReminders = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(R).select('*'), s).order('reminded_on', { ascending: false }).order('created_at', { ascending: false }).range(from, to));
export async function listLog(s: HrmsScope, limit = 100): Promise<Row[]> {
  return must(await scoped(db().from(L).select('*'), s).order('at', { ascending: false }).limit(limit)) as Row[];
}

const findCourse = async (s: HrmsScope, id: string): Promise<Row | null> => must(await scoped(db().from(C).select('*'), s).eq('id', id).maybeSingle()) as Row | null;
const findAssignment = async (s: HrmsScope, id: string): Promise<Row | null> => must(await scoped(db().from(A).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

async function mustCourse(s: HrmsScope, id: string): Promise<Row> {
  const c = await findCourse(s, id);
  if (!c) throw notFound('That course is not in the catalogue.');
  return c;
}
async function mustAssignment(s: HrmsScope, id: string): Promise<{ a: Row; c: Row }> {
  const a = await findAssignment(s, id);
  if (!a) throw notFound('That assignment is not on record.');
  return { a, c: await mustCourse(s, String(a.course_id)) };
}

const PEOPLE_COLS = 'id, first_name, last_name, status, department_id, designation_id, location_id';
async function listPeople(s: HrmsScope, ids?: string[]): Promise<Row[]> {
  if (ids && !ids.length) return [];
  return fetchAll<Row>((from, to) => {
    let q = scoped(db().from('hrms_employees').select(PEOPLE_COLS), s).is('deleted_at', null);
    if (ids) q = q.in('id', ids);
    return q.range(from, to);
  });
}
const nameOf = (e: Row | undefined | null): string => (e ? `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || 'Employee' : 'Employee');
const personOf = (e: Row): Person => ({ id: String(e.id), status: String(e.status), department_id: String(e.department_id), designation_id: String(e.designation_id), location_id: String(e.location_id) });
const keyOf = (a: Row): AsgKey => ({
  id: String(a.id), employee_id: String(a.employee_id), course_id: String(a.course_id), assigned_on: String(a.assigned_on).slice(0, 10),
  completed_on: a.completed_on ? String(a.completed_on).slice(0, 10) : null,
});
const ruleOf = (c: Row): CourseRule => ({ id: String(c.id), mandatory: !!c.mandatory, audience: normaliseAudience(c.audience), due_days: Number(c.due_days) || 30 });

/** Append to the activity log. The change itself has already been saved, so a failed log line is reported, not thrown. */
async function log(s: HrmsScope, action: string, detail?: string): Promise<void> {
  const res = await db().from(L).insert({ ...scopeCols(s), by_name: s.actor, action, detail: detail ?? null });
  if (res.error) logger.warn(`[hrms-learning] could not write the activity log (${action}): ${res.error.message}`);
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ───────────────────────────── bootstrap ─────────────────────────────
/** Everything Learning needs for the org in one call. `today` is the server's date in India, used by the dashboard for due / overdue / lapsed. */
export async function learningBootstrap(s: HrmsScope) {
  const [courses, assignments, certificates, reminders, entries] = await Promise.all([listCourses(s), listAssignments(s), listCertificates(s), listReminders(s), listLog(s)]);
  return {
    courses: courses.map(courseOut),
    assignments: assignments.map(assignmentOut),
    certificates: certificates.map(certificateOut),
    reminders: reminders.map(reminderOut),
    log: entries.map(logOut),
    today: todayIst(),
    server_time: new Date().toISOString(),
  };
}

// ───────────────────────────── catalogue ─────────────────────────────
/** Add the standard courses this org does not have yet (matched by code, case-insensitive). Running it again adds nothing. */
export async function loadLibrary(s: HrmsScope): Promise<{ added: number; courses: Row[] }> {
  const have = new Set((await listCourses(s)).map((c) => String(c.code).trim().toLowerCase()));
  const missing = STANDARD_COURSES.filter((c) => !have.has(c.code.toLowerCase()));
  if (missing.length) {
    const rows = missing.map((c) => ({
      ...scopeCols(s), code: c.code, title: c.title, category: c.category, mode: c.mode, duration_min: c.durationMin, summary: c.summary,
      mandatory: c.mandatory, audience: { departmentIds: [], designationIds: [], locationIds: [] }, refresher_months: c.refresherMonths,
      due_days: c.dueDays, owner: c.owner, lessons: c.lessons, quiz: c.quiz,
    }));
    const res = await db().from(C).insert(rows);
    if (res.error && !isUniqueViolation(res.error)) throw fail(res.error);   // a unique clash = loaded at the same moment elsewhere
    if (!res.error) await log(s, 'Standard courses added', plural(missing.length, 'course', 'courses'));
  }
  const after = await listCourses(s);
  return { added: Math.max(0, after.length - have.size), courses: after.map(courseOut) };
}

async function assertAudienceInOrg(s: HrmsScope, a: Audience): Promise<void> {
  const check = async (table: string, wanted: string[]) => {
    if (!wanted.length) return true;
    const rows = await fetchAll<Row>((from, to) => scoped(db().from(table).select('id'), s).in('id', wanted).range(from, to));
    const known = new Set(rows.map((r) => String(r.id)));
    return wanted.every((id) => known.has(id));
  };
  const ok = await Promise.all([check('hrms_departments', a.departmentIds), check('hrms_designations', a.designationIds), check('hrms_locations', a.locationIds)]);
  if (ok.includes(false)) throw invalid('Choose departments, designations and locations from this company.');
}

/** Change who a course is mandatory for (the dashboard's updateCourseRules). Existing assignments stay; "Apply rules" makes the new ones. */
export async function updateRules(s: HrmsScope, courseId: string, input: { mandatory: boolean; audience: Audience; refresher_months: number }): Promise<Row> {
  const m = input.refresher_months;
  if (!Number.isFinite(m) || m < 0 || m > 60) throw invalid('The refresher interval is between 0 and 60 months. Use 0 for a one-off course.');
  const course = await mustCourse(s, courseId);
  const audience = normaliseAudience(input.audience);
  await assertAudienceInOrg(s, audience);
  const res = await scoped(db().from(C).update({ mandatory: input.mandatory, audience, refresher_months: Math.round(m), updated_at: now() }), s).eq('id', courseId).select('*');
  if (res.error) throw fail(res.error);
  const rows = (res.data ?? []) as Row[];
  if (!rows.length) throw notFound('That course is not in the catalogue.');
  await log(s, 'Course rules changed', String(course.title));
  return courseOut(rows[0]!);
}

// ───────────────────────────── assigning ─────────────────────────────
const newAssignment = (s: HrmsScope, employeeId: string, course: Row, assignedOn: string, dueOn: string, source: 'rule' | 'manual' | 'refresher'): Row => ({
  ...scopeCols(s), id: timeOrderedUuid(), employee_id: employeeId, course_id: course.id, assigned_on: assignedOn, due_on: dueOn, source, steps_done: 0, attempts: 0,
});

async function insertAssignments(rows: Row[]): Promise<Row[]> {
  if (!rows.length) return [];
  const res = await db().from(A).insert(rows).select('*');
  if (res.error) throw fail(res.error);
  return (res.data ?? []) as Row[];
}

/** Give a course to people by hand (the dashboard's assignCourse). Anyone who already has it open is skipped. */
export async function assignCourse(s: HrmsScope, courseId: string, employeeIds: string[], dueOn?: string): Promise<{ created: number; skipped: number; assignments: Row[] }> {
  const wanted = [...new Set(employeeIds)];
  if (!wanted.length) throw invalid('Pick at least one person.');
  const course = await mustCourse(s, courseId);
  const today = todayIst();
  const due = dueOn ?? addDays(today, Number(course.due_days) || 30);
  if (due < today) throw invalid('Pick a due date that is today or later.');

  const people = await listPeople(s, wanted);
  if (people.length !== wanted.length) throw invalid('Choose people from this company.');
  if (people.some((p) => !isLearner(personOf(p)))) throw invalid('Choose people who are working here now. Joiners are given courses on their start date.');

  const theirs = await fetchAll<Row>((from, to) => scoped(db().from(A).select('id, employee_id, course_id, assigned_on, completed_on'), s).eq('course_id', courseId).in('employee_id', wanted).range(from, to));
  const open = new Set(currentAssignments(theirs.map(keyOf)).filter((a) => !a.completed_on).map((a) => a.employee_id));
  const fresh = wanted.filter((id) => !open.has(id));
  const made = await insertAssignments(fresh.map((id) => newAssignment(s, id, course, today, due, 'manual')));
  if (made.length) await log(s, 'Course assigned', `${course.title} to ${plural(made.length, 'person', 'people')}`);
  return { created: made.length, skipped: wanted.length - fresh.length, assignments: made.map(assignmentOut) };
}

/** Create the assignments the mandatory rules call for and nobody has made yet (the dashboard's syncRuleAssignments). */
export async function applyRules(s: HrmsScope): Promise<{ created: number; assignments: Row[] }> {
  const [courses, people, rows] = await Promise.all([
    listCourses(s),
    listPeople(s),
    fetchAll<Row>((from, to) => scoped(db().from(A).select('id, employee_id, course_id, assigned_on'), s).range(from, to)),
  ]);
  const byId = new Map(courses.map((c) => [String(c.id), c]));
  const missing = missingAssignments(courses.map(ruleOf), people.map(personOf), rows.map(keyOf));
  if (!missing.length) return { created: 0, assignments: [] };
  const today = todayIst();
  const made = await insertAssignments(missing.map((m) => {
    const course = byId.get(m.course_id)!;
    return newAssignment(s, m.employee_id, course, today, addDays(today, Number(course.due_days) || 30), 'rule');
  }));
  await log(s, 'Rules applied', `${plural(made.length, 'assignment', 'assignments')} created`);
  return { created: made.length, assignments: made.map(assignmentOut) };
}

// ───────────────────────────── taking a course ─────────────────────────────
/**
 * Finish the next lesson (the dashboard's completeLesson). `expected` is the number of lessons the caller saw done: a
 * repeated click for the same lesson changes nothing instead of skipping the next one.
 */
export async function completeLesson(s: HrmsScope, assignmentId: string, expected?: number): Promise<Row> {
  const { a, c } = await mustAssignment(s, assignmentId);
  if (a.completed_on) throw invalid(ALREADY_DONE);
  const done = Number(a.steps_done) || 0;
  if (expected !== undefined && expected !== done) return assignmentOut(a);
  if (done >= lessonsOf(c.lessons).length) throw invalid('Every lesson is done. The quiz is next.');
  const res = await scoped(db().from(A).update({ steps_done: done + 1, updated_at: now() }), s)
    .eq('id', assignmentId).eq('steps_done', done).is('completed_on', null).select('*');
  if (res.error) throw fail(res.error);
  const rows = (res.data ?? []) as Row[];
  if (!rows.length) return assignmentOut((await findAssignment(s, assignmentId)) ?? a);
  return assignmentOut(rows[0]!);
}

/** The org's next certificate number. A clash with a number issued at the same moment is retried by the caller. */
async function nextSeq(s: HrmsScope): Promise<number> {
  const top = must(await scoped(db().from(CE).select('seq'), s).order('seq', { ascending: false }).limit(1)) as Row[];
  return (Number(top[0]?.seq) || 0) + 1;
}

/**
 * Mark the answers (the dashboard's submitQuiz). 70% or more completes the course and issues a certificate. The
 * answers are marked here against the stored quiz; the browser only sends which option was picked.
 */
export async function submitQuiz(s: HrmsScope, assignmentId: string, answers: (number | null)[]): Promise<{ result: QuizResult; assignment: Row; certificate: Row | null }> {
  const { a, c } = await mustAssignment(s, assignmentId);
  if (a.completed_on) throw invalid(ALREADY_DONE);
  const lessons = lessonsOf(c.lessons);
  if ((Number(a.steps_done) || 0) < lessons.length) throw invalid('Finish the lessons before the quiz.');
  const quiz = quizOf(c.quiz);
  if (!quiz.length) throw invalid('This course has no quiz to submit.');
  if (answers.length !== quiz.length || answers.some((x) => x === null || x === undefined)) throw invalid(`Answer all ${quiz.length} questions to submit.`);
  if (answers.some((x, i) => (x as number) >= quiz[i]!.options.length)) throw invalid('Choose one of the options for each question.');

  const result = gradeQuiz(quiz, answers);
  const today = todayIst();
  const attempts = Number(a.attempts) || 0;
  const person = (await listPeople(s, [String(a.employee_id)]))[0];

  // Count the attempt (and, on a pass, complete the course) only if nobody else has since.
  const patch: Row = { attempts: attempts + 1, updated_at: now() };
  if (result.passed) { patch.completed_on = today; patch.score = result.score; }
  const claim = await scoped(db().from(A).update(patch), s).eq('id', assignmentId).eq('attempts', attempts).is('completed_on', null).select('*');
  if (claim.error) throw fail(claim.error);
  const claimed = ((claim.data ?? []) as Row[])[0];
  if (!claimed) throw invalid(MOVED_ON);

  if (!result.passed) {
    await log(s, 'Quiz not passed', `${nameOf(person)}: ${c.title}, ${result.score}%`);
    return { result, assignment: assignmentOut(claimed), certificate: null };
  }

  // Issue the certificate. The number runs per org; a clash with one issued at the same moment takes the next.
  let cert: Row | null = null;
  for (let tries = 0; tries < 5 && !cert; tries++) {
    const seq = await nextSeq(s);
    const res = await db().from(CE).insert({
      ...scopeCols(s), seq, number: certificateNumber(seq, today), assignment_id: assignmentId, employee_id: a.employee_id, course_id: a.course_id,
      issued_on: today, expires_on: certificateExpiry(today, Number(c.refresher_months) || 0), score: result.score,
    }).select('*').single();
    if (!res.error) { cert = res.data as Row; break; }
    if (isUniqueViolation(res.error, 'assignment')) throw invalid(ALREADY_DONE);
    if (!isUniqueViolation(res.error)) {
      // put the assignment back so the person can submit again, then report the failure
      await scoped(db().from(A).update({ attempts, completed_on: null, score: null, updated_at: now() }), s).eq('id', assignmentId);
      throw fail(res.error);
    }
  }
  if (!cert) {
    await scoped(db().from(A).update({ attempts, completed_on: null, score: null, updated_at: now() }), s).eq('id', assignmentId);
    throw invalid('Could not number the certificate. Submit the answers again.');
  }
  const linked = await scoped(db().from(A).update({ certificate_no: cert.number, updated_at: now() }), s).eq('id', assignmentId).select('*');
  if (linked.error) throw fail(linked.error);
  await log(s, 'Course completed', `${nameOf(person)}: ${c.title}, ${result.score}%`);
  return { result, assignment: assignmentOut(((linked.data ?? []) as Row[])[0] ?? { ...claimed, certificate_no: cert.number }), certificate: certificateOut(cert) };
}

// ───────────────────────────── follow-up ─────────────────────────────
/** Log a reminder (the dashboard's sendReminder). Nothing is sent: there is no mail or message service behind it yet. */
export async function remind(s: HrmsScope, assignmentId: string): Promise<Row> {
  const { a, c } = await mustAssignment(s, assignmentId);
  if (a.completed_on) throw invalid(ALREADY_DONE);
  const res = await db().from(R).insert({
    ...scopeCols(s), assignment_id: assignmentId, employee_id: a.employee_id, course_id: a.course_id, reminded_on: todayIst(), reminded_by: s.actor,
  }).select('*').single();
  if (res.error) throw fail(res.error);
  const person = (await listPeople(s, [String(a.employee_id)]))[0];
  await log(s, 'Reminder logged (not sent)', `${nameOf(person)}: ${c.title}`);
  return reminderOut(res.data as Row);
}

/**
 * Start a refresher for a certificate (the dashboard's assignRefresher): due when the certificate lapses, or in 14 days
 * if it already has. Only for the person's latest certificate of that course, and not while a refresher is open.
 */
export async function assignRefresher(s: HrmsScope, certNumber: string): Promise<Row> {
  const cert = must(await scoped(db().from(CE).select('*'), s).eq('number', certNumber).maybeSingle()) as Row | null;
  if (!cert) throw notFound('That certificate is not on record.');
  const course = await mustCourse(s, String(cert.course_id));
  const person = (await listPeople(s, [String(cert.employee_id)]))[0];
  if (!person || !isLearner(personOf(person))) throw invalid('This person is not working here now.');

  const pairCerts = must(await scoped(db().from(CE).select('number, issued_on'), s).eq('employee_id', cert.employee_id).eq('course_id', cert.course_id)) as Row[];
  const latest = [...pairCerts].sort((x, y) => String(y.issued_on).localeCompare(String(x.issued_on)) || String(y.number).localeCompare(String(x.number)))[0];
  if (latest && latest.number !== cert.number) throw invalid('A newer certificate has replaced this one.');

  const pair = must(await scoped(db().from(A).select('id, employee_id, course_id, assigned_on, completed_on'), s).eq('employee_id', cert.employee_id).eq('course_id', cert.course_id)) as Row[];
  const cur = currentAssignments(pair.map(keyOf))[0];
  if (cur && !cur.completed_on) throw invalid('A refresher is already assigned.');

  const today = todayIst();
  const [made] = await insertAssignments([newAssignment(s, String(cert.employee_id), course, today, refresherDue(cert.expires_on ? String(cert.expires_on).slice(0, 10) : null, today), 'refresher')]);
  await log(s, 'Refresher assigned', `${nameOf(person)}: ${course.title}`);
  return assignmentOut(made!);
}
