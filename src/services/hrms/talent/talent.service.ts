import { db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound } from '../payroll/common';
import { logger } from '../../../lib/logger';
import { buildSeed, type SeedEmployee } from './library';
import { logOut, placementsOut, placementValue, ratingsOut, ratingValue, requirementsOut, roleOut, skillOut } from './mapping';
import {
  isNineLevel, LEVEL_LABEL, needReason, type NineLevel, type Readiness, READINESS_LABEL, todayIst, validateRating,
} from './engine';

// HRMS phase 12: Talent on the server. Mirrors the dashboard's lib/hrms/people/talentActions.ts with the same rules and
// words: skill ratings (1..4, a 3/4 needs an 8+ char evidence note), a succession bench per critical role (readiness,
// actions, a 5+ char reason, kept in the role's history) and 9-box placements (one per person, a 10+ char rationale).
//
// Populated demo: on the first bootstrap, while the org has no skills, the service seeds the standard 12-skill catalogue
// and a believable talent picture (requirements, ratings, critical roles with benches, placements) GENERATED against the
// org's REAL employees / designations — see library.ts. The skills row acts as the seed marker, so a second bootstrap (or
// a concurrent one) adds nothing.

const SK = 'hrms_talent_skills';
const RQ = 'hrms_talent_requirements';
const RT = 'hrms_talent_ratings';
const RO = 'hrms_talent_roles';
const SU = 'hrms_talent_successors';
const CH = 'hrms_talent_succession_changes';
const PL = 'hrms_talent_placements';
const ST = 'hrms_talent_settings';
const LG = 'hrms_talent_log';

const DEFAULT_CYCLE = 'FY 2026-27, first half';
const CYCLE_KEY = 'cycle';

// ───────────────────────────── reads ─────────────────────────────
const listSkills = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(SK).select('*'), s).order('sort', { ascending: true }).order('created_at', { ascending: true }).range(from, to));
const listRequirements = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(RQ).select('designation_id, skill_key, required_level'), s).range(from, to));
const listRatings = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(RT).select('employee_id, skill_key, level, note, by_name, on_date'), s).range(from, to));
const listRoles = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(RO).select('*'), s).order('created_at', { ascending: true }).range(from, to));
const listSuccessors = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(SU).select('*'), s).order('added_on', { ascending: true }).order('created_at', { ascending: true }).range(from, to));
const listChanges = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(CH).select('*'), s).order('on_date', { ascending: false }).order('created_at', { ascending: false }).range(from, to));
const listPlacements = (s: HrmsScope): Promise<Row[]> =>
  fetchAll<Row>((from, to) => scoped(db().from(PL).select('employee_id, performance, potential, rationale, by_name, on_date'), s).range(from, to));
async function listLog(s: HrmsScope, limit = 100): Promise<Row[]> {
  return must(await scoped(db().from(LG).select('*'), s).order('at', { ascending: false }).limit(limit)) as Row[];
}
async function getCycle(s: HrmsScope): Promise<string> {
  const r = must(await scoped(db().from(ST).select('value'), s).eq('key', CYCLE_KEY).maybeSingle()) as Row | null;
  return r ? String(r.value) : DEFAULT_CYCLE;
}

const roleSuccessors = (all: Row[], roleId: unknown): Row[] => all.filter((r) => r.role_id === roleId);

async function findRole(s: HrmsScope, id: string): Promise<Row | null> {
  return must(await scoped(db().from(RO).select('*'), s).eq('id', id).maybeSingle()) as Row | null;
}
async function mustRole(s: HrmsScope, id: string): Promise<Row> {
  const r = await findRole(s, id);
  if (!r) throw notFound('Unknown role.');
  return r;
}

async function employeeName(s: HrmsScope, id: string): Promise<string> {
  const e = must(await scoped(db().from('hrms_employees').select('first_name, last_name'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
  return e ? `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || 'Employee' : 'Employee';
}
async function employeeExists(s: HrmsScope, id: string): Promise<boolean> {
  const e = must(await scoped(db().from('hrms_employees').select('id'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
  return !!e;
}

/** Append to the activity log. The change itself is already saved, so a failed log line is reported, not thrown. */
async function log(s: HrmsScope, action: string, detail?: string): Promise<void> {
  const res = await db().from(LG).insert({ ...scopeCols(s), by_name: s.actor, action, detail: detail ?? null });
  if (res.error) logger.warn(`[hrms-talent] could not write the activity log (${action}): ${res.error.message}`);
}

/** The full wire shape of a role: its row plus its (ordered) successors and history. */
async function roleWire(s: HrmsScope, role: Row): Promise<Row> {
  const [succ, chg] = await Promise.all([
    scoped(db().from(SU).select('*'), s).eq('role_id', role.id).order('added_on', { ascending: true }).order('created_at', { ascending: true }),
    scoped(db().from(CH).select('*'), s).eq('role_id', role.id).order('on_date', { ascending: false }).order('created_at', { ascending: false }),
  ]);
  return roleOut(role, must(succ) as Row[], must(chg) as Row[]);
}

// ───────────────────────────── seed (populated demo) ─────────────────────────────
async function insertAll(table: string, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db().from(table).insert(rows.slice(i, i + 500));
    if (res.error && !isUniqueViolation(res.error)) throw fail(res.error);
  }
}

/** Seed the standard catalogue and a generated talent picture, once, while the org has no skills. Returns the skills. */
async function ensureSeeded(s: HrmsScope): Promise<Row[]> {
  const have = await listSkills(s);
  if (have.length) return have;

  const [employees, designations, departments] = await Promise.all([
    fetchAll<Row>((from, to) => scoped(db().from('hrms_employees').select('id, designation_id, department_id, location_id, join_date, status, reporting_to_id'), s).is('deleted_at', null).range(from, to)),
    fetchAll<Row>((from, to) => scoped(db().from('hrms_designations').select('id, name'), s).range(from, to)),
    fetchAll<Row>((from, to) => scoped(db().from('hrms_departments').select('id, name'), s).range(from, to)),
  ]);
  const deptNameById: Record<string, string> = {};
  for (const d of departments) deptNameById[String(d.id)] = String(d.name ?? '');
  const designationNameById: Record<string, string> = {};
  for (const d of designations) designationNameById[String(d.id)] = String(d.name ?? '');
  const seed = buildSeed({
    employees: employees.map((e): SeedEmployee => ({
      id: String(e.id), designation_id: e.designation_id ? String(e.designation_id) : null, department_id: e.department_id ? String(e.department_id) : null,
      location_id: e.location_id ? String(e.location_id) : null, join_date: e.join_date ? String(e.join_date) : null, status: String(e.status ?? ''),
      reporting_to_id: e.reporting_to_id ? String(e.reporting_to_id) : null,
    })),
    designationIds: designations.map((d) => String(d.id)),
    deptNameById,
    designationNameById,
  }, todayIst());

  // The skills row is the seed marker. If another request seeded first, the unique index refuses it and we stop.
  const skillRows = seed.skills.map((x) => ({ ...scopeCols(s), key: x.key, name: x.name, skill_group: x.skill_group, blurb: x.blurb, sort: x.sort }));
  const ins = await db().from(SK).insert(skillRows);
  if (ins.error) {
    if (isUniqueViolation(ins.error)) return listSkills(s);  // lost the race; someone else seeded
    throw fail(ins.error);
  }

  await insertAll(RQ, seed.requirements.map((r) => ({ ...scopeCols(s), designation_id: r.designation_id, skill_key: r.skill_key, required_level: r.required_level })));
  await insertAll(RT, seed.ratings.map((r) => ({ ...scopeCols(s), employee_id: r.employee_id, skill_key: r.skill_key, level: r.level, note: r.note, by_name: r.by_name, on_date: r.on_date })));
  await insertAll(PL, seed.placements.map((p) => ({ ...scopeCols(s), employee_id: p.employee_id, performance: p.performance, potential: p.potential, rationale: p.rationale, by_name: p.by_name, on_date: p.on_date })));
  await db().from(ST).insert({ ...scopeCols(s), key: CYCLE_KEY, value: seed.cycle });

  for (const role of seed.roles) {
    const res = await db().from(RO).insert({
      ...scopeCols(s), title: role.title, department_id: role.department_id, location_id: role.location_id, incumbent_id: role.incumbent_id,
      role_since: role.role_since, retirement_age: role.retirement_age, why: role.why,
    }).select('id').single();
    if (res.error) { logger.warn(`[hrms-talent] seed role insert failed: ${res.error.message}`); continue; }
    const roleId = (res.data as Row).id;
    await insertAll(SU, role.successors.map((x) => ({ ...scopeCols(s), role_id: roleId, employee_id: x.employee_id, readiness: x.readiness, actions: x.actions, added_on: x.added_on })));
    await insertAll(CH, role.changes.map((c) => ({ ...scopeCols(s), role_id: roleId, on_date: c.on_date, by_name: c.by_name, kind: c.kind, employee_id: c.employee_id, from_text: c.from_text, to_text: c.to_text, reason: c.reason })));
  }
  return listSkills(s);
}

// ───────────────────────────── bootstrap ─────────────────────────────
/** Everything Talent needs for the org in one call. `today` is the server's date in India, used by the dashboard. */
export async function talentBootstrap(s: HrmsScope) {
  const skills = await ensureSeeded(s);
  const [requirements, ratings, roles, successors, changes, placements, cycle, entries] = await Promise.all([
    listRequirements(s), listRatings(s), listRoles(s), listSuccessors(s), listChanges(s), listPlacements(s), getCycle(s), listLog(s),
  ]);
  return {
    skills: skills.map(skillOut),
    requirements: requirementsOut(requirements),
    ratings: ratingsOut(ratings),
    roles: roles.map((r) => roleOut(r, roleSuccessors(successors, r.id), roleSuccessors(changes, r.id))),
    placements: placementsOut(placements),
    cycle,
    log: entries.map(logOut),
    today: todayIst(),
    server_time: new Date().toISOString(),
  };
}

// ───────────────────────────── skills ─────────────────────────────
/** Set (or, at level 0, clear) a person's rating for a skill. The dashboard's setRating. */
export async function setRating(s: HrmsScope, employeeId: string, skillId: string, level: number, note: string, assessor?: string): Promise<Row> {
  const problem = validateRating(level, note);
  if (problem) throw invalid(problem);
  const skills = await ensureSeeded(s);
  const skill = skills.find((x) => String(x.key) === skillId);
  if (!skill) throw invalid('Unknown skill.');
  if (!(await employeeExists(s, employeeId))) throw invalid('Pick someone who works here.');

  const existing = must(await scoped(db().from(RT).select('level'), s).eq('employee_id', employeeId).eq('skill_key', skillId).maybeSingle()) as Row | null;
  const before = existing ? Number(existing.level) : 0;
  const del = await scoped(db().from(RT).delete(), s).eq('employee_id', employeeId).eq('skill_key', skillId);
  if (del.error) throw fail(del.error);

  let row: Row | null = null;
  if (level > 0) {
    const res = await db().from(RT).insert({
      ...scopeCols(s), employee_id: employeeId, skill_key: skillId, level, note: note.trim(), by_name: (assessor ?? '').trim() || s.actor, on_date: todayIst(),
    }).select('employee_id, skill_key, level, note, by_name, on_date').single();
    if (res.error) throw fail(res.error);
    row = res.data as Row;
  }
  await log(s, 'Skill level changed', `${await employeeName(s, employeeId)}: ${String(skill.name)}, ${LEVEL_LABEL[before]} to ${LEVEL_LABEL[level]}`);
  return { employee_id: employeeId, skill_id: skillId, rating: row ? ratingValue(row) : null };
}

// ───────────────────────────── succession ─────────────────────────────
async function findSuccessor(s: HrmsScope, roleId: string, employeeId: string): Promise<Row | null> {
  return must(await scoped(db().from(SU).select('*'), s).eq('role_id', roleId).eq('employee_id', employeeId).maybeSingle()) as Row | null;
}

/** Add a successor to a critical role. The dashboard's addSuccessor. Returns the updated role. */
export async function addSuccessor(s: HrmsScope, roleId: string, employeeId: string, readiness: Readiness, actions: string[], reason: string): Promise<Row> {
  const r = needReason(reason ?? ''); if (r) throw invalid(r);
  const role = await mustRole(s, roleId);
  if (String(role.incumbent_id) === employeeId) throw invalid('The current holder cannot be their own successor.');
  if (await findSuccessor(s, roleId, employeeId)) throw invalid('This person is already on the bench for this role.');
  if (!(await employeeExists(s, employeeId))) throw invalid('Pick someone who works here.');

  const cleanActions = (actions ?? []).map((a) => String(a).trim()).filter(Boolean).slice(0, 20);
  const today = todayIst();
  const ins = await db().from(SU).insert({ ...scopeCols(s), role_id: roleId, employee_id: employeeId, readiness, actions: cleanActions, added_on: today });
  if (ins.error) {
    if (isUniqueViolation(ins.error)) throw invalid('This person is already on the bench for this role.');
    throw fail(ins.error);
  }
  await db().from(CH).insert({ ...scopeCols(s), role_id: roleId, on_date: today, by_name: s.actor, kind: 'added', employee_id: employeeId, from_text: null, to_text: readiness, reason: reason.trim() });
  await log(s, 'Successor added', `${await employeeName(s, employeeId)} for ${String(role.title)}`);
  return roleWire(s, role);
}

/** Remove a successor from a role. The dashboard's removeSuccessor. Returns the updated role. */
export async function removeSuccessor(s: HrmsScope, roleId: string, employeeId: string, reason: string): Promise<Row> {
  const r = needReason(reason ?? ''); if (r) throw invalid(r);
  const role = await mustRole(s, roleId);
  const existing = await findSuccessor(s, roleId, employeeId);
  if (!existing) throw invalid('This person is not on the bench.');
  const del = await scoped(db().from(SU).delete(), s).eq('role_id', roleId).eq('employee_id', employeeId);
  if (del.error) throw fail(del.error);
  const today = todayIst();
  await db().from(CH).insert({ ...scopeCols(s), role_id: roleId, on_date: today, by_name: s.actor, kind: 'removed', employee_id: employeeId, from_text: String(existing.readiness), to_text: null, reason: reason.trim() });
  await log(s, 'Successor removed', `${await employeeName(s, employeeId)} from ${String(role.title)}`);
  return roleWire(s, role);
}

/** Change a successor's readiness. The dashboard's setReadiness. Returns the updated role. */
export async function setReadiness(s: HrmsScope, roleId: string, employeeId: string, readiness: Readiness, reason: string): Promise<Row> {
  const r = needReason(reason ?? ''); if (r) throw invalid(r);
  const role = await mustRole(s, roleId);
  const existing = await findSuccessor(s, roleId, employeeId);
  if (!existing) throw invalid('This person is not on the bench.');
  const from = String(existing.readiness);
  if (from === readiness) throw invalid('That is already the readiness shown.');
  const upd = await scoped(db().from(SU).update({ readiness }), s).eq('role_id', roleId).eq('employee_id', employeeId);
  if (upd.error) throw fail(upd.error);
  const today = todayIst();
  await db().from(CH).insert({ ...scopeCols(s), role_id: roleId, on_date: today, by_name: s.actor, kind: 'readiness', employee_id: employeeId, from_text: from, to_text: readiness, reason: reason.trim() });
  await log(s, 'Readiness changed', `${await employeeName(s, employeeId)}: ${READINESS_LABEL[from as Readiness] ?? from} to ${READINESS_LABEL[readiness]}`);
  return roleWire(s, role);
}

// ───────────────────────────── 9-box ─────────────────────────────
/** Place a person on the 9-box (one per person). The dashboard's placeEmployee. */
export async function placeEmployee(s: HrmsScope, employeeId: string, performance: number, potential: number, rationale: string): Promise<Row> {
  if (rationale.trim().length < 10) throw invalid('Write a rationale of at least 10 characters. The 9-box is a conversation, and the reason is the point.');
  if (!isNineLevel(performance) || !isNineLevel(potential)) throw invalid('Pick a performance and potential of 1, 2 or 3.');
  if (!(await employeeExists(s, employeeId))) throw invalid('Pick someone who works here.');

  const del = await scoped(db().from(PL).delete(), s).eq('employee_id', employeeId);
  if (del.error) throw fail(del.error);
  const res = await db().from(PL).insert({
    ...scopeCols(s), employee_id: employeeId, performance, potential, rationale: rationale.trim(), by_name: s.actor, on_date: todayIst(),
  }).select('employee_id, performance, potential, rationale, by_name, on_date').single();
  if (res.error) throw fail(res.error);
  await log(s, '9-box placement saved', await employeeName(s, employeeId));
  return placementValue(res.data as Row);
}

/** Clear a person's 9-box placement. The dashboard's clearPlacement. */
export async function clearPlacement(s: HrmsScope, employeeId: string): Promise<{ employee_id: string; cleared: boolean }> {
  const existing = must(await scoped(db().from(PL).select('id'), s).eq('employee_id', employeeId).maybeSingle()) as Row | null;
  if (!existing) return { employee_id: employeeId, cleared: false };
  const del = await scoped(db().from(PL).delete(), s).eq('employee_id', employeeId);
  if (del.error) throw fail(del.error);
  await log(s, '9-box placement removed', await employeeName(s, employeeId));
  return { employee_id: employeeId, cleared: true };
}

/** Record that the named (HR) talent-review view was opened. The dashboard's logReviewOpened. */
export async function logReviewOpened(s: HrmsScope, group?: string): Promise<Row> {
  await log(s, 'Talent review (names) opened', (group ?? '').slice(0, 200) || 'All');
  const entries = await listLog(s, 1);
  return entries.length ? logOut(entries[0]!) : {};
}

export type { NineLevel };
