jest.mock('../src/services/crm/emails.service', () => ({
  sendEmail: jest.fn(async () => ({ id: 'email-1', status: 'sent', error: null })),
}));

import { sendEmail } from '../src/services/crm/emails.service';
import { emailCustomer, subjectFor, istStamp, ticketUrl } from '../src/services/support/supportEmail';
import type { Ticket } from '../src/services/support/supportTickets.service';

/**
 * The support-update email. What matters here: the subject says what happened, the link reaches the right
 * ticket, times read in IST, a hostile subject cannot inject markup, and a missing address is a clean skip
 * rather than a thrown error that would undo the status change that triggered it.
 */
const send = sendEmail as jest.Mock;

const base: Ticket = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ref: 'KM-5005', status: 'open', priority: 'normal',
  category: 'issue', platforms: ['web'], area: 'attendance',
  subject: 'Attendance not syncing', description: 'No check-ins since this morning.', channel: 'dashboard',
  project_key: 'kinematic', org_id: 'org-acme', org_name: 'Acme Foods', raised_by_user_id: 'u1',
  contact_name: 'Asha Rao', contact_phone: '919811112222', contact_email: 'asha@acme.in',
  resolution_note: null, created_at: '2026-11-26T10:15:00Z', updated_at: '2026-11-26T10:15:00Z',
  resolved_at: null, first_response_at: null, csat_rating: null, csat_comment: null, csat_at: null,
};
const sent = () => send.mock.calls[0][0] as { to: string; subject: string; body_html: string; body_text: string; bypass_suppression?: boolean; track_links?: boolean };

beforeEach(() => {
  send.mockClear();
  send.mockResolvedValue({ id: 'email-1', status: 'sent', error: null });
  process.env.DASHBOARD_URL = 'https://dashboard.kinematicapp.com';
});

describe('subjects', () => {
  it('say what happened, and always carry the reference', () => {
    expect(subjectFor('raised', base, 'Open')).toBe('[KM-5005] We have your request — Attendance not syncing');
    expect(subjectFor('comment', base, 'Open')).toBe('[KM-5005] Update from Kinematic support — Attendance not syncing');
    expect(subjectFor('status', { ...base, status: 'resolved' }, 'Resolved')).toBe('[KM-5005] Resolved — Attendance not syncing');
  });
});

describe('istStamp', () => {
  it('renders a UTC instant in IST, never a bare UTC value', () => {
    // 2026-11-26T10:15:00Z === 15:45 IST on 26 Nov 2026.
    const out = istStamp('2026-11-26T10:15:00Z');
    expect(out).toMatch(/26 Nov 2026/);
    expect(out).toMatch(/3:45\s?pm/i);
    expect(out).toContain('IST');
  });

  it('is blank for an unparseable value rather than "Invalid Date"', () => {
    expect(istStamp('not a date')).toBe('');
  });
});

describe('ticketUrl', () => {
  it('deep-links to the ticket on the dashboard', () => {
    expect(ticketUrl(base)).toBe(`https://dashboard.kinematicapp.com/dashboard/support?ticket=${base.id}`);
  });

  it('ignores a DASHBOARD_URL left pointing at a dead Railway host', () => {
    process.env.DASHBOARD_URL = 'https://kinematic-api.up.railway.app';
    expect(ticketUrl(base)).toContain('https://dashboard.kinematicapp.com/');
  });
});

describe('emailCustomer', () => {
  it('sends to the ticket contact, as transactional mail with tracking off', async () => {
    const r = await emailCustomer({ ticket: { ...base, status: 'resolved' }, kind: 'status', statusLabel: 'Resolved', message: 'The sync job was restarted.', orgId: 'org-kinematic' });
    expect(r).toEqual({ email: 'sent' });
    const m = sent();
    expect(m.to).toBe('asha@acme.in');
    expect(m.subject).toBe('[KM-5005] Resolved — Attendance not syncing');
    expect(m.bypass_suppression).toBe(true);
    expect(m.track_links).toBe(false);
    expect(m.body_html).toContain('The sync job was restarted.');
    expect(m.body_html).toContain(ticketUrl(base));
    expect(m.body_text).toContain('The sync job was restarted.');
    expect(m.body_text).toContain('Ticket: KM-5005');
  });

  it('leaves the quote out entirely when the team added no note', async () => {
    await emailCustomer({ ticket: base, kind: 'raised', statusLabel: 'Open', message: null, orgId: 'org-kinematic' });
    expect(sent().body_html).not.toContain('border-left:3px solid');
  });

  it('escapes a hostile subject instead of letting it inject markup', async () => {
    const nasty = { ...base, subject: '<script>alert(1)</script> & "quotes"' };
    await emailCustomer({ ticket: nasty, kind: 'raised', statusLabel: 'Open', message: null, orgId: 'org-kinematic' });
    const m = sent();
    expect(m.body_html).not.toContain('<script>');
    expect(m.body_html).toContain('&lt;script&gt;');
    expect(m.body_html).toContain('&amp;');
  });

  it('keeps the line breaks in a multi-line note without trusting its markup', async () => {
    await emailCustomer({ ticket: base, kind: 'comment', statusLabel: 'Open', message: 'Line one\nLine <b>two</b>', orgId: 'org-kinematic' });
    const m = sent();
    expect(m.body_html).toContain('Line one<br>Line &lt;b&gt;two&lt;/b&gt;');
  });

  it('tells a resolved customer they can reopen it and rate it', async () => {
    await emailCustomer({ ticket: { ...base, status: 'resolved' }, kind: 'status', statusLabel: 'Resolved', message: null, orgId: 'org-kinematic' });
    expect(sent().body_html).toMatch(/still there, reply on the ticket/i);
    expect(sent().body_html).toMatch(/how we did/i);
  });

  it('skips cleanly with no address, and never calls the provider', async () => {
    const r = await emailCustomer({ ticket: { ...base, contact_email: null }, kind: 'status', statusLabel: 'Open', message: null, orgId: 'org-kinematic' });
    expect(r).toEqual({ email: 'skipped', note: 'No email address on this ticket.' });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when the support org cannot be resolved', async () => {
    const r = await emailCustomer({ ticket: base, kind: 'status', statusLabel: 'Open', message: null, orgId: null });
    expect(r.email).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a provider failure rather than throwing', async () => {
    send.mockRejectedValueOnce(new Error('Resend 403: domain is not verified'));
    const r = await emailCustomer({ ticket: base, kind: 'status', statusLabel: 'Open', message: null, orgId: 'org-kinematic' });
    expect(r).toEqual({ email: 'failed', note: 'Resend 403: domain is not verified' });
  });

  it('reports a non-sent status from sendEmail as a failure', async () => {
    send.mockResolvedValueOnce({ id: 'x', status: 'failed', error: 'suppressed: bounced' });
    const r = await emailCustomer({ ticket: base, kind: 'status', statusLabel: 'Open', message: null, orgId: 'org-kinematic' });
    expect(r).toMatchObject({ email: 'failed', note: 'suppressed: bounced' });
  });
});
