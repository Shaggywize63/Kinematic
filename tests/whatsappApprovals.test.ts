jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/crm/whatsapp.service', () => ({
  sendWhatsapp: jest.fn(async () => ({ id: 'log-1', provider_message_id: 'wamid.out', status: 'sent', error: null })),
}));
jest.mock('../src/services/crm/whatsappVoiceLead.service', () => ({ findRepByPhone: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({ buildUserContext: jest.fn() }));
jest.mock('../src/services/leave.service', () => ({ decide: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/attendanceRegularization.service', () => ({ decide: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/expenses/expenses.service', () => ({ decide: jest.fn(async () => ({ ok: true, status: 'approved' })) }));

import {
  approvalTarget, buttonPayload, parsePayload, payloadIsFor, isApprovalPayload, forwardApprovalRequests, handleApprovalTap,
  _resetApprovalState, REJECT_NOTE, APPROVE_NOTE,
} from '../src/services/whatsappApprovals.service';
import { pickApprovalTemplate, SUGGESTED_APPROVAL_TEMPLATE, type TemplateRow } from '../src/services/clientWhatsappAlerts.service';
import { templateComponents } from '../src/services/crm/providers/cloudApiWhatsapp.provider';
import { sendWhatsapp } from '../src/services/crm/whatsapp.service';
import { findRepByPhone } from '../src/services/crm/whatsappVoiceLead.service';
import { buildUserContext } from '../src/middleware/auth';
import * as leaveSvc from '../src/services/leave.service';
import * as attRegSvc from '../src/services/attendanceRegularization.service';
import * as expensesSvc from '../src/services/expenses/expenses.service';
import { AppError } from '../src/utils';

const supa = () => (global as any).__supa;
const send = sendWhatsapp as jest.Mock;
const ORG = 'org-client';
const BOSS = 'u-boss';
const LEAVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TPL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const approvalTpl: TemplateRow = {
  id: TPL, meta_template_name: 'kinematic_approval_request', language: 'en', category: 'UTILITY', status: 'APPROVED',
  body_text: SUGGESTED_APPROVAL_TEMPLATE.body, buttons: [{ type: 'QUICK_REPLY', text: 'Approve' }, { type: 'QUICK_REPLY', text: 'Reject' }],
};

const prevEnv = process.env.CLIENT_WHATSAPP_ALERTS;
beforeAll(() => { process.env.CLIENT_WHATSAPP_ALERTS = 'on'; });
afterAll(() => { process.env.CLIENT_WHATSAPP_ALERTS = prevEnv; });

let approvalsOn = true;
beforeEach(() => {
  supa().reset();
  _resetApprovalState();
  jest.clearAllMocks();
  approvalsOn = true;
  send.mockResolvedValue({ id: 'log-1', provider_message_id: 'wamid.out', status: 'sent', error: null });
  (findRepByPhone as jest.Mock).mockResolvedValue({ id: BOSS, name: 'Meera', client_id: null, role: 'supervisor', org_id: ORG });
  (buildUserContext as jest.Mock).mockResolvedValue({ id: BOSS, org_id: ORG, role: 'supervisor', client_id: 'c-1', org_role_data_scope: 'team' });
  (leaveSvc.decide as jest.Mock).mockResolvedValue({ ok: true });
  (expensesSvc.decide as jest.Mock).mockResolvedValue({ ok: true, status: 'approved' });
  supa().setDefault('org_settings', (chain: any) => (chain.single
    ? { data: { value: { approvals: approvalsOn } } }
    : { data: [{ org_id: ORG, value: { approvals: approvalsOn } }] }));
  supa().setDefault('crm_whatsapp_templates', { data: [approvalTpl] });
  supa().setDefault('leave_requests', { data: { id: LEAVE, approver_id: BOSS, status: 'pending', user_id: 'u-asha' } });
  supa().setDefault('expense_claims', { data: { id: CLAIM, approver_id: BOSS, status: 'submitted', user_id: 'u-asha' } });
  supa().setDefault('users', (chain: any) => (chain.eqs.id === BOSS
    ? { data: { id: BOSS, mobile: '98111 12222', is_active: true } }
    : { data: { name: 'Asha Rao' } }));
});

const leaveRow = (userId = BOSS) => ({
  orgId: ORG, userId, kind: 'leave_request', title: 'New leave request', body: 'Asha Rao requested 2 day(s) Casual Leave (2026-11-20–2026-11-21)',
  data: { type: 'leave_request', request_id: LEAVE },
});

describe('templateComponents', () => {
  it('adds quick-reply payloads after the body, and leaves skipped buttons alone', () => {
    const sparse: string[] = [];
    sparse[1] = 'p-reject';
    expect(templateComponents({ 1: 'a', 2: 'b' }, ['p-approve', 'p-reject2'])).toEqual({
      components: [
        { type: 'body', parameters: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'p-approve' }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'p-reject2' }] },
      ],
    });
    expect(templateComponents(undefined, sparse)).toEqual({
      components: [{ type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'p-reject' }] }],
    });
    expect(templateComponents()).toEqual({});
  });
});

describe('pickApprovalTemplate', () => {
  it('needs approved Approve + Reject quick replies and prefers the suggested template', () => {
    const other: TemplateRow = { ...approvalTpl, id: 'other', meta_template_name: 'hr_ok', buttons: [{ type: 'URL', text: 'Open' }, { type: 'QUICK_REPLY', text: 'Decline' }, { type: 'QUICK_REPLY', text: 'Approve now' }] };
    const pending: TemplateRow = { ...approvalTpl, id: 'p', status: 'PENDING' };
    expect(pickApprovalTemplate([other, pending])).toMatchObject({ id: 'other', approveIndex: 2, rejectIndex: 1 });
    expect(pickApprovalTemplate([other, approvalTpl])).toMatchObject({ id: TPL, approveIndex: 0, rejectIndex: 1 });
    expect(pickApprovalTemplate([{ ...approvalTpl, buttons: [{ type: 'QUICK_REPLY', text: 'Approve' }] }])).toBeNull();
  });
});

describe('payloads', () => {
  it('round-trip, and only count for the approver they were signed for', () => {
    const p = buttonPayload('leave', LEAVE, 'approved', BOSS);
    expect(p).toMatch(/^apv:l:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:a:[A-Za-z0-9_-]{16}$/);
    expect(p.length).toBeLessThanOrEqual(128);
    expect(isApprovalPayload(p)).toBe(true);
    const parsed = parsePayload(p)!;
    expect(parsed).toMatchObject({ entity: 'leave', id: LEAVE, decision: 'approved' });
    expect(payloadIsFor(parsed, BOSS)).toBe(true);
    expect(payloadIsFor(parsed, 'u-someone-else')).toBe(false);
    // Flipping approve → reject breaks the signature.
    expect(payloadIsFor(parsePayload(p.replace(':a:', ':r:'))!, BOSS)).toBe(false);
    expect(parsePayload('apv:x:nope')).toBeNull();
    expect(isApprovalPayload('Approve')).toBe(false);
  });

  it('finds the request behind a notification', () => {
    expect(approvalTarget('leave_request', { request_id: LEAVE })).toEqual({ entity: 'leave', id: LEAVE });
    expect(approvalTarget('att_reg_request', { request_id: LEAVE })).toEqual({ entity: 'regularization', id: LEAVE });
    expect(approvalTarget('expense_submitted', { kind: 'expense_submitted', claim_id: CLAIM })).toEqual({ entity: 'expense', id: CLAIM });
    expect(approvalTarget('leave_decision', { request_id: LEAVE })).toBeNull();
    expect(approvalTarget('leave_request', { request_id: 'not-a-uuid' })).toBeNull();
  });
});

describe('forwardApprovalRequests', () => {
  it('sends the approver the request with signed Approve / Reject buttons', async () => {
    expect(await forwardApprovalRequests([leaveRow()])).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg).toMatchObject({
      org_id: ORG, to: '919811112222', user_id: BOSS, template_id: TPL,
      template_variables: { 1: 'New leave request', 2: 'Asha Rao requested 2 day(s) Casual Leave (2026-11-20–2026-11-21)' },
    });
    expect(arg.template_buttons).toEqual([buttonPayload('leave', LEAVE, 'approved', BOSS), buttonPayload('leave', LEAVE, 'rejected', BOSS)]);
    // Same request again (another dispatcher pass) → not sent twice.
    expect(await forwardApprovalRequests([leaveRow()])).toBe(0);
  });

  it('skips managers who are only told about it, decided requests, and orgs without approvals or a template', async () => {
    expect(await forwardApprovalRequests([leaveRow('u-other-manager')])).toBe(0);
    supa().setDefault('leave_requests', { data: { id: LEAVE, approver_id: BOSS, status: 'approved' } });
    expect(await forwardApprovalRequests([leaveRow()])).toBe(0);
    supa().setDefault('leave_requests', { data: { id: LEAVE, approver_id: BOSS, status: 'pending' } });
    supa().setDefault('crm_whatsapp_templates', { data: [] });
    expect(await forwardApprovalRequests([leaveRow()])).toBe(0);
    approvalsOn = false;
    supa().setDefault('crm_whatsapp_templates', { data: [approvalTpl] });
    expect(await forwardApprovalRequests([leaveRow()])).toBe(0);
    expect(await forwardApprovalRequests([{ ...leaveRow(), kind: 'sos', data: {} }])).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when WhatsApp alerts are switched off for the deployment', async () => {
    process.env.CLIENT_WHATSAPP_ALERTS = 'off';
    try {
      expect(await forwardApprovalRequests([leaveRow()])).toBe(0);
    } finally { process.env.CLIENT_WHATSAPP_ALERTS = 'on'; }
    expect(send).not.toHaveBeenCalled();
  });
});

describe('handleApprovalTap', () => {
  const tap = (entity: 'leave' | 'expense' | 'regularization', id: string, decision: 'approved' | 'rejected', id2 = 'wamid.tap1', signedFor = BOSS) =>
    ({ id: id2, from: '919811112222', payload: buttonPayload(entity, id, decision, signedFor) });

  it('approves a leave as the approver and confirms', async () => {
    expect(await handleApprovalTap(ORG, tap('leave', LEAVE, 'approved'))).toBe('approved');
    expect(leaveSvc.decide).toHaveBeenCalledWith({ id: BOSS, org_id: ORG, role: 'supervisor', client_id: 'c-1', data_scope: 'team' }, LEAVE, 'approved', APPROVE_NOTE);
    expect(send.mock.calls[0][0]).toMatchObject({ org_id: ORG, to: '919811112222', user_id: BOSS });
    expect(send.mock.calls[0][0].body_text).toBe('✅ Leave request from Asha Rao approved. Asha Rao has been told in the app.');
    // Meta retries the same webhook → handled once.
    expect(await handleApprovalTap(ORG, tap('leave', LEAVE, 'approved'))).toBe('duplicate');
    expect(leaveSvc.decide).toHaveBeenCalledTimes(1);
  });

  it('rejects an expense claim with a remark, and routes attendance corrections', async () => {
    expect(await handleApprovalTap(ORG, tap('expense', CLAIM, 'rejected'))).toBe('rejected');
    expect(expensesSvc.decide).toHaveBeenCalledWith(expect.objectContaining({ id: BOSS }), CLAIM, { decision: 'rejected', note: REJECT_NOTE });
    expect(send.mock.calls[0][0].body_text).toContain(`Expense claim from Asha Rao rejected with the note "${REJECT_NOTE}"`);
    expect(await handleApprovalTap(ORG, tap('regularization', LEAVE, 'approved', 'wamid.tap2'))).toBe('approved');
    expect(attRegSvc.decide).toHaveBeenCalledWith(expect.objectContaining({ id: BOSS }), LEAVE, 'approved', APPROVE_NOTE);
  });

  it('says when an approved claim went up to the next approver', async () => {
    (expensesSvc.decide as jest.Mock).mockResolvedValue({ ok: true, status: 'submitted', escalated: true, level: 2 });
    expect(await handleApprovalTap(ORG, tap('expense', CLAIM, 'approved'))).toBe('escalated');
    expect(send.mock.calls[0][0].body_text).toMatch(/gone to the next approver/);
  });

  it('explains already-decided and no-longer-yours instead of failing silently', async () => {
    (leaveSvc.decide as jest.Mock).mockRejectedValueOnce(new AppError(400, 'Already decided', 'BAD_STATE'));
    expect(await handleApprovalTap(ORG, tap('leave', LEAVE, 'approved', 'wamid.a'))).toBe('already_decided');
    (leaveSvc.decide as jest.Mock).mockRejectedValueOnce(new AppError(403, 'nope', 'FORBIDDEN'));
    expect(await handleApprovalTap(ORG, tap('leave', LEAVE, 'rejected', 'wamid.b'))).toBe('forbidden');
    (leaveSvc.decide as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    expect(await handleApprovalTap(ORG, tap('leave', LEAVE, 'rejected', 'wamid.c'))).toBe('failed');
    expect(send.mock.calls.map((c) => c[0].body_text)).toEqual([
      'This request was already decided, so nothing changed.',
      "You're not the approver for this request any more, so nothing changed.",
      "Sorry, I couldn't record that. Please decide in the Kinematic app.",
    ]);
  });

  it('ignores buttons signed for someone else, strangers, and orgs that switched it off', async () => {
    expect(await handleApprovalTap(ORG, tap('leave', LEAVE, 'approved', 'wamid.x', 'u-other'))).toBe('bad_signature');
    (findRepByPhone as jest.Mock).mockResolvedValueOnce(null);
    expect(await handleApprovalTap(ORG, tap('leave', LEAVE, 'approved', 'wamid.y'))).toBe('not_user');
    approvalsOn = false;
    expect(await handleApprovalTap(ORG, tap('leave', LEAVE, 'approved', 'wamid.z'))).toBe('disabled');
    expect(await handleApprovalTap(ORG, { id: 'w', from: '91', payload: 'Approve' })).toBe('ignored');
    expect(leaveSvc.decide).not.toHaveBeenCalled();
  });
});
