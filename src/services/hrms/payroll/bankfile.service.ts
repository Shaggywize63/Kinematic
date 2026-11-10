import { db, fail, fetchAll, HrmsScope, must, scopeCols, scoped } from '../scope';
import { readBank } from '../model';
import type { Row } from './common';
import { buildBankFile } from './engine';
import type { HrmsDb, PayRun } from './engine';
import { emptyDb } from './mapping';
import { refuse } from './common';
import { requireRun } from './runs.service';
import { payslipOut } from './mapping';

// The bank file, built on the server from the REAL (decrypted) account numbers.
//
//  - Only for a frozen or paid run: what goes to the bank is what was frozen.
//  - The engine's own buildBankFile builds it (same header, same rows, same skip reasons as the dashboard's builder).
//  - Every call writes ONE hrms_access_log row first (field 'bank_file', reason "Bank file for <entity> <month>", run_id, who and when).
//    If that row cannot be written nothing is returned: no account number leaves the server unrecorded.
//  - Account numbers exist only in the value returned to the caller. They are never logged, never put in an error, never written anywhere.

export interface BankFile { header: string[]; rows: string[][]; skipped: { employeeId: string; reason: string }[]; masked: string[] }

const BUILDER_MASKED_REASON = 'Account number is masked (live data): the full number is not held in this browser';
const SERVER_MASKED_REASON = 'Account number cannot be read with the current encryption key';

export async function buildRunBankFile(s: HrmsScope, runId: string): Promise<{ file: BankFile; entityName: string; month: string }> {
  const run = await requireRun(s, runId);
  if (run.status !== 'frozen' && run.status !== 'paid') {
    throw refuse(409, 'The bank file can only be made for a frozen or paid run. Freeze the run first.', 'RUN_NOT_FROZEN');
  }
  const entity = must(await scoped(db().from('hrms_entities').select('id,name'), s).eq('id', String(run.entity_id)).maybeSingle()) as Row | null;
  const entityName = String(entity?.name ?? 'the entity');
  const month = String(run.month);

  const slipRows = await fetchAll<Row>((from, to) => scoped(db().from('hrms_payslips').select('*'), s).eq('run_id', runId).order('position', { ascending: true }).order('id', { ascending: true }).range(from, to));
  const payslips = slipRows.map(payslipOut);

  // Read only what the file needs: code, pay mode, and the sealed bank of the people paid by bank transfer.
  const ids = payslips.map((p) => p.employeeId);
  const people: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    people.push(...((must(await scoped(db().from('hrms_employees').select('id,code,pay_mode,bank_enc'), s).in('id', ids.slice(i, i + 100))) as Row[] | null) ?? []));
  }
  const model: HrmsDb = emptyDb();
  model.employees = people.map((r) => {
    const bank = r.pay_mode === 'bank' && r.bank_enc ? readBank(r) : null;
    return {
      id: String(r.id), code: String(r.code), payMode: r.pay_mode,
      // sealed but unreadable (wrong key): hand the builder a mask so it skips the person rather than paying a wrong number
      bank: r.pay_mode !== 'bank' || !r.bank_enc ? undefined : bank ?? { accountHolder: '', accountNumber: 'XXXXXXXXXX', ifsc: '', bankName: '', accountType: 'savings' },
    };
  }) as unknown as HrmsDb['employees'];

  const built = buildBankFile(model, { month, payslips } as unknown as PayRun);
  const file: BankFile = {
    ...built,
    skipped: built.skipped.map((k) => (k.reason === BUILDER_MASKED_REASON ? { ...k, reason: SERVER_MASKED_REASON } : k)),
  };

  // The record comes first. Without it there is no file.
  const { error } = await db().from('hrms_access_log').insert({
    ...scopeCols(s), at: new Date().toISOString(), by_user_id: s.user_id, by_name: s.actor, employee_id: null, field: 'bank_file', run_id: runId,
    reason: `Bank file for ${entityName} ${month}`,
  });
  if (error) throw fail(error);
  return { file, entityName, month };
}

// ── CSV ─────────────────────────────────────────────────────────────────────
/** A cell the way the dashboard's downloadRows writes it (quotes only when needed), and made safe against spreadsheet formulas. */
const cell = (v: unknown): string => {
  let t = v == null ? '' : String(v);
  if (/^[=+@\t\r-]/.test(t)) t = `'${t}`; // a name that starts like a formula must not run when the file is opened in a spreadsheet
  t = t.replace(/"/g, '""');
  return /[",\n]/.test(t) ? `"${t}"` : t;
};
export const toCsv = (header: string[], rows: string[][]): string => [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');

const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const bankFileName = (entityName: string, month: string): string => `bank-advice-${month}-${slug(entityName) || 'entity'}.csv`;

