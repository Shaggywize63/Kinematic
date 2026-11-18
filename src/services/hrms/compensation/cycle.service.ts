import { db, fail, fetchAll, HrmsScope, isNotReady, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound, now } from '../payroll/common';
import { cycleOut } from './mapping';
import {
  Band, baseCtcFor, checkProposal, CompaZone, CycleEmployee, cycleMembership, DEFAULT_GUIDELINES, Guidelines, PerfBand,
  submitBlockers, validateGuideline,
} from './engine';
import { listBands } from './bands.service';
import { loadPerf } from './perf.service';

// The merit cycle: a SINGLETON per org (unique org_id). Mirrors the compensation half of rewards/store.ts: the budget /
// effective-date / guideline / proposal setters (all gated on the cycle being OPEN), the draft -> submitted ->
// approved | returned status machine, and recordApplied. The window / reminders pattern of benefits' config.service is
// reused: load the singleton (or an unsaved default), change one aspect, upsert the whole row. The submit / approve
// gates reproduce the dashboard's cycleBlockers from the real employees + designations + bands + perf, so the server's
// refusal is the dashboard's ("Enter at least one proposed increment." / "N proposals ... need a reason.").

const T = 'hrms_merit_cycle';
const today = (): string => new Date().toISOString().slice(0, 10);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const OPEN = new Set(['draft', 'returned']);
const isOpen = (row: Row): boolean => OPEN.has(String(row.status));

function defaultCycleRow(): Row {
  return { name: 'Merit cycle', effective_on: today(), budget_pct: 0, status: 'draft', decision: null, guidelines: DEFAULT_GUIDELINES(), proposals: {}, applied: {} };
}

export async function loadCycle(s: HrmsScope): Promise<Row | null> {
  return must(await scoped(db().from(T).select('*'), s).maybeSingle()) as Row | null;
}
async function currentOrDefault(s: HrmsScope): Promise<Row> {
  return (await loadCycle(s)) ?? defaultCycleRow();
}

/** Upsert the whole singleton (unique org_id is the conflict target), returning the stored row. */
async function saveCycle(s: HrmsScope, c: Row): Promise<Row> {
  const res = await db().from(T)
    .upsert({
      ...scopeCols(s), name: c.name, effective_on: c.effective_on, budget_pct: c.budget_pct, status: c.status,
      decision: c.decision ?? null, guidelines: c.guidelines ?? {}, proposals: c.proposals ?? {}, applied: c.applied ?? {}, updated_at: now(),
    }, { onConflict: 'org_id' })
    .select('*').single();
  if (res.error) throw fail(res.error);
  return res.data as Row;
}

export async function loadCycleOrDefault(s: HrmsScope): Promise<Row> {
  return currentOrDefault(s);
}

// ── setters (cycle must be open) ──────────────────────────────────────────────
const LOCKED = 'The cycle is locked. Return it to managers or reopen it first.';

export async function updateCycle(s: HrmsScope, patch: { name?: string; effective_on?: string; budget_pct?: number }): Promise<Row> {
  const cur = await currentOrDefault(s);
  if (!isOpen(cur)) throw invalid(LOCKED);
  const next: Row = { ...cur };
  if (patch.budget_pct !== undefined) {
    if (!Number.isFinite(patch.budget_pct) || patch.budget_pct < 0 || patch.budget_pct > 30) throw invalid('Use a budget from 0 to 30 percent.');
    next.budget_pct = Math.round(patch.budget_pct * 100) / 100;
  }
  if (patch.effective_on !== undefined) {
    if (patch.effective_on < today()) throw invalid('Choose a date that is today or later.');
    next.effective_on = patch.effective_on;
  }
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw invalid('Enter a name for the cycle.');
    next.name = name;
  }
  return cycleOut(await saveCycle(s, next));
}

export async function setGuideline(s: HrmsScope, g: { perf: PerfBand; zone: CompaZone; min: number; max: number }): Promise<Row> {
  const cur = await currentOrDefault(s);
  if (!isOpen(cur)) throw invalid('The cycle is locked.');
  const err = validateGuideline(g.min, g.max);
  if (err) throw invalid(err);
  const guidelines = (obj(cur.guidelines) as Guidelines) ?? DEFAULT_GUIDELINES();
  const base = Object.keys(guidelines).length ? guidelines : DEFAULT_GUIDELINES();
  base[g.perf] = { ...base[g.perf], [g.zone]: { min: g.min, max: g.max } };
  return cycleOut(await saveCycle(s, { ...cur, guidelines: base }));
}

export async function setProposal(s: HrmsScope, employeeId: string, pct: number | null, reason?: string): Promise<Row> {
  const cur = await currentOrDefault(s);
  if (!isOpen(cur)) throw invalid('Proposals are locked while the cycle is with HR or approved.');
  if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 50)) throw invalid('Use 0 to 50 percent.');
  const proposals: Record<string, unknown> = { ...obj(cur.proposals) };
  if (pct == null) delete proposals[employeeId];
  else proposals[employeeId] = { pct, reason: (reason ?? '').trim() || undefined, by: s.actor, on: today() };
  return cycleOut(await saveCycle(s, { ...cur, proposals }));
}

// ── status machine ────────────────────────────────────────────────────────────
export async function submitCycle(s: HrmsScope): Promise<Row> {
  const cur = await currentOrDefault(s);
  if (!isOpen(cur)) throw invalid('The cycle is already with HR or approved.');
  const blockers = await computeBlockers(s, cur);
  if (blockers.length) throw invalid(blockers[0]!);
  return cycleOut(await saveCycle(s, { ...cur, status: 'submitted', decision: null }));
}

export async function decideCycle(s: HrmsScope, input: { decision: 'approve' | 'return'; note?: string | null; over_budget?: boolean }): Promise<Row> {
  const cur = await currentOrDefault(s);
  if (String(cur.status) !== 'submitted') throw invalid('Only a submitted cycle can be decided.');
  const note = String(input.note ?? '').trim();
  if (input.decision === 'return' && !note) throw invalid('Tell the managers what to change.');
  if (input.decision === 'approve' && input.over_budget && !note) throw invalid('The total is over budget. Write why you are approving it.');
  if (input.decision === 'approve') {
    const blockers = await computeBlockers(s, cur);
    if (blockers.length) throw invalid(blockers[0]!);
  }
  const decision = { by: s.actor, on: today(), note: note || undefined };
  return cycleOut(await saveCycle(s, { ...cur, status: input.decision === 'approve' ? 'approved' : 'returned', decision }));
}

export async function reopenCycle(s: HrmsScope): Promise<Row> {
  const cur = await currentOrDefault(s);
  if (String(cur.status) !== 'approved') throw invalid('Only an approved cycle can be reopened.');
  if (Object.keys(obj(cur.applied)).length) throw invalid('Some increments are already issued, so the cycle cannot be reopened.');
  return cycleOut(await saveCycle(s, { ...cur, status: 'draft', decision: null }));
}

// ── record an issued increment (atomic, in the DB function) ────────────────────
export async function recordApplied(s: HrmsScope, employeeId: string, info: { from: number; to: number; letter_id: string }): Promise<Row> {
  const res = await db().rpc('hrms_merit_record_applied', {
    p_org: s.org_id, p_employee: employeeId, p_from: info.from, p_to: info.to, p_letter: info.letter_id, p_on: today(), p_by: s.actor,
  });
  if (res.error) {
    if (isNotReady(res.error)) throw fail(res.error);
    const msg = String(res.error.message ?? '');
    if (msg.includes('MERIT_NOT_FOUND')) throw notFound('There is no merit cycle to record against.');
    if (msg.includes('MERIT_NOT_APPROVED')) throw invalid('HR has not approved the cycle yet.');
    if (msg.includes('MERIT_ALREADY_APPLIED')) throw invalid('An increment was already issued to this person in this cycle.');
    throw fail(res.error);
  }
  return cycleOut(await loadCycle(s));
}

// ── submit / approve blockers (reproduce the dashboard's cycleBlockers) ─────────
async function computeBlockers(s: HrmsScope, cycle: Row): Promise<string[]> {
  const proposals = obj(cycle.proposals);
  if (!Object.keys(proposals).length) return submitBlockers({ withProposal: 0, missingReasons: 0 });

  const guidelines = (obj(cycle.guidelines) as Guidelines);
  const guides = Object.keys(guidelines).length ? guidelines : DEFAULT_GUIDELINES();
  const applied = obj(cycle.applied) as Record<string, { from: number }>;
  const effectiveOn = String(cycle.effective_on);

  const [employees, designations, bandRows, perfRows] = await Promise.all([
    fetchAll<Row>((from, to) => scoped(db().from('hrms_employees').select('id,status,join_date,contract_end_date,annual_ctc,designation_id'), s).is('deleted_at', null).range(from, to)),
    fetchAll<Row>((from, to) => scoped(db().from('hrms_designations').select('id,grade'), s).range(from, to)),
    listBands(s),
    loadPerf(s),
  ]);

  const gradeOf = new Map<string, string>(designations.map((d) => [String(d.id), String(d.grade ?? '')]));
  const bandByGrade = new Map<string, Band>(bandRows.map((b) => [String(b.grade), {
    grade: String(b.grade), min: Number(b.band_min), mid: Number(b.band_mid), max: Number(b.band_max), market: Number(b.market), published: !!b.published,
  }]));
  const perfOf = new Map<string, PerfBand>(perfRows.filter((p) => p.band).map((p) => [String(p.employee_id), p.band as PerfBand]));

  const members: CycleEmployee[] = employees.map((e) => ({
    id: String(e.id), status: String(e.status), annualCtc: e.annual_ctc == null ? null : Number(e.annual_ctc),
    joinDate: String(e.join_date), contractEndDate: e.contract_end_date == null ? null : String(e.contract_end_date), designationId: e.designation_id == null ? null : String(e.designation_id),
  }));

  let withProposal = 0;
  let missingReasons = 0;
  for (const m of cycleMembership(members, effectiveOn)) {
    if (!m.included) continue;
    const p = proposals[m.employee.id] as { pct: number; reason?: string } | undefined;
    if (!p) continue;
    withProposal += 1;
    const grade = m.employee.designationId ? gradeOf.get(m.employee.designationId) : undefined;
    const band = grade ? bandByGrade.get(grade) : undefined;
    if (!band) continue;
    const base = baseCtcFor(m.employee, applied);
    if (checkProposal(base, band, perfOf.get(m.employee.id), guides, p).needsReason) missingReasons += 1;
  }
  return submitBlockers({ withProposal, missingReasons });
}
