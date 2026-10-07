/**
 * The agrisynx lead-form building blocks on the backend:
 *   - crm_settings.config.lead_form is validated (labels / address on B2B / schedule visit);
 *   - "Schedule Visit" on lead create becomes a planned activity for the rep, which the
 *     existing reminder service then notifies about (~30 min before).
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as v from '../src/validators/crm.validators';
import { createScheduledVisit, visitSubject } from '../src/services/crm/scheduledVisit.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const REP = '11111111-1111-1111-1111-111111111111';
const OWNER = '22222222-2222-2222-2222-222222222222';

describe('crm settings: lead_form config', () => {
  const ok = (lead_form: unknown) => v.settingsUpdateSchema.safeParse({ config: { lead_form } });

  it('accepts the Dealer / Farmers setup', () => {
    expect(ok({
      segment_labels: { b2b: 'Dealer', b2c: 'Farmers' },
      address_on_b2b: true,
      schedule_visit: { segments: ['b2b'] },
    }).success).toBe(true);
  });
  it('accepts a partial setup and an empty one', () => {
    expect(ok({ segment_labels: { b2b: 'Dealer' } }).success).toBe(true);
    expect(ok({}).success).toBe(true);
  });
  it('accepts null to clear it, and a config that has no lead_form at all', () => {
    expect(ok(null).success).toBe(true);
    expect(v.settingsUpdateSchema.safeParse({ config: { field_overrides: {} } }).success).toBe(true);
    expect(v.settingsUpdateSchema.safeParse({ business_type: 'both' }).success).toBe(true);
  });
  it('rejects a blank or over-long label (it would render as an empty tab)', () => {
    expect(ok({ segment_labels: { b2b: '   ' } }).success).toBe(false);
    expect(ok({ segment_labels: { b2c: 'x'.repeat(41) } }).success).toBe(false);
  });
  it('rejects unknown keys and unknown segments', () => {
    expect(ok({ segment_labels: { b2b: 'Dealer', retail: 'Shop' } }).success).toBe(false);
    expect(ok({ nonsense: true }).success).toBe(false);
    expect(ok({ schedule_visit: { segments: ['b2x'] } }).success).toBe(false);
  });
  it('rejects a wrongly typed flag', () => {
    expect(ok({ address_on_b2b: 'yes' }).success).toBe(false);
  });
  it('reports the problem against lead_form', () => {
    const r = ok({ segment_labels: { b2b: '' } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path.slice(0, 2)).toEqual(['config', 'lead_form']);
  });
  it('does not touch other config keys', () => {
    expect(v.settingsUpdateSchema.safeParse({ config: { anything: { goes: [1, 2] }, lead_form: { address_on_b2b: false } } }).success).toBe(true);
  });
});

describe('schedule_visit on lead create', () => {
  const lead = { first_name: 'Ramesh', phone: '9876543210' };
  const parse = (extra: unknown) => v.leadCreateSchema.safeParse({ ...lead, ...(extra as object) });

  it('accepts a date and time (with or without a zone)', () => {
    expect(parse({ schedule_visit: { due_at: '2026-10-12T09:30:00+05:30' } }).success).toBe(true);
    expect(parse({ schedule_visit: { due_at: '2026-10-12T04:00:00.000Z', subject: 'Dealer Visit — Sri Lakshmi Agro' } }).success).toBe(true);
    expect(parse({ schedule_visit: { due_at: '2026-10-12T09:30' } }).success).toBe(true);
  });
  it('is optional and nullable', () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ schedule_visit: null }).success).toBe(true);
  });
  it('rejects something that is not a date', () => {
    expect(parse({ schedule_visit: { due_at: 'next tuesday' } }).success).toBe(false);
    expect(parse({ schedule_visit: { due_at: '' } }).success).toBe(false);
    expect(parse({ schedule_visit: {} }).success).toBe(false);
  });
  it('is create-only: an update never accepts it', () => {
    const r = v.leadUpdateSchema.safeParse({ first_name: 'X', schedule_visit: { due_at: '2026-10-12T09:30:00Z' } });
    expect(r.success).toBe(true);
    if (r.success) expect('schedule_visit' in r.data).toBe(false);
  });
});

describe('creating the scheduled visit', () => {
  beforeEach(() => __mock.reset());
  const insertOf = () => __mock.chainsFor('crm_activities')[0].ops.find((o) => o.method === 'insert')!.args[0] as Record<string, unknown>;
  const leadRow = { id: 'lead-1', first_name: 'Ramesh', last_name: null, company: 'Sri Lakshmi Agro', client_id: 'client-1', owner_id: OWNER };

  it('creates a PLANNED meeting for the lead, due when the rep chose, assigned to the owner', async () => {
    __mock.setDefault('crm_activities', { data: [{ id: 'act-1', due_at: '2026-10-12T04:00:00+00:00' }] });
    const out = await createScheduledVisit({
      org_id: ORG, user_id: REP, lead: leadRow,
      visit: { due_at: '2026-10-12T09:30:00+05:30', subject: 'Dealer Visit — Sri Lakshmi Agro' },
    });
    expect(out.id).toBe('act-1');
    expect(insertOf()).toMatchObject({
      org_id: ORG, created_by: REP, type: 'meeting', status: 'planned', lead_id: 'lead-1', client_id: 'client-1',
      owner_id: OWNER, assigned_to: OWNER, subject: 'Dealer Visit — Sri Lakshmi Agro',
      due_at: '2026-10-12T04:00:00.000Z',          // normalised to UTC
    });
  });
  it('assigns to whoever captured the lead when it has no owner', async () => {
    __mock.setDefault('crm_activities', { data: [{ id: 'act-2' }] });
    await createScheduledVisit({ org_id: ORG, user_id: REP, lead: { ...leadRow, owner_id: null }, visit: { due_at: '2026-10-12T09:30:00Z' } });
    expect(insertOf()).toMatchObject({ owner_id: REP, assigned_to: REP });
  });
  it('is never "completed" (that default would stop the reminder)', async () => {
    __mock.setDefault('crm_activities', { data: [{ id: 'act-3' }] });
    await createScheduledVisit({ org_id: ORG, user_id: REP, lead: leadRow, visit: { due_at: '2026-10-12T09:30:00Z' } });
    expect(insertOf().status).toBe('planned');
  });
  it('refuses a date that cannot be read', async () => {
    await expect(createScheduledVisit({ org_id: ORG, user_id: REP, lead: leadRow, visit: { due_at: 'soon' } })).rejects.toThrow(/Invalid visit/);
    expect(__mock.chainsFor('crm_activities')).toHaveLength(0);
  });
  it('surfaces a database failure so the route can tell the rep', async () => {
    __mock.setDefault('crm_activities', { data: null, error: { message: 'boom' } });
    await expect(createScheduledVisit({ org_id: ORG, user_id: REP, lead: leadRow, visit: { due_at: '2026-10-12T09:30:00Z' } })).rejects.toBeTruthy();
  });
});

describe('the visit subject', () => {
  it('uses what the rep chose', () => {
    expect(visitSubject({ due_at: 'x', subject: '  Order/Collection — Kisan Seeds ' }, {})).toBe('Order/Collection — Kisan Seeds');
  });
  it('falls back to the lead: name, else company, else a generic word', () => {
    expect(visitSubject({ due_at: 'x' }, { first_name: 'Ramesh', last_name: 'K' })).toBe('Visit — Ramesh K');
    expect(visitSubject({ due_at: 'x' }, { company: 'Kisan Seeds' })).toBe('Visit — Kisan Seeds');
    expect(visitSubject({ due_at: 'x' }, {})).toBe('Visit — lead');
    expect(visitSubject({ due_at: 'x', subject: '   ' }, { first_name: 'A' })).toBe('Visit — A');
  });
});
