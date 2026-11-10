/**
 * A small company in the HRMS fake database, for the payroll tests: two legal entities, two locations (Delhi, Mumbai), the three standard
 * salary structures (the dashboard's seed ones, taken from the golden fixture), and people covering every branch a payroll run has.
 * Account numbers and PANs are obviously fake and are sealed with the real hrmsCrypto, as the API stores them.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';
import type { HrmsFakeDb, Row } from './hrmsFakeDb';
import { sealBank, sealPan } from '../../src/services/hrms/model';

export const ORG = '00000000-0000-4000-8000-0000000000aa';
export const OTHER_ORG = '00000000-0000-4000-8000-0000000000bb';
export const MASTER = { id: '33333333-3333-4333-8333-333333333333', org_id: ORG, email: 's@kinematicapp.com', name: 'Sagar B', role: 'super_admin' };

/** A deterministic uuid. */
export const uid = (n: number, ns = 'a') => `${ns.repeat(8)}-${ns.repeat(4)}-4${ns.repeat(3)}-8${ns.repeat(3)}-${String(n).padStart(12, '0')}`;

export const ACCOUNT = { aarav: '500100000011', bela: '500100000022', chitra: '500100000033' }; // fake; not zero-padded like the test uuids, so a substring check cannot trip on an id
export const PANS = { aarav: 'ABCPM1234F', bela: 'BCDPE2345G' };

export const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hrms-payroll-golden.json'), 'utf8'));

export const IDS = {
  ENT: uid(1), ENT2: uid(2), LOC_DEL: uid(3), LOC_MUM: uid(4), LOC_2: uid(5), DEP: uid(6), DSG: uid(7),
  STD: uid(11), FIELD: uid(12), WH: uid(13),
};

const stamp = (org = ORG) => ({ org_id: org, client_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' });

export function seedCompany(fake: HrmsFakeDb, org = ORG): void {
  const t = (name: string) => (fake.tables[name] ??= []);
  t('hrms_entities').push(
    { id: IDS.ENT, name: 'Meridian Retail Pvt Ltd', pan: null, address: {}, registrations: [{ id: 'r1', type: 'pf', number: 'PF/DL/1' }], ...stamp(org) },
    { id: IDS.ENT2, name: 'Meridian Logistics Pvt Ltd', pan: null, address: {}, registrations: [], ...stamp(org) },
  );
  t('hrms_locations').push(
    { id: IDS.LOC_DEL, entity_id: IDS.ENT, name: 'Delhi HQ', state: 'Delhi', city: 'New Delhi', metro: true, ...stamp(org) },
    { id: IDS.LOC_MUM, entity_id: IDS.ENT, name: 'Mumbai', state: 'Maharashtra', city: 'Mumbai', metro: true, ...stamp(org) },
    { id: IDS.LOC_2, entity_id: IDS.ENT2, name: 'Pune depot', state: 'Maharashtra', city: 'Pune', metro: false, ...stamp(org) },
  );
  t('hrms_departments').push({ id: IDS.DEP, name: 'Sales', head_id: null, ...stamp(org) });
  t('hrms_designations').push({ id: IDS.DSG, name: 'Executive', grade: null, ...stamp(org) });
  const ids = [IDS.STD, IDS.FIELD, IDS.WH];
  golden.cases[0].input.structures.forEach((s: any, i: number) => {
    t('hrms_structures').push({ id: ids[i], name: s.name, description: s.description, effective_from: s.effectiveFrom, components: s.components, ...stamp(org) });
  });
}

let seq = 0;
/** A full employee row as the database would hold it (PAN and bank sealed when given). */
export function seedEmployee(fake: HrmsFakeDb, over: Row = {}, org = ORG): Row {
  const id = over.id ?? uid(100 + ++seq, 'e');
  const { pan, bank, ...rest } = over;
  const row: Row = {
    id, code: `EMP-${String(seq).padStart(4, '0')}`, first_name: 'Test', last_name: 'Person', email: 't@example.com', mobile: '9876543210', gender: 'male', dob: '1990-01-01',
    father_name: null, marital_status: null, blood_group: null, address: {}, emergency_contact: null,
    entity_id: IDS.ENT, location_id: IDS.LOC_DEL, department_id: IDS.DEP, designation_id: IDS.DSG, reporting_to_id: null, employment_type: 'permanent', status: 'active',
    join_date: '2024-04-01', confirmation_date: null, probation_months: 0, notice_days: 0, last_working_date: null, shift_id: null, cost_centre: null, contract_end_date: null,
    pan_enc: null, aadhaar_last4: null, aadhaar_verified: false, uan: null, uan_status: 'none', pf_member: false, pf_on_actual_wage: false, pf_join_date: null, esic_ip: null,
    pt_applicable: false, lwf_applicable: false, tax_regime: 'new', declaration: { sec80C: 0, sec80D: 0, nps80CCD1B: 0, homeLoanInterest: 0, rentPaidAnnual: 0, other: 0, status: 'not_submitted' },
    bank_enc: null, pay_mode: 'bank', structure_id: null, annual_ctc: null, structure_overrides: null, deleted_at: null, ...stamp(org), ...rest,
  };
  if (pan) row.pan_enc = sealPan(id, pan);
  if (bank) row.bank_enc = sealBank(id, bank);
  (fake.tables.hrms_employees ??= []).push(row);
  return row;
}

const bankOf = (name: string, accountNumber: string, ifsc: string, bankName: string) => ({ accountHolder: name, accountNumber, ifsc, bankName, accountType: 'savings' as const });

/** The people. Keys are first names; every value is the stored row. */
export function seedPeople(fake: HrmsFakeDb): Record<string, Row> {
  const decl = { sec80C: 150000, sec80D: 25000, nps80CCD1B: 50000, homeLoanInterest: 100000, rentPaidAnnual: 360000, other: 0, status: 'verified' };
  return {
    aarav: seedEmployee(fake, { first_name: 'Aarav', structure_id: IDS.STD, annual_ctc: 1200000, pf_member: true, uan: '100200300401', uan_status: 'aadhaar_seeded', pan: PANS.aarav, tax_regime: 'old', declaration: decl, bank: bankOf('Aarav Test', ACCOUNT.aarav, 'HDFC0001234', 'HDFC Bank') }),
    bela: seedEmployee(fake, { first_name: 'Bela', gender: 'female', location_id: IDS.LOC_MUM, structure_id: IDS.FIELD, annual_ctc: 540000, pf_member: true, uan: '100200300402', uan_status: 'aadhaar_seeded', pt_applicable: true, lwf_applicable: true, pan: PANS.bela, bank: bankOf('Bela Test', ACCOUNT.bela, 'ICIC0004321', 'ICICI Bank') }),
    chitra: seedEmployee(fake, { first_name: 'Chitra', employment_type: 'daily_wage', structure_id: IDS.WH, annual_ctc: 216000, pf_member: true, esic_ip: '1234567890', uan: '100200300403', uan_status: 'generated', bank: bankOf('Chitra Test', ACCOUNT.chitra, 'SBIN0000123', 'State Bank of India') }),
    dev: seedEmployee(fake, { first_name: 'Dev', structure_id: IDS.STD, annual_ctc: 480000, pay_mode: 'cash' }),
    esha: seedEmployee(fake, { first_name: 'Esha', structure_id: IDS.STD, annual_ctc: 600000, pf_member: true }),
    fay: seedEmployee(fake, { first_name: 'Fay', status: 'onboarding', structure_id: IDS.STD, annual_ctc: 300000 }),
    gus: seedEmployee(fake, { first_name: 'Gus' }),
    hari: seedEmployee(fake, { first_name: 'Hari', entity_id: IDS.ENT2, location_id: IDS.LOC_2, structure_id: IDS.STD, annual_ctc: 360000, pf_member: true, bank: bankOf('Hari Test', '500100000044', 'HDFC0001234', 'HDFC Bank') }),
  };
}
