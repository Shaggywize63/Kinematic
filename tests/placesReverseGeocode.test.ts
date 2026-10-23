/**
 * reverseGeocode (services/crm/places.service) pins the result language and region, so the server resolves one
 * consistent name per point (English / India) instead of each dashboard browser geocoding it in its own locale.
 */
process.env.GOOGLE_PLACES_API_KEY = 'test-key';
import { reverseGeocode } from '../src/services/crm/places.service';

const okJson = (body: unknown) => ({ ok: true, json: async () => body });

describe('reverseGeocode language/region pinning', () => {
  afterEach(() => { (global as any).fetch = undefined; });

  it('requests English / India and returns the formatted address', async () => {
    let calledUrl = '';
    (global as any).fetch = jest.fn(async (url: string) => { calledUrl = url; return okJson({ status: 'OK', results: [{ formatted_address: 'Welfare Association, Sodepur, Panihati, West Bengal 700114, India' }] }); });
    const name = await reverseGeocode(22.6955, 88.3937);
    expect(calledUrl).toContain('language=en');
    expect(calledUrl).toContain('region=in');
    expect(calledUrl).toContain('latlng=22.6955,88.3937');
    expect(name).toBe('Welfare Association, Sodepur, Panihati, West Bengal 700114, India');
  });

  it('returns null for the (0,0) no-fix placeholder without calling Google', async () => {
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    expect(await reverseGeocode(0, 0)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
