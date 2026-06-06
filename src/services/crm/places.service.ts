import { AppError } from '../../utils';

// Server-side Google Places (New) proxy so the mobile apps (and dashboard)
// can offer address autocomplete WITHOUT shipping a key — the web key is
// HTTP-referrer restricted and a key can only carry one restriction type, so
// a single server key (unrestricted or IP-restricted) is used here instead.
//
// Set GOOGLE_PLACES_API_KEY (preferred) or GOOGLE_MAPS_API_KEY in the backend
// env. With no key the endpoints return empty results, so callers degrade to
// manual address entry.
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';

export interface PlacePrediction { place_id: string; description: string; }

export interface PlaceDetail {
  address_line1: string;
  city?: string;
  state?: string;
  postal_code?: string;
  latitude?: number;
  longitude?: number;
}

/** Autocomplete predictions for a partial address (India-restricted). */
export async function autocomplete(input: string): Promise<PlacePrediction[]> {
  const q = (input || '').trim();
  if (!PLACES_KEY || q.length < 3) return [];
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY },
    body: JSON.stringify({ input: q, includedRegionCodes: ['in'] }),
  });
  if (!res.ok) throw new AppError(502, `Places autocomplete failed: ${await res.text()}`, 'PLACES_ERROR');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.suggestions ?? [])
    .filter((s: any) => s.placePrediction?.placeId)
    .map((s: any) => ({
      place_id: s.placePrediction.placeId as string,
      description: (s.placePrediction.text?.text ?? '') as string,
    }));
}

/** Resolve a place id to address parts + coordinates. */
export async function details(placeId: string): Promise<PlaceDetail | null> {
  if (!PLACES_KEY || !placeId) return null;
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'formattedAddress,addressComponents,location,displayName',
    },
  });
  if (!res.ok) throw new AppError(502, `Place details failed: ${await res.text()}`, 'PLACES_ERROR');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p: any = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comps: any[] = p.addressComponents ?? [];
  const get = (type: string) => comps.find((c) => (c.types ?? []).includes(type))?.longText as string | undefined;
  return {
    address_line1: p.formattedAddress ?? p.displayName?.text ?? '',
    city: get('locality') || get('administrative_area_level_3') || get('administrative_area_level_2'),
    state: get('administrative_area_level_1'),
    postal_code: get('postal_code'),
    latitude: p.location?.latitude,
    longitude: p.location?.longitude,
  };
}
