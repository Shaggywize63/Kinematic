/**
 * Expense management v2.
 *
 * Two layers:
 *   - the policy engine and small helpers, as pure functions;
 *   - the real claim service driven against a Supabase double, asserting both the
 *     result AND the writes it made — chiefly that a rejection can never be saved
 *     without a remark, that partial approvals pay only the approved lines, and
 *     that a "block" policy stops a submission before anything is changed.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// The AI brief is best-effort; make it fail fast so the deterministic text is used.
jest.mock('../src/services/ai.service', () => ({
  AIService: { callKiniAI: jest.fn().mockRejectedValue(new Error('no model in tests')) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import * as policy from '../src/services/expenses/policy.service';
import * as svc from '../src/services/expenses/expenses.service';
import { cell } from '../src/services/expenses/claimReports.service';
import { sniff } from '../src/services/expenses/receipts.service';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const REP = '11111111-1111-1111-1111-111111111111';
const BOSS = '22222222-2222-2222-2222-222222222222';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const CLAIM = '44444444-4444-4444-4444-444444444444';

const rules = (o: any = {}) => policy.normalizeRules(o);
const pol = (o: Partial<policy.ExpensePolicy> = {}): policy.ExpensePolicy => ({
  ...policy.BUILT_IN_POLICY, name: 'Test policy', ...o,
});
const line = (o: any = {}) => ({ id: 'i1', category: 'food', amount: 100, item_date: '2026-10-01', receipt_url: null, ...o });

// ── normalisation ────────────────────────────────────────────────────────────
describe('policy normalisation', () => {
  it('fills every category and applies sane defaults', () => {
    const r = rules();
    expect(r.mileage_rate).toBe(12);
    expect(r.receipt_required_over).toBe(500);
    expect(r.enforcement).toBe('flag');
    expect(Object.keys(r.categories).sort()).toEqual(['food', 'fuel', 'lodging', 'mileage', 'misc', 'toll', 'travel']);
    expect(r.categories.food).toMatchObject({ enabled: true, per_day_limit: null });
  });

  it('seeds the rules from a legacy single-policy row', () => {
    const r = policy.normalizeRules({}, { mileage_rate: 9, require_receipt_over: 250, auto_approve_under: 300, escalate_over: 8000, category_limits: { food: 400 } });
    expect(r).toMatchObject({ mileage_rate: 9, receipt_required_over: 250, auto_approve_under: 300, escalate_over: 8000 });
    expect(r.categories.food.per_day_limit).toBe(400);
  });

  it('treats an empty audience as everyone, and lowercases roles', () => {
    expect(policy.normalizeApplies({}).everyone).toBe(true);
    const a = policy.normalizeApplies({ roles: ['Supervisor', 'supervisor', ' '] });
    expect(a).toMatchObject({ everyone: false, roles: ['supervisor'] });
  });

  it('keeps the client-facing shape the apps already parse', () => {
    const p = pol({ rules: rules({ mileage_rate: 14, categories: { food: { per_day_limit: 500 } } }) });
    expect(policy.toClientShape(p)).toMatchObject({ mileage_rate: 14, require_receipt_over: 500, category_limits: { food: 500 }, currency: 'INR' });
  });
});

describe('showing who a policy is assigned to', () => {
  it('names the assigned people, and keeps a removed user visible', async () => {
    __mock.reset();
    __mock.setDefault('users', { data: [{ id: REP, name: 'Asha' }] });
    const named = pol({ id: 'me', applies_to: { everyone: false, roles: [], org_role_ids: [], user_ids: [REP, BOSS] } });
    const everyone = pol({ id: 'all' });
    const out = await policy.attachPeopleNames({ id: ADMIN, org_id: ORG, role: 'admin' }, [named, everyone]);
    expect(out[0].people).toEqual([{ id: REP, name: 'Asha' }, { id: BOSS, name: 'Removed user' }]);
    expect(out[1].people).toEqual([]);
  });
});

// ── resolution ───────────────────────────────────────────────────────────────
describe('which policy governs a person', () => {
  const everyone = pol({ id: 'all', name: 'Everyone' });
  const sup = pol({ id: 'sup', name: 'Supervisors', applies_to: { everyone: false, roles: ['supervisor'], org_role_ids: [], user_ids: [] } });
  const named = pol({ id: 'me', name: 'Just me', applies_to: { everyone: false, roles: [], org_role_ids: [], user_ids: [REP] } });

  it('prefers a named person over their role over everyone', () => {
    expect(policy.pickPolicy([everyone, sup, named], { id: REP, role: 'supervisor' })?.id).toBe('me');
    expect(policy.pickPolicy([everyone, sup, named], { id: BOSS, role: 'supervisor' })?.id).toBe('sup');
    expect(policy.pickPolicy([everyone, sup, named], { id: ADMIN, role: 'executive' })?.id).toBe('all');
  });

  it('breaks a tie with priority (lower wins)', () => {
    const a = pol({ id: 'a', priority: 50 });
    const b = pol({ id: 'b', priority: 10 });
    expect(policy.pickPolicy([a, b], { id: REP })?.id).toBe('b');
  });

  it('returns nothing when no policy applies, so the caller falls back to built-ins', () => {
    expect(policy.pickPolicy([sup], { id: REP, role: 'executive' })).toBeNull();
  });

  it('matches an RBAC role as well as the legacy role string', () => {
    const rbac = pol({ id: 'rbac', applies_to: { everyone: false, roles: [], org_role_ids: ['role-1'], user_ids: [] } });
    expect(policy.pickPolicy([rbac], { id: REP, role: 'sub_admin', org_role_id: 'role-1' })?.id).toBe('rbac');
  });
});

// ── evaluation ───────────────────────────────────────────────────────────────
describe('policy evaluation', () => {
  const codes = (p: policy.ExpensePolicy, items: any[], o: any = {}) =>
    policy.evaluateAgainstPolicy(p, items, { today: '2026-10-05', ...o }).violations.map((v) => v.code);

  it('requires a receipt over the threshold, but never for mileage', () => {
    const p = pol({ rules: rules({ receipt_required_over: 500 }) });
    expect(codes(p, [line({ amount: 600 })])).toContain('receipt_missing');
    expect(codes(p, [line({ amount: 600, receipt_url: 'https://x/r.jpg' })])).not.toContain('receipt_missing');
    expect(codes(p, [line({ amount: 400 })])).not.toContain('receipt_missing');
    expect(codes(p, [line({ category: 'mileage', amount: 900 })])).not.toContain('receipt_missing');
  });

  it('lets a category override the receipt threshold', () => {
    const p = pol({ rules: rules({ receipt_required_over: 500, categories: { lodging: { receipt_required_over: 0 } } }) });
    expect(codes(p, [line({ category: 'lodging', amount: 50 })])).toContain('receipt_missing');
    expect(codes(p, [line({ category: 'food', amount: 50 })])).not.toContain('receipt_missing');
  });

  it('enforces per-day, per-claim and per-month caps', () => {
    const p = pol({ rules: rules({ categories: { food: { per_day_limit: 300, per_claim_limit: 500, per_month_limit: 1000 } } }) });
    const day = [line({ id: 'a', amount: 200 }), line({ id: 'b', amount: 200 })];
    expect(codes(p, day)).toContain('over_category_limit');
    const week = [line({ id: 'a', amount: 200, item_date: '2026-10-01' }), line({ id: 'b', amount: 200, item_date: '2026-10-02' }), line({ id: 'c', amount: 200, item_date: '2026-10-03' })];
    expect(codes(p, week)).toContain('over_claim_category_limit');
    expect(codes(p, week)).not.toContain('over_category_limit');
    expect(codes(p, [line({ amount: 250 })], { priorMonthSpend: { 'food|2026-10': 800 } })).toContain('over_month_limit');
    expect(codes(p, [line({ amount: 250 })], { priorMonthSpend: { 'food|2026-10': 100 } })).not.toContain('over_month_limit');
  });

  it('caps the whole claim', () => {
    const p = pol({ rules: rules({ max_claim_amount: 1000 }) });
    expect(codes(p, [line({ id: 'a', amount: 700 }), line({ id: 'b', category: 'travel', amount: 700 })])).toContain('over_claim_limit');
  });

  it('flags late and future-dated lines', () => {
    const p = pol({ rules: rules({ submit_within_days: 30 }) });
    expect(codes(p, [line({ item_date: '2026-08-01' })])).toContain('late_submission');
    expect(codes(p, [line({ item_date: '2026-09-25' })])).not.toContain('late_submission');
    expect(codes(p, [line({ item_date: '2026-10-09' })])).toContain('future_date');
  });

  it('flags violations but lets them through under "flag", blocks them under "block"', () => {
    const items = [line({ amount: 900 })];
    const flag = policy.evaluateAgainstPolicy(pol({ rules: rules({ enforcement: 'flag' }) }), items, { today: '2026-10-05' });
    expect(flag.violations.some((v) => v.blocking)).toBe(false);
    const block = policy.evaluateAgainstPolicy(pol({ rules: rules({ enforcement: 'block' }) }), items, { today: '2026-10-05' });
    expect(block.violations.some((v) => v.blocking)).toBe(true);
  });

  it('always blocks a category the policy does not reimburse, even under "flag"', () => {
    const p = pol({ rules: rules({ enforcement: 'flag', categories: { misc: { enabled: false } } }) });
    const v = policy.evaluateAgainstPolicy(p, [line({ category: 'misc', amount: 10 })], { today: '2026-10-05' }).violations;
    expect(v.find((x) => x.code === 'category_not_allowed')?.blocking).toBe(true);
  });

  it('points each violation at the line that caused it', () => {
    const p = pol({ rules: rules({ receipt_required_over: 100 }) });
    const r = policy.evaluateAgainstPolicy(p, [line({ id: 'x', amount: 500 })], { today: '2026-10-05' });
    expect(r.flaggedItemIds.x).toMatch(/Missing receipt/);
  });
});

describe('auto-approval', () => {
  const p = pol({ rules: rules({ auto_approve_under: 1000 }) });
  it('approves a small, clean claim', () => expect(policy.canAutoApprove(p, 800, [])).toBe(true));
  it('does not approve over the threshold', () => expect(policy.canAutoApprove(p, 1200, [])).toBe(false));
  it('does not approve anything with a warning on it', () =>
    expect(policy.canAutoApprove(p, 800, [{ code: 'receipt_missing', severity: 'warn', detail: '' }])).toBe(false));
  it('is off by default', () => expect(policy.canAutoApprove(pol(), 1, [])).toBe(false));
});

describe('starter presets', () => {
  it('are all valid, uniquely named and stable under normalisation', () => {
    const list = policy.policyPresets();
    expect(new Set(list.map((p) => p.key)).size).toBe(list.length);
    for (const p of list) expect(policy.normalizeRules(p.rules)).toEqual(p.rules);
    expect(list.find((p) => p.key === 'strict')!.rules.enforcement).toBe('block');
  });
});

// ── small helpers ────────────────────────────────────────────────────────────
describe('csv cells', () => {
  it('quotes commas and quotes', () => expect(cell('a, "b"')).toBe('"a, ""b"""'));
  it('neutralises spreadsheet formulas', () => {
    expect(cell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(cell('+91 98765')).toBe("'+91 98765");
  });
  it('renders empty as empty', () => expect(cell(null)).toBe(''));
});

describe('receipt file sniffing', () => {
  const pad = (b: number[]) => Buffer.from([...b, ...new Array(16).fill(0)]);
  it('recognises real images and PDFs', () => {
    expect(sniff(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniff(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniff(Buffer.from('%PDF-1.7 ........'))).toBe('application/pdf');
    expect(sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(8)]))).toBe('image/heic');
  });
  it('refuses anything else, whatever the declared type', () => {
    expect(sniff(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(sniff(Buffer.from('MZ executable ........'))).toBeNull();
  });
});

// ── the claim service ────────────────────────────────────────────────────────
const asRep = { id: REP, org_id: ORG, role: 'executive', client_id: null, data_scope: 'own' };
const asBoss = { id: BOSS, org_id: ORG, role: 'supervisor', client_id: null, data_scope: 'team' };
const asAdmin = { id: ADMIN, org_id: ORG, role: 'admin', client_id: null, data_scope: 'all' };

const snapshot = (over: any = {}) => pol({ id: 'p1', name: 'Field rep', rules: rules(over) });
const submittedClaim = (over: any = {}) => ({
  id: CLAIM, org_id: ORG, user_id: REP, status: 'submitted', claim_no: 'EXP-1', currency: 'INR', total_amount: 1500,
  approver_id: BOSS, current_level: 1, submit_count: 1, policy_snapshot: snapshot(), ai_summary: 'x', ...over,
});
const lines = [
  { id: 'l1', claim_id: CLAIM, category: 'food', amount: 600, item_date: '2026-10-01' },
  { id: 'l2', claim_id: CLAIM, category: 'travel', amount: 900, item_date: '2026-10-02' },
];

function arrange(claim: any, items = lines) {
  __mock.setDefault('expense_policies', { data: [] });            // v2 schema present
  __mock.setDefault('expense_claims', { data: [claim] });
  __mock.setDefault('expense_claim_items', { data: items });
  __mock.setDefault('expense_approvals', { data: [] });
  __mock.setDefault('users', { data: [{ id: BOSS, supervisor_id: null, role: 'executive', org_role_id: null, name: 'Boss' }] });
  __mock.setDefault('notifications', { data: [] });
}
const updatesOf = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'update').map((o) => o.args[0] as any));
const insertsOf = (table: string) =>
  __mock.chainsFor(table).flatMap((c) => c.ops.filter((o) => o.method === 'insert').map((o) => o.args[0] as any));

beforeEach(() => __mock.reset());

describe('rejecting a claim needs a remark', () => {
  it('refuses a rejection with no remark and changes nothing', async () => {
    arrange(submittedClaim());
    await expect(svc.decide(asBoss, CLAIM, { decision: 'rejected' })).rejects.toMatchObject({ code: 'REMARK_REQUIRED', statusCode: 400 });
    expect(updatesOf('expense_claims')).toHaveLength(0);
    expect(updatesOf('expense_claim_items')).toHaveLength(0);
  });

  it('refuses a remark that is only whitespace', async () => {
    arrange(submittedClaim());
    await expect(svc.decide(asBoss, CLAIM, { decision: 'rejected', note: '   \n ' })).rejects.toMatchObject({ code: 'REMARK_REQUIRED' });
    expect(updatesOf('expense_claims')).toHaveLength(0);
  });

  it('saves the remark on the claim, on every line and on the trail, and tells the claimant', async () => {
    arrange(submittedClaim());
    const r = await svc.decide(asBoss, CLAIM, { decision: 'rejected', note: 'Receipts are unreadable' });
    expect(r).toMatchObject({ ok: true, status: 'rejected' });
    expect(updatesOf('expense_claims').find((u) => u.status === 'rejected')).toMatchObject({ review_note: 'Receipts are unreadable', reviewed_by: BOSS });
    expect(updatesOf('expense_claim_items').filter((u) => u.decision === 'rejected')).toHaveLength(2);
    expect(updatesOf('expense_approvals')[0]).toMatchObject({ status: 'rejected', note: 'Receipts are unreadable', approver_id: BOSS });
    const n = insertsOf('notifications')[0];
    expect(n).toMatchObject({ user_id: REP, title: 'Expense claim rejected' });
    expect(n.body).toContain('Receipts are unreadable');
    expect(n.data).toMatchObject({ kind: 'expense_decision', claim_id: CLAIM, decision: 'rejected' });
  });

  it('does not let someone other than the approver decide', async () => {
    arrange(submittedClaim());
    await expect(svc.decide({ ...asRep, id: '99999999-9999-9999-9999-999999999999', role: 'supervisor', data_scope: 'team' }, CLAIM, { decision: 'approved' }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('only decides a claim that is awaiting approval', async () => {
    arrange(submittedClaim({ status: 'approved' }));
    await expect(svc.decide(asBoss, CLAIM, { decision: 'approved' })).rejects.toMatchObject({ code: 'BAD_STATE' });
  });
});

describe('deciding line by line', () => {
  it('needs a remark for every rejected line', async () => {
    arrange(submittedClaim());
    await expect(svc.decide(asBoss, CLAIM, { decision: 'approved', items: [{ id: 'l2', decision: 'rejected' }] }))
      .rejects.toMatchObject({ code: 'REMARK_REQUIRED', message: expect.stringContaining('travel') });
    expect(updatesOf('expense_claims')).toHaveLength(0);
  });

  it('rejects a line that does not belong to the claim', async () => {
    arrange(submittedClaim());
    await expect(svc.decide(asBoss, CLAIM, { decision: 'approved', items: [{ id: 'other', decision: 'rejected', note: 'x' }] }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('approves only the lines that were not rejected (partial approval)', async () => {
    arrange(submittedClaim());
    const r: any = await svc.decide(asBoss, CLAIM, { decision: 'approved', items: [{ id: 'l2', decision: 'rejected', note: 'Personal travel' }] });
    expect(r).toMatchObject({ status: 'approved', approved_amount: 600, rejected_lines: 1 });
    expect(updatesOf('expense_claims').find((u) => u.status === 'approved')).toMatchObject({ approved_amount: 600 });
    const byLine = updatesOf('expense_claim_items');
    expect(byLine.find((u) => u.decision === 'rejected')).toMatchObject({ decision_note: 'Personal travel' });
    const n = insertsOf('notifications')[0];
    expect(n.title).toBe('Expense claim partly approved');
    expect(n.body).toContain('Personal travel');
    // The trail keeps a frozen copy of every line decision, remark included.
    expect(updatesOf('expense_approvals')[0].item_decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ item_id: 'l2', decision: 'rejected', note: 'Personal travel' }),
    ]));
  });

  it('treats a claim whose every line is rejected as rejected, and wants an overall remark', async () => {
    arrange(submittedClaim());
    const all = [{ id: 'l1', decision: 'rejected' as const, note: 'No receipt' }, { id: 'l2', decision: 'rejected' as const, note: 'Duplicate' }];
    await expect(svc.decide(asBoss, CLAIM, { decision: 'approved', items: all })).rejects.toMatchObject({ code: 'REMARK_REQUIRED' });
    const r: any = await svc.decide(asBoss, CLAIM, { decision: 'approved', items: all, note: 'Nothing here is claimable' });
    expect(r.status).toBe('rejected');
    expect(updatesOf('expense_claims').find((u) => u.status === 'rejected')).toMatchObject({ review_note: 'Nothing here is claimable' });
  });

  it('judges the escalation limit on what is being paid, not what was claimed', async () => {
    // 1,500 claimed is over the 1,000 limit; rejecting the 900 line leaves 600 — within it.
    arrange(submittedClaim({ policy_snapshot: snapshot({ escalate_over: 1000 }) }));
    const r: any = await svc.decide(asBoss, CLAIM, { decision: 'approved', items: [{ id: 'l2', decision: 'rejected', note: 'Personal' }] });
    expect(r.escalated).toBeUndefined();
    expect(r.status).toBe('approved');
  });

  it('escalates to the next manager when the approved amount is over the limit', async () => {
    arrange(submittedClaim({ policy_snapshot: snapshot({ escalate_over: 1000 }) }));
    __mock.setDefault('users', { data: [{ id: BOSS, supervisor_id: ADMIN }] });
    const r: any = await svc.decide(asBoss, CLAIM, { decision: 'approved' });
    expect(r).toMatchObject({ status: 'submitted', escalated: true, level: 2, approved_amount: 1500 });
    expect(insertsOf('expense_approvals').find((a) => a.level === 2)).toMatchObject({ approver_id: ADMIN, status: 'pending', round: 1 });
  });
});

describe('bulk decisions', () => {
  it('refuses to bulk-reject without a remark, before touching any claim', async () => {
    arrange(submittedClaim());
    await expect(svc.bulkDecide(asBoss, [CLAIM], 'rejected', ' ')).rejects.toMatchObject({ code: 'REMARK_REQUIRED' });
    expect(updatesOf('expense_claims')).toHaveLength(0);
  });

  it('reports a failure per claim instead of aborting the batch', async () => {
    arrange(submittedClaim({ status: 'approved' }));
    const r = await svc.bulkDecide(asBoss, [CLAIM], 'approved');
    expect(r.done).toHaveLength(0);
    expect(r.failed[0]).toMatchObject({ id: CLAIM });
  });
});

describe('submitting a claim', () => {
  const draft = (over: any = {}) => ({ id: CLAIM, org_id: ORG, user_id: REP, status: 'draft', claim_no: 'EXP-1', currency: 'INR', total_amount: 0, submit_count: 0, ...over });
  const ownLines = [{ id: 'l1', claim_id: CLAIM, category: 'food', amount: 900, item_date: new Date().toISOString().slice(0, 10), receipt_url: null }];

  function arrangeDraft(p: policy.ExpensePolicy, claim = draft(), items: any[] = ownLines) {
    arrange(claim, items);
    __mock.setDefault('expense_policies', { data: [{ ...p, id: 'p1', client_id: null, rules: p.rules, applies_to: p.applies_to, is_active: true, deleted_at: null }] });
    __mock.setDefault('users', { data: [{ id: REP, supervisor_id: BOSS, role: 'executive', org_role_id: null, name: 'Asha' }] });
  }

  it('is stopped by a "block" policy before anything is saved, listing every reason', async () => {
    arrangeDraft(pol({ rules: rules({ enforcement: 'block', receipt_required_over: 500 }) }));
    const err: any = await svc.submitClaim(asRep, CLAIM).catch((e) => e);
    expect(err).toBeInstanceOf(svc.PolicyBlockedError);
    expect(err.code).toBe('POLICY_BLOCKED');
    expect(err.violations.some((v: any) => v.code === 'receipt_missing')).toBe(true);
    expect(updatesOf('expense_claims').find((u) => u.status === 'submitted')).toBeUndefined();
    expect(insertsOf('expense_approvals')).toHaveLength(0);
  });

  it('goes through a "flag" policy, carrying the flags for the approver', async () => {
    arrangeDraft(pol({ rules: rules({ enforcement: 'flag', receipt_required_over: 500 }) }));
    await svc.submitClaim(asRep, CLAIM);
    const sub = updatesOf('expense_claims').find((u) => u.status === 'submitted');
    expect(sub).toMatchObject({ approver_id: BOSS, policy_name: 'Test policy' });
    expect(sub.ai_flags.map((f: any) => f.code)).toContain('receipt_missing');
    expect(sub.policy_snapshot.rules.receipt_required_over).toBe(500);
    expect(insertsOf('expense_approvals')[0]).toMatchObject({ level: 1, status: 'pending', approver_id: BOSS });
  });

  it('approves a small clean claim on the spot when the policy allows', async () => {
    const small = [{ ...ownLines[0], amount: 300 }];
    arrangeDraft(pol({ rules: rules({ auto_approve_under: 1000 }) }), draft(), small);
    await svc.submitClaim(asRep, CLAIM);
    expect(updatesOf('expense_claims').find((u) => u.status === 'approved')).toMatchObject({ auto_approved: true, approved_amount: 300 });
    expect(insertsOf('expense_approvals')[0]).toMatchObject({ status: 'approved', approver_id: null });
    expect(insertsOf('notifications').some((n) => n.user_id === REP && /approved/i.test(n.title))).toBe(true);
  });

  it('does not auto-approve a claim that has a warning on it', async () => {
    arrangeDraft(pol({ rules: rules({ auto_approve_under: 5000, receipt_required_over: 500 }) }));
    await svc.submitClaim(asRep, CLAIM);
    expect(updatesOf('expense_claims').find((u) => u.status === 'approved')).toBeUndefined();
    expect(updatesOf('expense_claims').find((u) => u.status === 'submitted')).toBeDefined();
  });

  it('lets a rejected claim be resubmitted as a new round, clearing the old line decisions', async () => {
    arrangeDraft(pol(), draft({ status: 'rejected', submit_count: 1, review_note: 'Fix the receipts' }));
    await svc.submitClaim(asRep, CLAIM);
    const sub = updatesOf('expense_claims').find((u) => u.status === 'submitted');
    expect(sub).toMatchObject({ submit_count: 2, review_note: null, approved_amount: null });
    expect(updatesOf('expense_claim_items').some((u) => u.decision === null && 'decided_by' in u)).toBe(true);
    expect(insertsOf('expense_approvals')[0]).toMatchObject({ round: 2 });
  });

  it('refuses to submit a claim that is not a draft or rejected', async () => {
    arrangeDraft(pol(), draft({ status: 'approved' }));
    await expect(svc.submitClaim(asRep, CLAIM)).rejects.toMatchObject({ code: 'BAD_STATE' });
  });

  it('only lets the owner submit', async () => {
    arrangeDraft(pol());
    await expect(svc.submitClaim({ ...asRep, id: '88888888-8888-8888-8888-888888888888' }, CLAIM)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('reimbursement', () => {
  it('only reimburses an approved claim, as an admin', async () => {
    arrange(submittedClaim({ status: 'approved', approved_amount: 600 }));
    await expect(svc.reimburse(asRep, CLAIM)).rejects.toMatchObject({ statusCode: 403 });
    const r = await svc.reimburse(asAdmin, CLAIM, 'UTR123');
    expect(r.status).toBe('reimbursed');
    // The notification states the approved amount, not the claimed one.
    expect(insertsOf('notifications')[0].body).toContain('600');
  });
});
