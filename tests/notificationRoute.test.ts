import { notificationKind, routedData } from '../src/lib/notificationRoute';

/**
 * The routing contract: whatever convention wrote a notification, the app gets
 * ONE `kind` to route on. These cases are the real writers found in the backend
 * (see docs/NOTIFICATIONS.md for the table).
 */
describe('notificationKind', () => {
  it('uses data.kind when present (lead / deal / expense / scan alerts)', () => {
    expect(notificationKind('general', { kind: 'lead_assigned', lead_id: 'L1' })).toBe('lead_assigned');
    expect(notificationKind('general', { kind: 'expense_decision', type: 'expense_decision', claim_id: 'C1' })).toBe('expense_decision');
  });

  it('kind wins over a conflicting data.type (daily briefing carries both)', () => {
    expect(notificationKind('daily_briefing', { kind: 'crm_home', type: 'daily_briefing' })).toBe('crm_home');
  });

  it('falls back to data.type (leave, attendance regularization, route deviation, call analysis)', () => {
    expect(notificationKind('leave', { type: 'leave_request', request_id: 'R1' })).toBe('leave_request');
    expect(notificationKind('leave', { type: 'leave_decision', decision: 'approved' })).toBe('leave_decision');
    expect(notificationKind('attendance', { type: 'att_reg_request' })).toBe('att_reg_request');
    expect(notificationKind('route_deviation', { type: 'route_deviation', outlet_id: 'O1' })).toBe('route_deviation');
    expect(notificationKind('crm_conversation', { type: 'conversation_ready', lead_id: 'L1' })).toBe('conversation_ready');
  });

  it('prefixes the KINI nudges so they cannot collide with other kinds', () => {
    expect(notificationKind('general', { nudge_kind: 'reminder', task_id: 'T1' })).toBe('kini_reminder');
    expect(notificationKind('general', { nudge_kind: 'cold_deals', count: 3 })).toBe('kini_cold_deals');
    expect(notificationKind('general', { nudge_kind: 'no_checkin' })).toBe('kini_no_checkin');
  });

  it('uses the row type when data has no discriminator (sos, security alert, mention, message, broadcast)', () => {
    expect(notificationKind('sos', { sos_id: 'S1', exec_id: 'U1', lat: 12.9, lng: 77.5 })).toBe('sos');
    expect(notificationKind('security_alert', { alert_id: 'A1', violation: 'MOCK_LOCATION' })).toBe('security_alert');
    expect(notificationKind('mention', { source_kind: 'message', source_id: 'M1' })).toBe('mention');
    expect(notificationKind('message', { thread_id: 'TH1', message_id: 'M1' })).toBe('message');
    expect(notificationKind('broadcast', null)).toBe('broadcast');
  });

  it('is general when nothing says what it is', () => {
    expect(notificationKind(null, null)).toBe('general');
    expect(notificationKind(undefined, undefined)).toBe('general');
    expect(notificationKind('', {})).toBe('general');
  });

  it('ignores blank / non-string discriminators', () => {
    expect(notificationKind('general', { kind: '  ', type: 42, nudge_kind: '' })).toBe('general');
    expect(notificationKind('sos', { kind: null })).toBe('sos');
  });

  it('tolerates data that is not an object', () => {
    expect(notificationKind('sos', 'oops')).toBe('sos');
    expect(notificationKind('sos', ['x'])).toBe('sos');
  });
});

describe('routedData', () => {
  it('adds kind and keeps every other key', () => {
    const out = routedData({ type: 'sos', data: { sos_id: 'S1', lat: 1 } });
    expect(out).toEqual({ sos_id: 'S1', lat: 1, kind: 'sos' });
  });

  it('does not mutate the stored row', () => {
    const data = { type: 'leave_request', request_id: 'R1' };
    const out = routedData({ type: 'leave', data });
    expect(out.kind).toBe('leave_request');
    expect(data).toEqual({ type: 'leave_request', request_id: 'R1' });
    expect(out).not.toBe(data);
  });

  it('produces a kind even for a row with no data', () => {
    expect(routedData({ type: 'broadcast', data: null })).toEqual({ kind: 'broadcast' });
    expect(routedData({ type: null })).toEqual({ kind: 'general' });
  });

  it('keeps an existing kind', () => {
    expect(routedData({ type: 'general', data: { kind: 'deal_won', deal_id: 'D1' } })).toEqual({ kind: 'deal_won', deal_id: 'D1' });
  });
});
