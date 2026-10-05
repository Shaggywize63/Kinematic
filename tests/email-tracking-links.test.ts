process.env.CRM_TRACKING_BASE_URL = 'https://api.example.test';
import { wrapTracking } from '../src/services/crm/emails.service';

const html = '<p><a href="https://dashboard.example.test/inv/abc?p=kinematic">View invoice</a> <a href="mailto:a@b.in">mail</a></p>';

describe('email link tracking', () => {
  it('rewrites http(s) links through the click tracker by default and appends the open pixel', () => {
    const out = wrapTracking(html, 'tok123');
    expect(out).toContain('https://api.example.test/api/v1/crm/emails/track/click/tok123?u=');
    expect(out).not.toContain('href="https://dashboard.example.test');
    expect(out).toContain('href="mailto:a@b.in"');
    expect(out).toContain('/track/open/tok123');
  });
  it('leaves links untouched when track_links is off (finance invoice emails) — only the open pixel is added', () => {
    const out = wrapTracking(html, 'tok123', false);
    expect(out).toContain('href="https://dashboard.example.test/inv/abc?p=kinematic"');
    expect(out).not.toContain('/track/click/');
    expect(out).toContain('/track/open/tok123');
  });
});
