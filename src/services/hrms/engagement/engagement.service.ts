import { db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound, now } from '../payroll/common';
import { logger } from '../../../lib/logger';
import { STANDARD_VALUES } from './values';
import { exitInterviewOut, kudosOut, logOut, responseOut, surveyOut, valueOut } from './mapping';
import {
  type AnswerValue, cleanAnswers, EXIT_RETURNS, numberQuestions, type QType, type SurveyQuestion, type SurveyQuestionInput, todayIst, validateSurvey,
} from './engine';

// HRMS phase 11: Engagement on the server. Mirrors the dashboard's lib/hrms/people/engagementActions.ts with the same
// rules and words, against today in India:
//  - "Send a pulse" opens a survey (1..5 questions) for 14 days; nothing is emailed (a simulation);
//  - "take the survey" adds an ANONYMOUS, team-level response — only the team and the cleaned answers are kept;
//  - recognition names who is thanked, the value it shows and a message of 10+ characters;
//  - an exit interview is completed once per exit case.
// The catalogue of recognition values is seeded on first bootstrap. The exit case's "interview done" flag lives in the
// lifecycle area (already on the server) and is kept in step by the dashboard; this service only records the interview.

const V = 'hrms_eng_values';
const SU = 'hrms_eng_surveys';
const RE = 'hrms_eng_responses';
const KU = 'hrms_eng_kudos';
const EI = 'hrms_eng_exit_interviews';
const L = 'hrms_eng_log';

const PULSE_DAYS = 14;

/** today + n days, both YYYY-MM-DD, in UTC arithmetic (the dates are plain calendar days). */
function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ───────────────────────────── reads ─────────────────────────────
const listValues = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(V).select('*'), s).order('sort', { ascending: true }).order('created_at', { ascending: true }).range(from, to));
const listSurveys = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(SU).select('*'), s).order('sent_on', { ascending: true }).order('created_at', { ascending: true }).range(from, to));
const listResponses = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(RE).select('id, survey_id, team_id, answers, org_id'), s).order('created_at', { ascending: true }).range(from, to));
const listKudos = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(KU).select('*'), s).order('on_date', { ascending: false }).order('created_at', { ascending: false }).range(from, to));
const listExits = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(EI).select('*'), s).order('completed_on', { ascending: true }).order('created_at', { ascending: true }).range(from, to));
async function listLog(s: HrmsScope, limit = 100): Promise<Row[]> {
  return must(await scoped(db().from(L).select('*'), s).order('at', { ascending: false }).limit(limit)) as Row[];
}

const findSurvey = async (s: HrmsScope, id: string): Promise<Row | null> => must(await scoped(db().from(SU).select('*'), s).eq('id', id).maybeSingle()) as Row | null;
async function mustSurvey(s: HrmsScope, id: string): Promise<Row> {
  const r = await findSurvey(s, id);
  if (!r) throw notFound('Unknown pulse.');
  return r;
}

const questionsOf = (r: Row): SurveyQuestion[] =>
  (Array.isArray(r.questions) ? r.questions : []).map((q: Row, i: number) => ({ id: String(q?.id ?? `q${i + 1}`), type: (q?.type as QType), text: String(q?.text ?? '') }));

/** Append to the activity log. The change itself has already been saved, so a failed log line is reported, not thrown. */
async function log(s: HrmsScope, action: string, detail?: string): Promise<Row | null> {
  const res = await db().from(L).insert({ ...scopeCols(s), by_name: s.actor, action, detail: detail ?? null }).select('*').single();
  if (res.error) { logger.warn(`[hrms-engagement] could not write the activity log (${action}): ${res.error.message}`); return null; }
  return res.data as Row;
}

// ───────────────────────────── bootstrap ─────────────────────────────
/** Seed the standard recognition values this org does not have yet (matched by key). Running it again adds nothing. */
async function ensureValues(s: HrmsScope): Promise<Row[]> {
  const have = await listValues(s);
  const known = new Set(have.map((v) => String(v.key).trim().toLowerCase()));
  const missing = STANDARD_VALUES.filter((v) => !known.has(v.key.toLowerCase()));
  if (!missing.length) return have;
  const rows = missing.map((v, i) => ({ ...scopeCols(s), key: v.key, name: v.name, blurb: v.blurb, sort: have.length + i }));
  const res = await db().from(V).insert(rows);
  if (res.error && !isUniqueViolation(res.error)) throw fail(res.error);   // a unique clash = seeded at the same moment elsewhere
  return listValues(s);
}

/** Everything Engagement needs for the org in one call. `today` is the server's date in India, used by the dashboard. */
export async function engagementBootstrap(s: HrmsScope) {
  const values = await ensureValues(s);
  const [surveys, responses, kudos, exits, entries] = await Promise.all([listSurveys(s), listResponses(s), listKudos(s), listExits(s), listLog(s)]);
  return {
    values: values.map(valueOut),
    surveys: surveys.map(surveyOut),
    responses: responses.map(responseOut),
    kudos: kudos.map(kudosOut),
    exit_interviews: exits.map(exitInterviewOut),
    log: entries.map(logOut),
    today: todayIst(),
    server_time: new Date().toISOString(),
  };
}

// ───────────────────────────── pulses ─────────────────────────────
/** Send a new pulse (the dashboard's sendPulse). It opens today and closes in 14 days. Nothing is emailed. */
export async function sendPulse(s: HrmsScope, title: string, questions: SurveyQuestionInput[]): Promise<Row> {
  const problems = validateSurvey(title, questions);
  if (problems.length) throw invalid(problems[0]!);
  const today = todayIst();
  const res = await db().from(SU).insert({
    ...scopeCols(s), title: title.trim(), sent_on: today, closes_on: addDays(today, PULSE_DAYS), status: 'open', questions: numberQuestions(questions),
  }).select('*').single();
  if (res.error) throw fail(res.error);
  const survey = res.data as Row;
  await log(s, 'Pulse sent (simulation, nothing was emailed)', String(survey.title));
  return surveyOut(survey);
}

/** Close a pulse (the dashboard's closeSurvey). Idempotent: closing a closed pulse changes nothing. */
export async function closeSurvey(s: HrmsScope, surveyId: string): Promise<Row> {
  const survey = await mustSurvey(s, surveyId);
  if (survey.status === 'closed') return surveyOut(survey);
  const res = await scoped(db().from(SU).update({ status: 'closed', updated_at: now() }), s).eq('id', surveyId).eq('status', 'open').select('*');
  if (res.error) throw fail(res.error);
  const rows = (res.data ?? []) as Row[];
  if (rows.length) await log(s, 'Pulse closed', String(survey.title));
  return surveyOut(rows[0] ?? { ...survey, status: 'closed' });
}

/**
 * Add an anonymous response (the dashboard's submitResponse). Only the team is kept — no person, no usable time. The
 * answers are cleaned to each question's type; a response with nothing left is refused.
 */
export async function submitResponse(s: HrmsScope, surveyId: string, teamId: string, answers: Record<string, unknown>): Promise<Row> {
  const team = String(teamId ?? '').trim();
  if (!team) throw invalid('Pick a team.');
  const survey = await mustSurvey(s, surveyId);
  if (survey.status !== 'open') throw invalid('This pulse is closed.');
  const clean: Record<string, AnswerValue> = cleanAnswers(questionsOf(survey), answers);
  if (Object.keys(clean).length === 0) throw invalid('Answer at least one question.');
  const res = await db().from(RE).insert({ ...scopeCols(s), survey_id: surveyId, team_id: team.slice(0, 60), answers: clean }).select('id, survey_id, team_id, answers').single();
  if (res.error) throw fail(res.error);
  return responseOut(res.data as Row);
}

// ───────────────────────────── recognition ─────────────────────────────
const PEOPLE_COLS = 'id, first_name, last_name';
const nameOf = (e: Row | undefined | null): string => (e ? `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || 'Employee' : 'Employee');
async function findEmployee(s: HrmsScope, id: string): Promise<Row | null> {
  return must(await scoped(db().from('hrms_employees').select(PEOPLE_COLS), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
}

/** Post recognition (the dashboard's giveKudos). */
export async function giveKudos(s: HrmsScope, toId: string, valueId: string, message: string): Promise<Row> {
  if (!toId) throw invalid('Pick who you are thanking.');
  if (!valueId) throw invalid('Pick the value this shows.');
  if (message.trim().length < 10) throw invalid('Say what they did, in at least 10 characters.');
  const values = await ensureValues(s);
  if (!values.some((v) => String(v.key) === valueId)) throw invalid('Pick the value this shows.');
  const person = await findEmployee(s, toId);
  if (!person) throw invalid('Pick someone who works here.');
  const res = await db().from(KU).insert({
    ...scopeCols(s), from_name: s.actor, to_id: toId, value_id: valueId, message: message.trim().slice(0, 1000), on_date: todayIst(),
  }).select('*').single();
  if (res.error) throw fail(res.error);
  await log(s, 'Recognition posted', nameOf(person));
  return kudosOut(res.data as Row);
}

// ───────────────────────────── exit interviews ─────────────────────────────
export interface ExitInput { exit_id?: string; employee_id?: string; label?: string; reasons: string[]; would_return: string; text?: string }

/** Record a completed exit interview (the dashboard's completeExitInterview). One per exit case. */
export async function completeExitInterview(s: HrmsScope, input: ExitInput): Promise<Row> {
  const reasons = [...new Set((input.reasons ?? []).map((r) => String(r).trim()).filter(Boolean))];
  if (reasons.length === 0) throw invalid('Pick at least one reason.');
  if (reasons.length > 3) throw invalid('Pick up to three reasons.');
  if (!EXIT_RETURNS.has(input.would_return)) throw invalid('Say whether they would consider returning.');

  if (input.exit_id) {
    const existing = must(await scoped(db().from(EI).select('id'), s).eq('exit_id', input.exit_id).maybeSingle()) as Row | null;
    if (existing) throw invalid('This interview is already complete.');
  }
  const res = await db().from(EI).insert({
    ...scopeCols(s), exit_id: input.exit_id ?? null, employee_id: input.employee_id ?? null, label: (input.label ?? '').slice(0, 200),
    completed_on: todayIst(), reasons, would_return: input.would_return, text: (input.text ?? '').trim().slice(0, 4000), by_name: s.actor,
  }).select('*').single();
  if (res.error) {
    if (isUniqueViolation(res.error)) throw invalid('This interview is already complete.');
    throw fail(res.error);
  }
  await log(s, 'Exit interview completed', 'HR record');
  return exitInterviewOut(res.data as Row);
}

/**
 * Note in the activity log that an individual exit record was opened (the dashboard's logExitRecordOpened). The
 * person-level privacy access log is written by the dashboard against the already-live privacy area; this records only
 * the engagement-side line.
 */
export async function openExitRecord(s: HrmsScope, employeeId?: string): Promise<Row | null> {
  let who = 'Earlier leaver';
  if (employeeId) { const e = await findEmployee(s, employeeId); if (e) who = nameOf(e); }
  const entry = await log(s, 'Exit interview record opened', who);
  return entry ? logOut(entry) : null;
}
