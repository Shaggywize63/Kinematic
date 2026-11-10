/** The Lead Management "plus" reports are available as scheduled email digests. */
import { createSupabaseMock } from './helpers/supabaseMock';
import { installTables } from './helpers/crmPlusFake';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };

import { isValidReportKey, renderDigest, reportCatalog } from '../src/services/crm/reportSchedules.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const S1 = 'a1111111-1111-1111-1111-111111111111';
const KEYS = ['source_performance', 'followup_compliance', 'owner_workload', 'stage_velocity', 'activity_mix', 'conversion_time', 'weighted_pipeline'];

beforeEach(() => __mock.reset());

describe('scheduled digests: plus reports', () => {
  it('are in the catalogue next to the existing ones, which are unchanged', () => {
    const keys = reportCatalog().map((r) => r.key);
    for (const k of KEYS) { expect(keys).toContain(k); expect(isValidReportKey(k)).toBe(true); }
    for (const k of ['summary', 'win_loss', 'forecast', 'pipeline', 'funnel', 'at_risk', 'stuck', 'lead_aging', 'distribution_daily']) expect(keys).toContain(k);
    expect(isValidReportKey('nope')).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(KEYS.filter((k) => k !== 'conversion_time'))('%s renders for an empty org as "No data for this period" instead of failing', async (key) => {
    const { subject, html } = await renderDigest({ org_id: ORG, client_id: null, frequency: 'weekly', report_key: key, name: 'Weekly' });
    expect(subject).toMatch(/^Weekly — \d{4}-\d{2}-\d{2}$/);
    expect(html).toContain('No data for this period.');
  });

  it('conversion_time renders its (empty) buckets for an empty org instead of failing', async () => {
    const { html } = await renderDigest({ org_id: ORG, client_id: null, frequency: 'monthly', report_key: 'conversion_time', name: 'Speed' });
    expect(html).toContain('Bucket');
    expect(html).toContain('60d+');
  });

  it('source_performance prints its rows as a table', async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    installTables(__mock, {
      crm_leads: [{ org_id: ORG, client_id: null, deleted_at: null, source_id: S1, status: 'new', created_at: recent, converted_at: null, converted_deal_id: null, score: 10 }],
      crm_lead_sources: [{ id: S1, org_id: ORG, name: 'Website', cost_per_lead: 0 }],
    });
    const { html } = await renderDigest({ org_id: ORG, client_id: null, frequency: 'weekly', report_key: 'source_performance', name: 'Sources' });
    expect(html).toContain('Website');
    expect(html).toContain('Conversion Pct');
    expect(html).not.toContain('No data for this period.');
  });
});
