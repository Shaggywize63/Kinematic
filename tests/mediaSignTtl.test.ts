/** Media signing: the expiry a caller may ask for (report exports need links that outlive the 5-minute default). */
jest.mock('../src/lib/projects', () => ({
  adminClientFor: jest.fn(), knownProjectKeys: jest.fn(() => []), getProjectConfig: jest.fn(), currentProjectKey: jest.fn(),
}));

import { resolveSignTtl, MAX_SIGN_TTL_SECONDS } from '../src/controllers/media.controller';

describe('resolveSignTtl', () => {
  it('keeps the short default when nothing valid is asked for', () => {
    for (const v of [undefined, null, '', 'abc', -5, 0, 60, '299', NaN]) expect(resolveSignTtl(v)).toBe(300);
  });
  it('honours a longer expiry', () => {
    expect(resolveSignTtl(3600)).toBe(3600);
    expect(resolveSignTtl('86400')).toBe(86400);
  });
  it('caps at 7 days', () => {
    expect(resolveSignTtl(99999999)).toBe(MAX_SIGN_TTL_SECONDS);
    expect(MAX_SIGN_TTL_SECONDS).toBe(604800);
  });
});
