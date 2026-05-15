import { resolveFactor, normalizeVehicleType } from './carbon.service';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface OutletPoint extends GeoPoint {
  id: string;
}

export interface OptimizeResult {
  ordered: string[];
  original_km: number;
  optimized_km: number;
  saved_km: number;
  saved_co2_kg: number;
  method: 'nearest_neighbour_2opt_haversine';
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function totalDistance(start: GeoPoint, route: OutletPoint[]): number {
  if (!route.length) return 0;
  let sum = haversineKm(start, route[0]);
  for (let i = 1; i < route.length; i++) sum += haversineKm(route[i - 1], route[i]);
  return sum;
}

function nearestNeighbour(start: GeoPoint, outlets: OutletPoint[]): OutletPoint[] {
  const remaining = [...outlets];
  const ordered: OutletPoint[] = [];
  let cursor: GeoPoint = start;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = haversineKm(cursor, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const d = haversineKm(cursor, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    cursor = remaining[bestIdx];
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

function twoOpt(start: GeoPoint, route: OutletPoint[]): OutletPoint[] {
  if (route.length < 4) return route;
  const best = [...route];
  let improved = true;
  let safety = 50;
  while (improved && safety-- > 0) {
    improved = false;
    const baseDist = totalDistance(start, best);
    outer: for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        if (totalDistance(start, candidate) + 1e-9 < baseDist) {
          best.splice(0, best.length, ...candidate);
          improved = true;
          break outer;
        }
      }
    }
  }
  return best;
}

function round(n: number, dp: number): number {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

export async function optimizeRoute(
  orgId: string,
  vehicleType: string,
  start: GeoPoint | undefined,
  outlets: OutletPoint[],
): Promise<OptimizeResult> {
  const clean = (outlets || []).filter(
    (o) => o && typeof o.lat === 'number' && typeof o.lng === 'number' && !isNaN(o.lat) && !isNaN(o.lng),
  );
  if (clean.length === 0) {
    return {
      ordered: [],
      original_km: 0,
      optimized_km: 0,
      saved_km: 0,
      saved_co2_kg: 0,
      method: 'nearest_neighbour_2opt_haversine',
    };
  }
  const origin: GeoPoint =
    start && typeof start.lat === 'number' && typeof start.lng === 'number'
      ? { lat: start.lat, lng: start.lng }
      : { lat: clean[0].lat, lng: clean[0].lng };

  const originalKm = totalDistance(origin, clean);
  const nn = nearestNeighbour(origin, clean);
  const final = twoOpt(origin, nn);
  const optimizedKm = totalDistance(origin, final);
  const savedKm = Math.max(0, originalKm - optimizedKm);

  const factor = await resolveFactor(orgId, normalizeVehicleType(vehicleType));
  const savedCo2 = savedKm * factor;

  return {
    ordered: final.map((o) => o.id),
    original_km: round(originalKm, 2),
    optimized_km: round(optimizedKm, 2),
    saved_km: round(savedKm, 2),
    saved_co2_kg: round(savedCo2, 3),
    method: 'nearest_neighbour_2opt_haversine',
  };
}
