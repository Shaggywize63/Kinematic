import { db, fail, HrmsScope, must, scoped } from '../scope';
import { isRealDate } from '../schemas';
import type { Row } from './common';
import { ESI, flagDefaults, PF, validateStructure } from './engine';
import type { SalaryComponent, SalaryStructure } from './engine';
import type { ComponentIn } from './schemas';
import { structureOut } from './mapping';
import { insertIdempotent, invalid, newId, notFound, now, refuse } from './common';

// Salary structures. The rules are the dashboard's (payrollActions.ts saveStructure / deleteStructure, logic.ts validateStructure), with
// its words: the server is the authority and the UI shows the reason it gives.

const T = 'hrms_structures';
const cid = () => `c_${newId().replace(/-/g, '').slice(0, 10)}`;

/** A component as stored: code / name trimmed, flags defaulted the way the dashboard's comp() does, rate-driven values fixed to the rules. */
function component(c: ComponentIn): SalaryComponent {
  const d = flagDefaults(c.kind);
  const type = c.calc.type;
  const value = type === 'balance' ? 0 : type === 'pf_employer' ? PF.employerRate : type === 'esi_employer' ? ESI.employerRate : c.calc.value ?? 0;
  return {
    id: c.id ?? cid(), code: c.code.trim().toUpperCase(), name: c.name.trim(), kind: c.kind, calc: { type, value },
    isWage: c.kind === 'earning' ? (c.isWage ?? d.isWage) : false, taxable: c.taxable ?? d.taxable, pfApplicable: c.pfApplicable ?? d.pfApplicable,
    esiApplicable: c.esiApplicable ?? d.esiApplicable, prorate: c.prorate ?? d.prorate, showInPayslip: c.showInPayslip ?? true,
  };
}

/** Throws the first problem the dashboard's validateStructure finds (400, its words), plus two the server adds (unreal date, repeated component id). */
function check(s: SalaryStructure): void {
  const v = validateStructure(s);
  if (v.errors.length) throw invalid(v.errors[0]!);
  if (!isRealDate(s.effectiveFrom)) throw invalid('Choose an effective-from date.');
  if (new Set(s.components.map((c) => c.id)).size !== s.components.length) throw invalid('Component ids must be unique.');
}

const find = async (s: HrmsScope, id: string): Promise<Row | null> => must(await scoped(db().from(T).select('*'), s).eq('id', id).maybeSingle()) as Row | null;

export async function createStructure(s: HrmsScope, input: Row): Promise<{ row: Row; created: boolean }> {
  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { row: structureOut(existing), created: false };
  }
  const structure: SalaryStructure = {
    id, name: String(input.name).trim(), description: input.description ?? undefined, effectiveFrom: String(input.effective_from),
    components: (input.components as ComponentIn[]).map(component),
  };
  check(structure);
  const r = await insertIdempotent(s, T, {
    id, name: structure.name, description: input.description ?? null, effective_from: structure.effectiveFrom, components: structure.components,
  }, !!input.id, () => find(s, id));
  return { row: structureOut(r.row), created: r.created };
}

export async function updateStructure(s: HrmsScope, id: string, patch: Row): Promise<Row> {
  const current = await find(s, id);
  if (!current) throw notFound('Structure not found');
  const structure: SalaryStructure = {
    id, name: patch.name !== undefined ? String(patch.name).trim() : String(current.name),
    description: (patch.description !== undefined ? patch.description : current.description) ?? undefined,
    effectiveFrom: patch.effective_from !== undefined ? String(patch.effective_from) : String(current.effective_from),
    components: patch.components !== undefined ? (patch.components as ComponentIn[]).map(component) : (current.components as SalaryComponent[]),
  };
  check(structure);
  const res = await scoped(db().from(T).update({
    name: structure.name, description: structure.description ?? null, effective_from: structure.effectiveFrom, components: structure.components, updated_at: now(),
  }), s).eq('id', id).select('*').single();
  if (res.error) throw fail(res.error);
  return structureOut(res.data as Row);
}

export async function deleteStructure(s: HrmsScope, id: string): Promise<{ id: string }> {
  if (!(await find(s, id))) throw notFound('Structure not found');
  const { count, error } = await scoped(db().from('hrms_employees').select('id', { count: 'exact', head: true }), s).eq('structure_id', id).is('deleted_at', null);
  if (error) throw fail(error);
  const used = count ?? 0;
  if (used) throw refuse(409, `${used} employee${used === 1 ? ' is' : 's are'} on this structure. Move them to another structure first.`, 'IN_USE');
  const del = await scoped(db().from(T).delete(), s).eq('id', id);
  if (del.error) throw fail(del.error);
  return { id };
}

