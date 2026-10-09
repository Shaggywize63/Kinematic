/**
 * Contract H, part 1 + 2: `crm_settings.config.lead_form.owner_assignment = 'admin_only'`.
 *
 *   - the setting is accepted by the settings validator (null / undefined clear it), stored, and served back
 *     inside config.lead_form by GET /crm/settings;
 *   - for a client WITH it, a person who is not an admin (expenses' isApprover) cannot choose or change a
 *     lead's owner on any user-facing path: lead create (owner ignored), lead edit (403 OWNER_ASSIGN_FORBIDDEN,
 *     unless the owner is unchanged), bulk assign (403), CSV import (owner columns ignored), the marketing
 *     visit's new lead (owner ignored), KINI (reassign tools refused) and MCP update_lead (refused);
 *   - for a client WITHOUT it, every one of those paths behaves exactly as before (the "unchanged" tests are
 *     a table of today's behaviour; they were run against the code before this change too).
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// The caller of the next request (set by `as(...)`).
let mockUser: Record<string, unknown> = {};
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => { req.user = { ...mockUser }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requireModule: () => (_req: any, _res: any, next: any) => next(),
  requireModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  requireAnyModuleAccess: () => (_req: any, _res: any, next: any) => next(),
  moduleAccessAllowed: () => true,
}));
jest.mock('../src/utils/demoCrm', () => ({ demoCrmMiddleware: (_req: any, _res: any, next: any) => next() }));
jest.mock('../src/lib/oauth/store', () => ({ recordAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/crm/leads.service', () => ({
  ...jest.requireActual('../src/services/crm/leads.service'),
  createLead: jest.fn(), updateLead: jest.fn(), bulkAssign: jest.fn(),
}));
jest.mock('../src/services/crm/import.service', () => ({
  ...jest.requireActual('../src/services/crm/import.service'),
  commitJob: jest.fn(),
}));
jest.mock('../src/services/crm/marketingVisits.service', () => ({
  ...jest.requireActual('../src/services/crm/marketingVisits.service'),
  startMarketingVisit: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { AppError } from '../src/utils';
import * as v from '../src/validators/crm.validators';
import * as leadsSvc from '../src/services/crm/leads.service';
import * as importSvc from '../src/services/crm/import.service';
import * as marketingSvc from '../src/services/crm/marketingVisits.service';
import * as ownerAssign from '../src/services/crm/ownerAssignment';
import { isAdminOnlyOwnerAssignment } from '../src/services/crm/leadFormConfig';
import { executeTool } from '../src/services/crm/ai/kiniTools.service';
import { buildMcpServer } from '../src/mcp/server';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crmRouter = require('../src/routes/crm.routes').default as express.Router;

const createLead = leadsSvc.createLead as unknown as jest.Mock;
const updateLead = leadsSvc.updateLead as unknown as jest.Mock;
const bulkAssign = leadsSvc.bulkAssign as unknown as jest.Mock;
const commitJob = importSvc.commitJob as unknown as jest.Mock;
const startVisit = marketingSvc.startMarketingVisit as unknown as jest.Mock;

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '55555555-5555-5555-5555-555555555555';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const REP = '11111111-1111-1111-1111-111111111111';
const SUP = '66666666-6666-6666-6666-666666666666';
const OWNER = '22222222-2222-2222-2222-222222222222';
const CURRENT = '44444444-4444-4444-4444-444444444444';
const LEAD = '77777777-7777-7777-7777-777777777777';

/** The people we test with. `legacyCanAssign` = is the role in crm.routes.ts OWNER_ASSIGN_ROLES (today's rule). */
const PEOPLE = {
  admin:       { id: ADMIN, role: 'admin',      org_role_data_scope: 'all' },
  superAdmin:  { id: ADMIN, role: 'super_admin', org_role_data_scope: 'all' },
  client:      { id: ADMIN, role: 'client',     org_role_data_scope: 'all' },
  // a flat field-force tenant gives reps the sub_admin role; only the own data scope tells them from a manager
  subAdminOwn: { id: REP,   role: 'sub_admin',  org_role_data_scope: 'own' },
  supervisor:  { id: SUP,   role: 'supervisor', org_role_data_scope: 'team' },
  rep:         { id: REP,   role: 'executive',  org_role_data_scope: 'own' },
} as const;
type Person = keyof typeof PEOPLE;
const as = (p: Person) => { mockUser = { org_id: ORG, client_id: CLIENT, ...PEOPLE[p] }; };
const actorOf = (p: Person) => ({ id: PEOPLE[p].id, org_id: ORG, client_id: CLIENT, role: PEOPLE[p].role, data_scope: PEOPLE[p].org_role_data_scope });

const FLAGGED = { lead_form: { owner_assignment: 'admin_only' } };
let config: Record<string, unknown> = {};
const flagged = () => { config = FLAGGED; };

const app = express();
app.use(express.json());
app.use('/crm', crmRouter);

beforeEach(() => {
  __mock.reset();
  config = {};
  as('rep');
  createLead.mockReset().mockImplementation(async ({ payload, user_id }: any) => ({ id: 'lead-1', first_name: 'Ramesh', owner_id: payload.owner_id ?? user_id }));
  updateLead.mockReset().mockImplementation(async (_o: string, id: string, p: any) => ({ id, ...p }));
  bulkAssign.mockReset().mockResolvedValue({ updated: 2 });
  commitJob.mockReset().mockResolvedValue({ id: 'job-1', status: 'running' });
  startVisit.mockReset().mockResolvedValue({ visit: { id: 'v1' }, lead: { id: 'lead-1' } });
  __mock.setDefault('crm_settings', () => ({ data: [{ id: 'cs-1', config }] }));
  // the lead being edited: created by the caller (so a rep passes the "only the creator may edit" rule), owned by CURRENT
  __mock.setDefault('crm_leads', () => ({ data: [{ created_by: (mockUser as any).id, owner_id: CURRENT, client_id: CLIENT }] }));
});

// ── the setting itself ──────────────────────────────────────────────────────
describe('lead_form.owner_assignment in the settings API', () => {
  const ok = (lead_form: unknown) => v.settingsUpdateSchema.safeParse({ config: { lead_form } });

  it("accepts 'admin_only', alone and next to the other lead_form keys", () => {
    expect(ok({ owner_assignment: 'admin_only' }).success).toBe(true);
    expect(ok({ segment_labels: { b2b: 'Dealer', b2c: 'Farmers' }, address_on_b2b: true, schedule_visit: { segments: ['b2b'] }, owner_assignment: 'admin_only' }).success).toBe(true);
  });
  it('accepts null and undefined to clear it', () => {
    expect(ok({ owner_assignment: null }).success).toBe(true);
    expect(ok({ owner_assignment: undefined }).success).toBe(true);
    expect(ok({}).success).toBe(true);
    expect(ok(null).success).toBe(true);                                  // the whole block can still be cleared
  });
  it('rejects anything else, and keeps the block strict', () => {
    for (const bad of ['anyone', 'ADMIN_ONLY', 'admin', '', true, false, 1, ['admin_only'], {}]) {
      expect({ bad, ok: ok({ owner_assignment: bad }).success }).toEqual({ bad, ok: false });
    }
    expect(ok({ owner_assignment: 'admin_only', nonsense: 1 }).success).toBe(false);
  });
  it('reports a bad value against lead_form.owner_assignment', () => {
    const r = ok({ owner_assignment: 'everyone' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['config', 'lead_form', 'owner_assignment']);
  });
  it('is read as on only for exactly admin_only (absent, null and unknown values are off)', () => {
    expect(isAdminOnlyOwnerAssignment({ owner_assignment: 'admin_only' })).toBe(true);
    for (const off of [null, undefined, {}, { owner_assignment: null }, { owner_assignment: 'anyone' }, { owner_assignment: true }]) {
      expect(isAdminOnlyOwnerAssignment(off as any)).toBe(false);
    }
  });

  it('PATCH /crm/settings stores it inside config.lead_form, and 400s a bad value', async () => {
    as('admin');
    const res = await request(app).patch('/crm/settings').send({ config: { lead_form: { owner_assignment: 'admin_only' } } });
    expect(res.status).toBe(200);
    const upd = __mock.chainsFor('crm_settings').flatMap((c) => c.ops).find((o) => o.method === 'update');
    expect((upd!.args[0] as any).config.lead_form).toEqual({ owner_assignment: 'admin_only' });

    const bad = await request(app).patch('/crm/settings').send({ config: { lead_form: { owner_assignment: 'nobody' } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');
  });
  it('GET /crm/settings returns it inside config.lead_form, to any CRM user', async () => {
    config = { lead_form: { segment_labels: { b2b: 'Dealer' }, owner_assignment: 'admin_only' } };
    as('rep');
    const res = await request(app).get('/crm/settings');
    expect(res.status).toBe(200);
    expect(res.body.data.config.lead_form).toEqual({ segment_labels: { b2b: 'Dealer' }, owner_assignment: 'admin_only' });
  });
});

// ── the pure rule + the guards ──────────────────────────────────────────────
describe('who counts as an admin', () => {
  it('is expenses isApprover: admin-class roles, never an own-scope field exec', () => {
    const can = (p: Person) => ownerAssign.canChooseOwner(true, actorOf(p));
    expect(can('admin')).toBe(true);
    expect(can('superAdmin')).toBe(true);
    expect(can('client')).toBe(true);
    expect(can('subAdminOwn')).toBe(false);       // sub_admin by role, a rep by data scope
    expect(can('supervisor')).toBe(false);        // today's assignment rule allows them; the admin rule does not
    expect(can('rep')).toBe(false);
  });
  it('is everyone when the switch is off', () => {
    for (const p of Object.keys(PEOPLE) as Person[]) expect(ownerAssign.canChooseOwner(false, actorOf(p))).toBe(true);
  });
  it('treats an unreadable settings row as "off" instead of failing the request', async () => {
    __mock.setDefault('crm_settings', { data: null, error: { message: 'boom' } });
    expect(await ownerAssign.adminOnlyOwnerAssignment(ORG, CLIENT)).toBe(false);
    expect(await ownerAssign.mayChooseOwner(actorOf('rep'))).toBe(true);
  });
  it('reads the org-level default row when the client has no row of its own (what GET /crm/settings serves)', async () => {
    __mock.setDefault('crm_settings', (c) => (c.eqs.client_id ? { data: [] } : { data: [{ config: FLAGGED }] }));
    expect(await ownerAssign.adminOnlyOwnerAssignment(ORG, CLIENT)).toBe(true);
  });
  it('does not read the settings at all for an admin', async () => {
    expect(await ownerAssign.mayChooseOwner(actorOf('admin'))).toBe(true);
    expect(__mock.chainsFor('crm_settings')).toHaveLength(0);
  });
});

// ── POST /crm/leads ─────────────────────────────────────────────────────────
describe('POST /crm/leads', () => {
  const body = { first_name: 'Ramesh', phone: '9876543210', is_b2c: false };
  const create = (extra: object = {}) => request(app).post('/crm/leads').send({ ...body, ...extra });
  const sentPayload = () => (createLead.mock.calls[0][0] as any).payload as Record<string, unknown>;

  describe("with owner_assignment = 'admin_only'", () => {
    beforeEach(flagged);

    it.each(['rep', 'subAdminOwn', 'supervisor'] as Person[])('ignores the owner a %s sends: the lead takes the default owner (the creator)', async (p) => {
      as(p);
      const res = await create({ owner_id: OWNER });
      expect(res.status).toBe(201);
      expect('owner_id' in sentPayload()).toBe(false);
      expect(res.body.data.owner_id).toBe(PEOPLE[p].id);            // createLead's default chain made the creator the owner
    });
    it.each(['admin', 'superAdmin', 'client'] as Person[])('lets a %s choose the owner', async (p) => {
      as(p);
      const res = await create({ owner_id: OWNER });
      expect(res.status).toBe(201);
      expect(sentPayload().owner_id).toBe(OWNER);
    });
    it('changes nothing for a lead sent without an owner', async () => {
      as('rep');
      const res = await create();
      expect(res.status).toBe(201);
      expect('owner_id' in sentPayload()).toBe(false);
    });
    it('keeps Schedule Visit working: the visit is assigned to the lead owner (the creator), not the ignored owner', async () => {
      as('rep');
      __mock.setDefault('crm_activities', { data: [{ id: 'act-1', due_at: '2026-10-12T05:00:00.000Z' }] });
      const res = await create({ owner_id: OWNER, schedule_visit: { due_at: '2026-10-12T10:30:00+05:30', subject: 'Dealer Visit' } });
      expect(res.status).toBe(201);
      expect(res.body.data.scheduled_visit).toEqual({ id: 'act-1', due_at: '2026-10-12T05:00:00.000Z' });
      const row = __mock.chainsFor('crm_activities').flatMap((c) => c.ops).find((o) => o.method === 'insert')!.args[0] as any;
      expect(row).toMatchObject({ lead_id: 'lead-1', status: 'planned', owner_id: REP, assigned_to: REP });
    });
  });

  describe('without it (unchanged)', () => {
    // today's rule: crm.routes.ts OWNER_ASSIGN_ROLES decides, nothing else
    const TODAY: Array<[Person, boolean]> = [
      ['admin', true], ['superAdmin', true], ['client', true], ['subAdminOwn', true], ['supervisor', true], ['rep', false],
    ];
    const OFF_VARIANTS: Array<[string, Record<string, unknown>]> = [
      ['no lead_form at all', {}],
      ['a lead_form without it', { lead_form: { segment_labels: { b2b: 'Dealer' } } }],
      ['owner_assignment: null', { lead_form: { owner_assignment: null } }],
      ['an unknown value', { lead_form: { owner_assignment: 'anyone' } }],
    ];
    for (const [label, cfg] of OFF_VARIANTS) {
      it.each(TODAY)(`${label}: a %s sending an owner keeps it (%s)`, async (p, keeps) => {
        config = cfg; as(p);
        const res = await create({ owner_id: OWNER });
        expect(res.status).toBe(201);
        expect(sentPayload().owner_id).toBe(keeps ? OWNER : undefined);
        expect('owner_id' in sentPayload()).toBe(keeps);
      });
    }
    it('passes the payload to createLead exactly as the route always built it', async () => {
      as('supervisor');
      await create({ owner_id: OWNER });
      expect(sentPayload()).toEqual({ first_name: 'Ramesh', phone: '9876543210', is_b2c: false, owner_id: OWNER, client_id: CLIENT });
    });
  });
});

// ── PATCH /crm/leads/:id ────────────────────────────────────────────────────
describe('PATCH /crm/leads/:id', () => {
  const patch = (b: object) => request(app).patch(`/crm/leads/${LEAD}`).send(b);
  const sent = () => updateLead.mock.calls[0][2] as Record<string, unknown>;

  describe("with owner_assignment = 'admin_only'", () => {
    beforeEach(flagged);

    it.each(['rep', 'subAdminOwn', 'supervisor'] as Person[])('refuses a %s who sets a different owner: 403 OWNER_ASSIGN_FORBIDDEN', async (p) => {
      as(p);
      const res = await patch({ owner_id: OWNER, notes: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toEqual({ code: 'OWNER_ASSIGN_FORBIDDEN', message: 'Only an admin can assign leads' });
      expect(updateLead).not.toHaveBeenCalled();
    });
    it('does not fail when the app resends the unchanged owner (and never rewrites it)', async () => {
      as('rep');
      const res = await patch({ owner_id: CURRENT, notes: 'x' });
      expect(res.status).toBe(200);
      expect(sent()).toEqual({ notes: 'x' });
    });
    it('compares owners case-insensitively', async () => {
      as('rep');
      expect((await patch({ owner_id: CURRENT.toUpperCase(), notes: 'x' })).status).toBe(200);
    });
    it('treats clearing the owner of an owned lead as a change, and "no owner" on an unowned lead as none', async () => {
      as('rep');
      expect((await patch({ owner_id: null })).status).toBe(403);
      __mock.setDefault('crm_leads', () => ({ data: [{ created_by: REP, owner_id: null }] }));
      updateLead.mockClear();
      const res = await patch({ owner_id: null, notes: 'x' });
      expect(res.status).toBe(200);
      expect(sent()).toEqual({ notes: 'x' });
    });
    it('leaves an edit that does not mention the owner alone', async () => {
      as('rep');
      const res = await patch({ notes: 'x', status: 'working' });
      expect(res.status).toBe(200);
      expect(sent()).toEqual({ notes: 'x', status: 'working' });
    });
    it.each(['admin', 'superAdmin', 'client'] as Person[])('lets a %s change the owner', async (p) => {
      as(p);
      const res = await patch({ owner_id: OWNER });
      expect(res.status).toBe(200);
      expect(sent().owner_id).toBe(OWNER);
    });
    it('still 404s a lead that does not exist (the owner check neither masks nor pre-empts it)', async () => {
      as('subAdminOwn');
      __mock.setDefault('crm_leads', { data: [] });
      updateLead.mockRejectedValueOnce(new AppError(404, 'Lead not found', 'NOT_FOUND'));     // what the real updateLead does
      const res = await patch({ owner_id: OWNER });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('without it (unchanged)', () => {
    it('a rep who sets an owner has it silently dropped, as today (no error)', async () => {
      as('rep');
      const res = await patch({ owner_id: OWNER, notes: 'x' });
      expect(res.status).toBe(200);
      expect(sent()).toEqual({ notes: 'x' });
    });
    it.each(['admin', 'superAdmin', 'client', 'subAdminOwn', 'supervisor'] as Person[])('a %s who sets an owner has it applied, as today', async (p) => {
      as(p);
      // a supervisor is not an admin tier, so the "only the creator may edit" rule needs them to be the creator
      const res = await patch({ owner_id: OWNER, notes: 'x' });
      expect(res.status).toBe(200);
      expect(sent()).toEqual({ owner_id: OWNER, notes: 'x' });
    });
    it('an unchanged owner is passed straight through for someone who may assign, as today', async () => {
      as('supervisor');
      const res = await patch({ owner_id: CURRENT, notes: 'x' });
      expect(res.status).toBe(200);
      expect(sent()).toEqual({ owner_id: CURRENT, notes: 'x' });
    });
    it('reads the lead only for the creator check, never for the owner', async () => {
      as('rep');
      await patch({ owner_id: OWNER });
      expect(__mock.chainsFor('crm_leads').map((c) => c.ops.find((o) => o.method === 'select')!.args[0])).toEqual(['created_by']);
    });
  });
});

// ── POST /crm/leads/bulk-assign ─────────────────────────────────────────────
describe('POST /crm/leads/bulk-assign', () => {
  const assign = () => request(app).post('/crm/leads/bulk-assign').send({ lead_ids: [LEAD], owner_id: OWNER });

  describe("with owner_assignment = 'admin_only'", () => {
    beforeEach(flagged);
    it.each(['rep', 'subAdminOwn', 'supervisor'] as Person[])('refuses a %s with 403 OWNER_ASSIGN_FORBIDDEN', async (p) => {
      as(p);
      const res = await assign();
      expect(res.status).toBe(403);
      expect(res.body.error).toEqual({ code: 'OWNER_ASSIGN_FORBIDDEN', message: 'Only an admin can assign leads' });
      expect(bulkAssign).not.toHaveBeenCalled();
    });
    it.each(['admin', 'superAdmin', 'client'] as Person[])('lets a %s assign', async (p) => {
      as(p);
      const res = await assign();
      expect(res.status).toBe(200);
      expect(bulkAssign).toHaveBeenCalledWith(ORG, [LEAD], OWNER, PEOPLE[p].id);
    });
    it('still validates the body first', async () => {
      as('rep');
      expect((await request(app).post('/crm/leads/bulk-assign').send({ lead_ids: ['nope'], owner_id: OWNER })).status).toBe(400);
    });
  });
  describe('without it (unchanged)', () => {
    it.each(Object.keys(PEOPLE) as Person[])('lets a %s assign, as today (this endpoint has never had a role gate)', async (p) => {
      as(p);
      const res = await assign();
      expect(res.status).toBe(200);
      expect(bulkAssign).toHaveBeenCalledWith(ORG, [LEAD], OWNER, PEOPLE[p].id);
    });
  });
});

// ── the other user-facing paths ─────────────────────────────────────────────
describe('CSV import commit', () => {
  const commit = () => request(app).post('/crm/import/commit').send({ job_id: '88888888-8888-8888-8888-888888888888' });

  it("tells the import to ignore the owner columns for a non-admin on an 'admin_only' client", async () => {
    flagged();
    for (const p of ['rep', 'subAdminOwn', 'supervisor'] as Person[]) {
      commitJob.mockClear(); as(p);
      expect((await commit()).status).toBe(200);
      expect({ p, args: commitJob.mock.calls[0] }).toEqual({ p, args: [ORG, expect.any(String), PEOPLE[p].id, CLIENT, true] });
    }
  });
  it('lets an admin import owners', async () => {
    flagged(); as('admin');
    await commit();
    expect(commitJob.mock.calls[0][4]).toBe(false);
  });
  it('is untouched for a client without the setting', async () => {
    for (const p of Object.keys(PEOPLE) as Person[]) {
      commitJob.mockClear(); as(p);
      await commit();
      expect(commitJob.mock.calls[0][4] ?? false).toBe(false);          // (no 5th argument at all before this change)
    }
  });
});

describe('importing leads with an owner column (the service)', () => {
  const BOSS = '99999999-9999-9999-9999-999999999999';
  const flush = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setImmediate(r)); };

  async function runImport(ignoreOwnerColumns: boolean) {
    const orchestrator = require('../src/services/crm/integrations/dedup.orchestrator');
    const find = jest.spyOn(orchestrator, 'findOrCreateLead').mockResolvedValue({ lead_id: 'l1', was_new: true });
    __mock.setDefault('crm_import_jobs', {
      data: [{ id: 'job-1', kind: 'leads', mapping: { Name: 'first_name', Owner: 'owner_email' }, errors: [], data: { rows: [{ Name: 'Asha', Owner: 'boss@agri.test' }] } }],
    });
    __mock.setDefault('crm_lead_sources', { data: [{ id: 'src-1', name: 'Excel/CSV Import' }] });
    __mock.setDefault('users', { data: [{ id: BOSS, email: 'boss@agri.test', name: 'Boss' }] });
    // the real commitJob (the route test above mocks it)
    const real = jest.requireActual('../src/services/crm/import.service') as typeof import('../src/services/crm/import.service');
    await real.commitJob(ORG, 'job-1', REP, CLIENT, ignoreOwnerColumns);
    await flush(() => find.mock.calls.length > 0);
    const arg = find.mock.calls[0][0] as { owner_id?: string | null };
    find.mockRestore();
    return arg.owner_id;
  }

  it('assigns the owner the file names, as before', async () => {
    expect(await runImport(false)).toBe(BOSS);
  });
  it('ignores it when the importer may not choose owners: the lead takes the default owner', async () => {
    expect(await runImport(true)).toBeNull();
  });
});

describe('marketing visit: the new lead', () => {
  const start = (lead: object) => request(app).post('/crm/marketing-visits/start').send({ lead });
  const lead = { first_name: 'Ramesh', phone: '9876543210', owner_id: OWNER };

  it("ignores a non-admin's owner on an 'admin_only' client, keeps an admin's", async () => {
    flagged();
    as('rep');
    expect((await start(lead)).status).toBe(201);
    expect('owner_id' in (startVisit.mock.calls[0][0].lead as object)).toBe(false);
    startVisit.mockClear(); as('admin');
    await start(lead);
    expect(startVisit.mock.calls[0][0].lead.owner_id).toBe(OWNER);
  });
  it('is untouched for a client without the setting (a rep keeps passing an owner, as today)', async () => {
    as('rep');
    await start(lead);
    expect(startVisit.mock.calls[0][0].lead.owner_id).toBe(OWNER);
  });
});

describe('convert has no owner to choose', () => {
  it('takes no owner input; the contact, account and deal inherit the lead owner', () => {
    const parsed = v.leadConvertSchema.parse({ create_deal: true, owner_id: OWNER, deal_owner_id: OWNER });
    expect('owner_id' in parsed).toBe(false);
    expect('deal_owner_id' in parsed).toBe(false);
  });
});

describe('KINI (the assistant acts as the user)', () => {
  const exec = (name: string, args: Record<string, unknown>, p: Person) =>
    executeTool(ORG, CLIENT, name, args, { user_id: PEOPLE[p].id, role: PEOPLE[p].role, data_scope: PEOPLE[p].org_role_data_scope });

  it("refuses crm_update_lead's owner change for a non-admin, but not the same owner sent back", async () => {
    flagged();
    const refused = await exec('crm_update_lead', { id: LEAD, owner_id: OWNER }, 'rep');
    expect(refused!.data).toEqual({ error: 'Only an admin can assign leads' });
    expect(updateLead).not.toHaveBeenCalled();

    const same = await exec('crm_update_lead', { id: LEAD, owner_id: CURRENT, notes: 'n' }, 'rep');
    expect((same!.data as any).error).toBeUndefined();
    expect(updateLead.mock.calls[0][2]).toEqual({ notes: 'n' });
  });
  it('lets an admin reassign', async () => {
    flagged();
    await exec('crm_update_lead', { id: LEAD, owner_id: OWNER }, 'admin');
    expect(updateLead.mock.calls[0][2]).toEqual({ owner_id: OWNER });
  });
  it('refuses crm_bulk_reassign_leads to a manager who is not an admin', async () => {
    flagged();
    const r = await exec('crm_bulk_reassign_leads', { new_owner_id: OWNER, status: 'new' }, 'supervisor');
    expect(r!.data).toEqual({ error: 'Only an admin can assign leads' });
    expect(__mock.chainsFor('crm_leads').flatMap((c) => c.ops).some((o) => o.method === 'update')).toBe(false);
  });
  it('lets an admin bulk-reassign', async () => {
    flagged();
    __mock.setDefault('crm_leads', () => ({ data: [{ id: LEAD }] }));
    const r = await exec('crm_bulk_reassign_leads', { new_owner_id: OWNER, status: 'new' }, 'admin');
    expect((r!.data as any).affected).toBe(1);
  });
  it('is untouched for a client without the setting', async () => {
    await exec('crm_update_lead', { id: LEAD, owner_id: OWNER }, 'rep');
    expect(updateLead.mock.calls[0][2]).toEqual({ owner_id: OWNER });
    __mock.setDefault('crm_leads', () => ({ data: [{ id: LEAD }] }));
    const r = await exec('crm_bulk_reassign_leads', { new_owner_id: OWNER, status: 'new' }, 'supervisor');
    expect((r!.data as any).affected).toBe(1);
  });
  it('without a role in the context (the legacy v1 endpoints) is not an admin under the setting', async () => {
    flagged();
    const r = await executeTool(ORG, CLIENT, 'crm_update_lead', { id: LEAD, owner_id: OWNER }, { user_id: ADMIN });
    expect((r!.data as any).error).toBe('Only an admin can assign leads');
  });
});

describe('MCP update_lead (the connected assistant acts as the user)', () => {
  const run = async (p: Person, args: Record<string, unknown>) => {
    const server: any = buildMcpServer({ user: { org_id: ORG, client_id: CLIENT, ...PEOPLE[p] }, oauth: { scopes: ['leads:write'], clientId: 'chatgpt' } } as any);
    return server._registeredTools.update_lead.handler({ lead_id: LEAD, ...args }, {});
  };
  const updates = () => __mock.chainsFor('crm_leads').flatMap((c) => c.ops).filter((o) => o.method === 'update').map((o) => o.args[0] as any);

  it('refuses a non-admin who changes the owner', async () => {
    flagged();
    const r = await run('rep', { owner_id: OWNER });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Only an admin can assign leads');
    expect(updates()).toHaveLength(0);
  });
  it('lets the same owner sent back through, and an admin change it', async () => {
    flagged();
    expect((await run('rep', { owner_id: CURRENT, notes: 'n' })).isError).toBeUndefined();
    expect(updates()[0]).toMatchObject({ notes: 'n' });
    expect('owner_id' in updates()[0]).toBe(false);
    expect((await run('admin', { owner_id: OWNER })).isError).toBeUndefined();
    expect(updates()[1].owner_id).toBe(OWNER);
  });
  it('is untouched for a client without the setting', async () => {
    expect((await run('rep', { owner_id: OWNER })).isError).toBeUndefined();
    expect(updates()[0].owner_id).toBe(OWNER);
  });
});
