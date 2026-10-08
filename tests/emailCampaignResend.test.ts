/**
 * "Resend to failed recipients only" for email campaigns.
 *
 * A campaign that finished with some failed sends (provider outage, unverified From, a transient 4xx/5xx)
 * can be re-opened to retry exactly those recipients. Bounced, unsubscribed, sent and skipped recipients
 * must not be touched, so nobody receives the email twice and hard bounces are never re-mailed.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/crm/emails.service', () => ({
  sendEmail: jest.fn(),
  renderTemplate: jest.fn(async (t: string) => t),
  htmlToPlainText: jest.fn((t: string) => t),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sendEmail = (require('../src/services/crm/emails.service') as { sendEmail: jest.Mock }).sendEmail;
import { resendFailedRecipients, processCampaignBatch, getAnalytics } from '../src/services/crm/emailCampaign.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CID = '44444444-4444-4444-4444-444444444444';
const SCOPE = { orgId: ORG, clientId: null, userId: '33333333-3333-3333-3333-333333333333' };
const CAMPAIGNS = 'crm_email_campaigns';
const RECIPIENTS = 'crm_email_campaign_recipients';

const campaign = (o: Record<string, unknown> = {}) => ({
  id: CID, org_id: ORG, name: 'Diwali offer', status: 'completed', subject: 'Hi', body_html: '<p>Hi</p>',
  total: 10, sent: 7, failed: 3, skipped: 0, throttle_per_min: 60, completed_at: '2026-10-08T01:00:00Z', ...o,
});

const updates = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => ({ payload: o.args[0] as Record<string, unknown>, chain: c })));

/** campaign reads return `row`; the campaign CAS update returns `casRows`; the recipients re-queue returns `requeued`. */
function stub(row: Record<string, unknown>, opts: { casRows?: unknown[]; requeued?: unknown[] } = {}) {
  __mock.setDefault(CAMPAIGNS, (chain) => (chain.ops.some((o) => o.method === 'update') ? { data: opts.casRows ?? [{ id: CID }] } : { data: row }));
  __mock.setDefault(RECIPIENTS, (chain) => {
    const upd = chain.ops.find((o) => o.method === 'update');
    if (upd && (upd.args[0] as { status?: string }).status === 'queued') return { data: opts.requeued ?? [] };
    return { data: [] };
  });
}

beforeEach(() => {
  __mock.reset();
  sendEmail.mockReset();
});

describe('resendFailedRecipients', () => {
  it('re-queues exactly the failed recipients and re-opens the campaign', async () => {
    stub(campaign(), { requeued: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] });
    const out = await resendFailedRecipients(SCOPE, CID);
    expect(out.requeued).toBe(3);

    // only rows that are `failed` in THIS campaign flip back to queued — never sent / skipped / bounced / unsubscribed
    const requeue = updates(RECIPIENTS).find((u) => u.payload.status === 'queued')!;
    expect(requeue.chain.eqs).toMatchObject({ campaign_id: CID, status: 'failed' });

    // the campaign re-opens with a compare-and-swap on `completed`, and the 3 are no longer counted as failed
    const reopen = updates(CAMPAIGNS).find((u) => u.payload.status === 'sending')!;
    expect(reopen.chain.eqs).toMatchObject({ id: CID, org_id: ORG, status: 'completed' });
    expect(reopen.payload).toMatchObject({ failed: 0, completed_at: null, last_batch_at: null });
    // `total`, `sent` and `skipped` are not reset: nothing already delivered is re-counted
    expect(reopen.payload).not.toHaveProperty('total');
    expect(reopen.payload).not.toHaveProperty('sent');
  });

  it('only subtracts the rows it actually re-queued from the failed counter', async () => {
    stub(campaign({ failed: 5 }), { requeued: [{ id: 'r1' }, { id: 'r2' }] }); // counter had drifted: 5 vs 2 real
    await resendFailedRecipients(SCOPE, CID);
    expect(updates(CAMPAIGNS).find((u) => u.payload.status === 'sending')!.payload.failed).toBe(3);
  });

  it.each(['draft', 'sending', 'paused', 'cancelled'])('refuses a %s campaign and changes nothing', async (status) => {
    stub(campaign({ status }));
    await expect(resendFailedRecipients(SCOPE, CID)).rejects.toMatchObject({ statusCode: 400, code: 'BAD_STATE' });
    expect(updates(RECIPIENTS)).toHaveLength(0);
    expect(updates(CAMPAIGNS)).toHaveLength(0);
  });

  it('refuses when nothing failed, without re-opening the campaign', async () => {
    stub(campaign({ failed: 0 }), { requeued: [] });
    await expect(resendFailedRecipients(SCOPE, CID)).rejects.toMatchObject({ statusCode: 400, code: 'NO_FAILED_RECIPIENTS' });
    expect(updates(CAMPAIGNS)).toHaveLength(0);
  });

  it('puts the rows back as failed if the campaign was changed under it (a double click, a cancel)', async () => {
    stub(campaign(), { requeued: [{ id: 'r1' }, { id: 'r2' }], casRows: [] });
    await expect(resendFailedRecipients(SCOPE, CID)).rejects.toMatchObject({ statusCode: 409, code: 'BAD_STATE' });
    const revert = updates(RECIPIENTS).find((u) => u.payload.status === 'failed')!;
    expect(revert).toBeTruthy();
    expect(revert.chain.ops.find((o) => o.method === 'in')!.args).toEqual(['id', ['r1', 'r2']]);
  });

  it('rejects an invalid campaign id', async () => {
    await expect(resendFailedRecipients(SCOPE, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('a resent recipient', () => {
  it('has its earlier error cleared once the retry goes through', async () => {
    __mock.setDefault(CAMPAIGNS, { data: campaign({ status: 'sending', failed: 0 }) });
    let queuedCall = 0;
    __mock.setDefault(RECIPIENTS, (chain) => {
      const m = chain.ops.map((o) => o.method);
      if (m.includes('update') && m.includes('select') && m.includes('in')) {
        return { data: [{ id: 'r1', email: 'a@b.co', vars: {}, lead_id: null, error: 'boom' }] }; // the claim
      }
      if (m.includes('select') && !m.includes('update')) { queuedCall++; return { data: queuedCall === 1 ? [{ id: 'r1' }] : [] }; }
      return { data: [] };
    });
    sendEmail.mockResolvedValue({ id: 'log1', status: 'sent' });
    await processCampaignBatch(ORG, CID);
    const sent = updates(RECIPIENTS).find((u) => u.payload.status === 'sent')!;
    expect(sent.payload).toMatchObject({ status: 'sent', error: null });
  });
});

/** Email-log counts by the filter the analytics query applies: no status = all attempts, 'failed' = failed attempts, anything else 0. */
const logCounts = (c: { total: number; failed: number }) => (chain: { eqs: Record<string, unknown> }) => ({
  data: null,
  count: chain.eqs.status === undefined ? c.total : chain.eqs.status === 'failed' ? c.failed : 0,
});

describe('getAnalytics', () => {
  it('reports recipients that are failed NOW, not failed attempts, so a successful resend brings it to zero', async () => {
    __mock.setDefault(CAMPAIGNS, { data: campaign({ status: 'sending', total: 10, sent: 10, failed: 0 }) });
    // email log: 13 attempts (10 + 3 retried), 3 of them failed attempts that were since retried successfully
    __mock.setDefault('crm_email_logs', logCounts({ total: 13, failed: 3 }));
    __mock.setDefault(RECIPIENTS, (chain) => ({ data: [], count: chain.eqs.status === 'failed' ? 0 : 10 }));
    const a = await getAnalytics(SCOPE, CID);
    expect(a.totals.failed).toBe(0);
    // delivered still nets the old failed attempts out of the 13 logged: 10 recipients were delivered
    expect(a.totals.delivered).toBe(10);
  });

  it('shows the recipients that failed again after a resend', async () => {
    __mock.setDefault(CAMPAIGNS, { data: campaign({ failed: 1 }) });
    __mock.setDefault('crm_email_logs', logCounts({ total: 13, failed: 4 }));
    __mock.setDefault(RECIPIENTS, (chain) => ({ data: [], count: chain.eqs.status === 'failed' ? 1 : 10 }));
    const a = await getAnalytics(SCOPE, CID);
    expect(a.totals.failed).toBe(1);
    expect(a.totals.delivered).toBe(9);
  });
});
