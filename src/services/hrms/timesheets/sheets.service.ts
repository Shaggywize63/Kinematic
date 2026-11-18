import { db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound, now } from '../payroll/common';
import { linesOut, sheetOut } from './mapping';
import { isEditable, isMonday, lineTotal, SheetLine, SheetStatus, submitReasons, todayIst } from './engine';
import { loadConfig, policyOf, trackedOf } from './config.service';
import { listProjects } from './projects.service';

// One timesheet per person per week (unique org + employee + week_start). Mirrors the dashboard's timesheetActions:
//  - saveLines is setHours / addProjectRow / removeProjectRow in one call: the dashboard sends the whole draft week.
//    Only an editable week (draft / returned) changes; a row with hours cannot be dropped; every project must be in the
//    list (an archived one only if it was already on the week); the person must track time.
//  - submit reproduces submitCheck (some hours, 0.25 h steps, no future day, no day above the daily limit) against
//    today in India, and appends to the trail.
//  - decide: only a submitted week; a return needs a comment of at least 5 characters; approve locks the week.
// Every status change is a conditional update on the status it expects, so a second click or a race changes nothing.

const T = 'hrms_ts_sheets';
const EDITABLE: SheetStatus[] = ['draft', 'returned'];
const LOCKED = 'This week is locked.';

export async function listSheets(s: HrmsScope): Promise<Row[]> {
  return fetchAll<Row>((from, to) => scoped(db().from(T).select('*'), s).order('week_start', { ascending: true }).order('employee_id', { ascending: true }).range(from, to));
}

const findSheet = async (s: HrmsScope, employeeId: string, weekStart: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('employee_id', employeeId).eq('week_start', weekStart).maybeSingle()) as Row | null;

async function employeeName(s: HrmsScope, id: string): Promise<string | null> {
  const e = must(await scoped(db().from('hrms_employees').select('id, first_name, last_name'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
  return e ? `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || 'Employee' : null;
}

function weekParam(weekStart: string): string {
  if (!isMonday(weekStart)) throw invalid('Choose the Monday a week starts on.');
  return weekStart;
}

const trail = (row: Row | null): Row[] => (Array.isArray(row?.trail) ? (row!.trail as Row[]) : []);

export async function saveLines(s: HrmsScope, employeeId: string, weekStart: string, lines: SheetLine[]): Promise<Row> {
  weekParam(weekStart);
  if (!(await employeeName(s, employeeId))) throw notFound('Employee not found');
  const config = await loadConfig(s);
  if (!trackedOf(config).includes(employeeId)) throw invalid('This person does not track time.');

  const cur = await findSheet(s, employeeId, weekStart);
  if (cur && !isEditable(cur.status as SheetStatus)) throw invalid(LOCKED);

  // the rows: one per project, each project in the list (an archived one only if the week already had it)
  const projects = new Map((await listProjects(s)).map((p) => [String(p.id), p]));
  const had = new Set(linesOut(cur?.lines).map((l) => String(l.projectId)));
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.projectId)) throw invalid('That project is already on the sheet.');
    seen.add(l.projectId);
    const p = projects.get(l.projectId);
    if (!p || (p.archived && !had.has(l.projectId))) throw invalid('Choose a project from the list.');
  }
  // a row that has hours cannot be dropped (the dashboard's removeProjectRow rule)
  for (const old of linesOut(cur?.lines) as unknown as SheetLine[]) {
    if (!seen.has(old.projectId) && lineTotal(old) > 0) throw invalid('Set the hours on this row to 0 before removing it.');
  }

  const stored = lines.map((l) => ({ projectId: l.projectId, hours: l.hours.map((h) => Math.round(h * 100) / 100) }));
  if (cur) {
    const res = await scoped(db().from(T).update({ lines: stored, updated_at: now() }), s).eq('id', cur.id).in('status', EDITABLE).select('*');
    if (res.error) throw fail(res.error);
    const rows = (res.data ?? []) as Row[];
    if (!rows.length) throw invalid(LOCKED);   // submitted / approved in between
    return sheetOut(rows[0]!);
  }
  const res = await db().from(T).insert({ ...scopeCols(s), employee_id: employeeId, week_start: weekStart, lines: stored, status: 'draft', trail: [] }).select('*').single();
  if (res.error) {
    if (isUniqueViolation(res.error)) return saveLines(s, employeeId, weekStart, lines);   // created in between: update it instead
    throw fail(res.error);
  }
  return sheetOut(res.data as Row);
}

export async function submit(s: HrmsScope, employeeId: string, weekStart: string): Promise<Row> {
  weekParam(weekStart);
  const name = await employeeName(s, employeeId);
  if (!name) throw notFound('Employee not found');
  const cur = await findSheet(s, employeeId, weekStart);
  if (!cur) throw invalid('Enter some hours before submitting.');
  const today = todayIst();
  const reasons = submitReasons({ lines: linesOut(cur.lines) as unknown as SheetLine[], weekStart, status: cur.status as SheetStatus }, policyOf(await loadConfig(s)), today);
  if (reasons.length) throw invalid(reasons[0]!);
  const res = await scoped(db().from(T).update({
    status: 'submitted', submitted_on: today, decided_on: null, decided_by: null, comment: null,
    trail: [...trail(cur), { at: today, by: name, action: 'Submitted' }], updated_at: now(),
  }), s).eq('id', cur.id).in('status', EDITABLE).select('*');
  if (res.error) throw fail(res.error);
  const rows = (res.data ?? []) as Row[];
  if (!rows.length) throw invalid('This week is already with the approver.');
  return sheetOut(rows[0]!);
}

export async function decide(s: HrmsScope, employeeId: string, weekStart: string, decision: 'approved' | 'returned', comment: string): Promise<Row> {
  weekParam(weekStart);
  const cur = await findSheet(s, employeeId, weekStart);
  if (!cur || cur.status !== 'submitted') throw invalid('Only a submitted week can be approved or returned.');
  const note = comment.trim();
  if (decision === 'returned' && note.length < 5) throw invalid('Say what to fix when returning a week (at least 5 characters).');
  const today = todayIst();
  const entry: Row = { at: today, by: s.actor, action: decision === 'approved' ? 'Approved' : 'Returned' };
  if (note) entry.comment = note;
  const res = await scoped(db().from(T).update({
    status: decision, decided_on: today, decided_by: s.actor, comment: note || null, trail: [...trail(cur), entry], updated_at: now(),
  }), s).eq('id', cur.id).eq('status', 'submitted').select('*');
  if (res.error) throw fail(res.error);
  const rows = (res.data ?? []) as Row[];
  if (!rows.length) throw invalid('Only a submitted week can be approved or returned.');
  return sheetOut(rows[0]!);
}
