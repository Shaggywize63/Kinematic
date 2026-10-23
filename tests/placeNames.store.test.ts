/**
 * Server-side place-name resolver (services/placeNames.store.ts): resolve many GPS points to names ONCE,
 * collapsing to ~11 m cells, serving the geo_places cache first, geocoding only the misses, persisting them,
 * and degrading gracefully when the cache table is absent.
 */
jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/crm/places.service', () => ({ reverseGeocode: jest.fn() }));

import { resolvePlaceNames, placeCell, resetPlaceNameNegativeCache } from '../src/services/placeNames.store';
import { reverseGeocode } from '../src/services/crm/places.service';

const supa = () => (global as any).__supa;
const geocode = reverseGeocode as jest.Mock;
/** geo_places default: upsert resolves ok; a select returns `cached` rows. */
const cache = (rows: Array<{ cell: string; name: string }>) =>
  supa().setDefault('geo_places', (c: any) => (c.ops.some((o: any) => o.method === 'upsert') ? { data: null, error: null } : { data: rows, error: null }));
const upserts = () => supa().chainsFor('geo_places').flatMap((c: any) => c.ops.filter((o: any) => o.method === 'upsert').flatMap((o: any) => (Array.isArray(o.args[0]) ? o.args[0] : [o.args[0]])));

beforeEach(() => { supa().reset(); resetPlaceNameNegativeCache(); geocode.mockReset(); cache([]); });

describe('placeCell', () => {
  it('is the ~11 m cell (4 decimals), matching the dashboard place-name cache', () => {
    expect(placeCell(22.69551, 88.39372)).toBe('22.6955,88.3937');
  });
});

describe('resolvePlaceNames', () => {
  it('collapses points in the same ~11 m cell to ONE geocode', async () => {
    geocode.mockResolvedValue('Welfare Association, Sodepur, Panihati');
    const names = await resolvePlaceNames([
      { lat: 22.69551, lng: 88.39372 }, { lat: 22.69553, lng: 88.39369 }, { lat: 22.69550, lng: 88.39374 },
    ]);
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(names.get('22.6955,88.3937')).toBe('Welfare Association, Sodepur, Panihati');
  });

  it('skips invalid / no-fix points (NaN, out of range, null island)', async () => {
    geocode.mockResolvedValue('Somewhere');
    const names = await resolvePlaceNames([
      { lat: 0, lng: 0 }, { lat: NaN, lng: 88.4 }, { lat: 200, lng: 88.4 },
    ]);
    expect(geocode).not.toHaveBeenCalled();
    expect(names.size).toBe(0);
  });

  it('serves a cached cell without geocoding, and geocodes + persists only the miss', async () => {
    cache([{ cell: '22.7006,88.3816', name: 'Sodepur Station Road' }]);
    geocode.mockResolvedValue('Jogen Roy Road, Barrackpore');
    const names = await resolvePlaceNames([
      { lat: 22.7006, lng: 88.3816 },   // cached
      { lat: 22.7541, lng: 88.3714 },   // miss → geocoded
    ]);
    expect(names.get('22.7006,88.3816')).toBe('Sodepur Station Road');       // from cache
    expect(names.get('22.7541,88.3714')).toBe('Jogen Roy Road, Barrackpore'); // geocoded
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(upserts().some((r: any) => r.cell === '22.7541,88.3714' && r.name === 'Jogen Roy Road, Barrackpore')).toBe(true);
  });

  it('a point Google cannot name is left out and not retried within the process (negative cache)', async () => {
    geocode.mockResolvedValue(null);
    const first = await resolvePlaceNames([{ lat: 22.75, lng: 88.37 }]);
    expect(first.size).toBe(0);
    expect(upserts()).toHaveLength(0);                 // nothing persisted for a null
    await resolvePlaceNames([{ lat: 22.75, lng: 88.37 }]);
    expect(geocode).toHaveBeenCalledTimes(1);          // second call served from the negative cache
  });

  it('degrades when geo_places is absent: still geocodes and returns names, swallows the table error', async () => {
    supa().setDefault('geo_places', { data: null, error: { message: 'relation "geo_places" does not exist', code: '42P01' } });
    geocode.mockResolvedValue('Welfare Association, Sodepur, Panihati');
    const names = await resolvePlaceNames([{ lat: 22.6955, lng: 88.3937 }]);
    expect(names.get('22.6955,88.3937')).toBe('Welfare Association, Sodepur, Panihati');
  });
});
