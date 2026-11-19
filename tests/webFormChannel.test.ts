import { webFormProvider, classifyChannel } from '../src/services/crm/integrations/providers/webForm';

describe('classifyChannel', () => {
  it('returns Direct when there is no signal at all', () => {
    expect(classifyChannel({})).toBe('Direct');
  });

  it('prioritises an ad click-id over everything else', () => {
    expect(classifyChannel({ google_click_id: 'Cj0abc', utm_source: 'newsletter' })).toBe('Google Ads');
    expect(classifyChannel({ meta_click_id: 'fb.1.2.3' })).toBe('Meta Ads');
    expect(classifyChannel({ ms_click_id: 'abc123' })).toBe('Microsoft Ads');
  });

  it('classifies a paid utm_source+utm_medium pair without a click-id', () => {
    expect(classifyChannel({ utm_source: 'google', utm_medium: 'cpc' })).toBe('Google Ads');
    expect(classifyChannel({ utm_source: 'facebook', utm_medium: 'paid-social' })).toBe('Meta Ads');
    // Same utm_source, organic medium — not an ad.
    expect(classifyChannel({ utm_source: 'google', utm_medium: 'organic' })).toBe('Organic Search');
  });

  it('maps known utm_source values to a human channel', () => {
    expect(classifyChannel({ utm_source: 'chatgpt' })).toBe('ChatGPT');
    expect(classifyChannel({ utm_source: 'openai' })).toBe('ChatGPT');
    expect(classifyChannel({ utm_source: 'Claude' })).toBe('Claude');
    expect(classifyChannel({ utm_source: 'whatsapp' })).toBe('WhatsApp');
    expect(classifyChannel({ utm_source: 'linkedin' })).toBe('Social Media');
  });

  it('title-cases an unrecognised utm_source instead of dropping it', () => {
    expect(classifyChannel({ utm_source: 'partner_portal' })).toBe('Partner Portal');
  });

  it('falls back to referrer host when there is no utm_source', () => {
    expect(classifyChannel({ referrer_url: 'https://chat.openai.com/c/abc' })).toBe('ChatGPT');
    expect(classifyChannel({ referrer_url: 'https://www.google.com/search?q=kinematic' })).toBe('Organic Search');
    expect(classifyChannel({ referrer_url: 'https://www.linkedin.com/feed/' })).toBe('Social Media');
  });

  it('labels an unrecognised external referrer as a generic Referral', () => {
    expect(classifyChannel({ referrer_url: 'https://news.ycombinator.com/item?id=1' })).toBe('Referral (news.ycombinator.com)');
  });

  it('ignores an unparseable referrer_url and falls back to Direct', () => {
    expect(classifyChannel({ referrer_url: 'not-a-url' })).toBe('Direct');
  });
});

describe('webFormProvider.normalize — channel wiring', () => {
  it('sets channel from utm_source and keeps click-ids out of custom_fields', () => {
    const n = webFormProvider.normalize({
      name: 'Ravi Sharma', email: 'ravi@example.com', phone: '9876543210',
      utm_source: 'google_ads', utm_medium: 'cpc', gclid: 'Cj0abc',
    });
    expect(n.channel).toBe('Google Ads');
    expect(n.custom_fields).not.toHaveProperty('gclid');
    expect(n.custom_fields).not.toHaveProperty('utm_source');
  });

  it('defaults channel to Direct when the sender forwards no attribution at all', () => {
    const n = webFormProvider.normalize({ name: 'Ravi Sharma', email: 'ravi@example.com', phone: '9876543210' });
    expect(n.channel).toBe('Direct');
  });

  it('classifies from a bare external referrer when no utm tags are sent', () => {
    const n = webFormProvider.normalize({
      name: 'Ravi Sharma', email: 'ravi@example.com', phone: '9876543210',
      referrer_url: 'https://chatgpt.com/share/xyz',
    });
    expect(n.channel).toBe('ChatGPT');
    expect(n.referrer_url).toBe('https://chatgpt.com/share/xyz');
  });

  it('an unrecognised custom field still lands in custom_fields', () => {
    const n = webFormProvider.normalize({
      name: 'Ravi Sharma', email: 'ravi@example.com', phone: '9876543210', fe_count: '15',
    });
    expect(n.custom_fields).toEqual({ fe_count: '15' });
  });
});
