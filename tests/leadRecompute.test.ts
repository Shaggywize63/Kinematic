/**
 * Lead SCORE + NBA auto-recompute on update.
 *
 * Any change to a lead must refresh its AI intelligence: recompute + persist the
 * heuristic score and invalidate the cached next-best-action. These lock the
 * wiring added to `recomputeLeadIntelligence` and `updateLead`, with the scoring
 * engine stubbed so the assertions are about the persistence/invalidation, not
 * the heuristic maths (which has its own coverage).
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// Stub the scoring engine: computeUnifiedScore returns a fixed result so we can
// assert exactly what gets persisted; rerankLeadAsync is a spy.
jest.mock('../src/services/crm/ai/leadScoring.service', () => ({
  computeUnifiedScore: jest.fn(async () => ({
    score: 77, grade: 'B',
    breakdown: { model: 'heuristic_v2', factors: [] },
    engagement: {}, profile: 'b2c',
  })),
  rerankLeadAsync: jest.fn(async () => undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as leads from '../src/services/crm/leads.service';
import * as scoring from '../src/services/crm/ai/leadScoring.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const LEAD = '33333333-3333-3333-3333-333333333333';
const SELF = '22222222-2222-2222-2222-222222222222';

const crmLeadUpdatePayloads = () =>
  __mock.chainsFor('crm_leads')
    .map((c) => c.ops.find((o) => o.method === 'update')?.args[0] as Record<string, unknown> | undefined)
    .filter((p): p is Record<string, unknown> => !!p);

beforeEach(() => {
  __mock.reset();
  jest.clearAllMocks();
});

describe('recomputeLeadIntelligence', () => {
  it('persists the fresh score/grade/breakdown and invalidates the NBA cache', async () => {
    __mock.setDefault('crm_leads', { data: [{ id: LEAD, org_id: ORG, client_id: CLIENT, status: 'working' }] });

    await leads.recomputeLeadIntelligence(ORG, LEAD);

    const payloads = crmLeadUpdatePayloads();
    const scored = payloads.find((p) => 'score' in p);
    expect(scored).toBeTruthy();
    expect(scored!.score).toBe(77);
    expect(scored!.score_grade).toBe('B');
    expect(scored).toHaveProperty('score_breakdown');
    expect(scored!.next_action_updated_at).toBeNull(); // NBA cache busted
    // Default is heuristic-only — no paid LLM rerank per edit.
    expect(scoring.rerankLeadAsync).not.toHaveBeenCalled();
  });

  it('fires the LLM rerank only when llmRerank is requested', async () => {
    __mock.setDefault('crm_leads', { data: [{ id: LEAD, org_id: ORG, client_id: CLIENT }] });
    await leads.recomputeLeadIntelligence(ORG, LEAD, { llmRerank: true });
    expect(scoring.rerankLeadAsync).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('never throws even if scoring blows up — a mutation must not fail on it', async () => {
    (scoring.computeUnifiedScore as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    __mock.setDefault('crm_leads', { data: [{ id: LEAD, org_id: ORG, client_id: CLIENT }] });
    await expect(leads.recomputeLeadIntelligence(ORG, LEAD)).resolves.toBeUndefined();
  });
});

describe('updateLead — auto-recompute on any edit', () => {
  it('recomputes the score inline (returns it on the row) and invalidates NBA', async () => {
    __mock.setDefault('crm_leads', { data: [{ id: LEAD, org_id: ORG, client_id: CLIENT, status: 'working', score: 10 }] });
    __mock.setDefault('crm_settings', { data: { config: {} } });

    const updated = await leads.updateLead(ORG, LEAD, { city: 'Pune' }, SELF) as Record<string, unknown>;

    // The returned row already carries the recomputed score (the UI folds it in).
    expect(updated.score).toBe(77);
    expect(updated.score_grade).toBe('B');
    expect(scoring.computeUnifiedScore).toHaveBeenCalled();
    // A crm_leads write invalidated the NBA cache.
    expect(crmLeadUpdatePayloads().some((p) => p.next_action_updated_at === null)).toBe(true);
  });
});
