/**
 * `activity_created` / `activity_completed` automations. The engine supported both triggers but the
 * live activity routes never fired them (the only code that did was in an unmounted controller), so a
 * tenant's "when an activity is completed" rule silently never ran. These tests pin the semantics:
 * created on insert; completed exactly when a row BECOMES completed; the parent record is passed in
 * full so actions (WhatsApp to the lead's phone, assign to the lead's owner) have what they need.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/crm/automations.service', () => ({ fireForTrigger: jest.fn().mockResolvedValue({ fired: 0, matched: 0 }) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fire = (require('../src/services/crm/automations.service') as { fireForTrigger: jest.Mock }).fireForTrigger;
import { activityTriggersFor, linkedEntityOf, fireActivityLifecycle } from '../src/services/crm/activityTriggers';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const USER = '33333333-3333-3333-3333-333333333333';
const LEAD = '11111111-1111-1111-1111-111111111111';
const DEAL = '22222222-2222-2222-2222-222222222222';
const act = (o: Record<string, unknown> = {}) => ({ id: 'a1', type: 'call', status: 'planned', lead_id: LEAD, client_id: 'c1', completed_at: null, ...o });

beforeEach(() => {
  __mock.reset();
  fire.mockClear();
  fire.mockResolvedValue({ fired: 0, matched: 0 });
  __mock.setDefault('crm_leads', { data: { id: LEAD, first_name: 'Asha', phone: '9876543210', owner_id: 'owner-1', client_id: 'c1' } });
});

describe('which triggers a write implies', () => {
  it('an insert fires created', () => {
    expect(activityTriggersFor(null, act())).toEqual(['activity_created']);
  });
  it('an insert that is already completed (a logged call) fires created AND completed', () => {
    expect(activityTriggersFor(null, act({ status: 'completed', completed_at: '2026-10-08T10:00:00Z' })))
      .toEqual(['activity_created', 'activity_completed']);
  });
  it('an update that completes it fires completed once', () => {
    expect(activityTriggersFor(act(), act({ status: 'completed', completed_at: '2026-10-08T10:00:00Z' }))).toEqual(['activity_completed']);
  });
  it('re-saving an already-completed activity fires nothing', () => {
    const done = act({ status: 'completed', completed_at: '2026-10-08T10:00:00Z' });
    expect(activityTriggersFor(done, { ...done, subject: 'edited' })).toEqual([]);
  });
  it('reopening fires nothing, and completing it again fires completed again', () => {
    const done = act({ status: 'completed', completed_at: '2026-10-08T10:00:00Z' });
    expect(activityTriggersFor(done, act({ status: 'open', completed_at: null }))).toEqual([]);
    expect(activityTriggersFor(act({ status: 'open' }), done)).toEqual(['activity_completed']);
  });
  it('an edit that leaves it open fires nothing', () => {
    expect(activityTriggersFor(act(), act({ subject: 'edited' }))).toEqual([]);
  });
});

describe('the entity an automation runs against', () => {
  it('prefers the lead, then the deal, contact and account', () => {
    expect(linkedEntityOf({ lead_id: LEAD, deal_id: DEAL })).toMatchObject({ entity: 'lead', entity_id: LEAD, table: 'crm_leads' });
    expect(linkedEntityOf({ deal_id: DEAL })).toMatchObject({ entity: 'deal', table: 'crm_deals' });
    expect(linkedEntityOf({ contact_id: 'c' })).toMatchObject({ entity: 'contact', table: 'crm_contacts' });
    expect(linkedEntityOf({ account_id: 'a' })).toMatchObject({ entity: 'account', table: 'crm_accounts' });
  });
  it('is null for an unlinked (directory-only) activity', () => {
    expect(linkedEntityOf({ lead_id: null, deal_id: '' })).toBeNull();
  });
});

describe('fireActivityLifecycle', () => {
  it('fires activity_created with the FULL parent record and the tenant client', async () => {
    await fireActivityLifecycle(ORG, USER, null, act());
    expect(fire).toHaveBeenCalledTimes(1);
    const [trigger, ctx] = fire.mock.calls[0];
    expect(trigger).toBe('activity_created');
    expect(ctx).toMatchObject({ org_id: ORG, user_id: USER, entity: 'lead', entity_id: LEAD });
    // actions read these from the context: the lead's phone (WhatsApp), owner (assign), name (templates)
    expect(ctx.data.lead).toMatchObject({ phone: '9876543210', owner_id: 'owner-1', first_name: 'Asha' });
    expect(ctx.data.activity).toMatchObject({ id: 'a1', type: 'call' });
    expect(ctx.data.client_id).toBe('c1');
    // and the parent was read inside the caller's org
    expect(__mock.chainsFor('crm_leads')[0].eqs.org_id).toBe(ORG);
  });

  it('fires only activity_completed when an update completes the activity', async () => {
    await fireActivityLifecycle(ORG, USER, act(), act({ status: 'completed', completed_at: '2026-10-08T10:00:00Z' }));
    expect(fire.mock.calls.map((c) => c[0])).toEqual(['activity_completed']);
  });

  it('fires both, in order, for an activity logged already completed', async () => {
    await fireActivityLifecycle(ORG, USER, null, act({ status: 'completed', completed_at: '2026-10-08T10:00:00Z' }));
    expect(fire.mock.calls.map((c) => c[0])).toEqual(['activity_created', 'activity_completed']);
  });

  it('uses the parent client when the activity has none', async () => {
    await fireActivityLifecycle(ORG, USER, null, act({ client_id: null }));
    expect(fire.mock.calls[0][1].data.client_id).toBe('c1');
  });

  it('still fires, with an id-only parent, if the parent lookup fails', async () => {
    __mock.setDefault('crm_leads', { data: null, error: { message: 'boom' } });
    await fireActivityLifecycle(ORG, USER, null, act());
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire.mock.calls[0][1].data.lead).toEqual({ id: LEAD });
  });

  it('fires nothing for an unlinked activity', async () => {
    await fireActivityLifecycle(ORG, USER, null, act({ lead_id: null }));
    expect(fire).not.toHaveBeenCalled();
  });

  it('never throws, even when the engine does', async () => {
    fire.mockRejectedValue(new Error('engine down'));
    await expect(fireActivityLifecycle(ORG, USER, null, act())).resolves.toBeUndefined();
  });
});
