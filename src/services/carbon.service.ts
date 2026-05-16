import { supabaseAdmin } from '../lib/supabase';

const FALLBACK_FACTORS: Record<string, number> = {
  '2w_petrol': 0.072,
  '2w_ev': 0.022,
  '4w_petrol': 0.145,
  '4w_diesel': 0.171,
  '4w_ev': 0.045,
  'public_bus': 0.082,
  'auto_rickshaw': 0.108,
  'walking': 0,
};

export const VEHICLE_TYPES = Object.keys(FALLBACK_FACTORS);
export const DEFAULT_VEHICLE_TYPE = '2w_petrol';

const factorCache = new Map<string, { factors: Record<string, number>; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

export async function getEmissionFactors(orgId: string): Promise<Record<string, number>> {
  const hit = factorCache.get(orgId);
  if (hit && hit.expiresAt > Date.now()) return hit.factors;
  const { data } = await supabaseAdmin
    .from('org_settings')
    .select('value')
    .eq('org_id', orgId)
    .eq('key', 'carbon_factors')
    .maybeSingle();
  const factors = ((data as any)?.value?.factors_kg_per_km as Record<string, number>) || FALLBACK_FACTORS;
  factorCache.set(orgId, { factors, expiresAt: Date.now() + TTL_MS });
  return factors;
}

export async function resolveFactor(orgId: string, vehicleType: string): Promise<number> {
  const factors = await getEmissionFactors(orgId);
  return factors[vehicleType] ?? factors[DEFAULT_VEHICLE_TYPE] ?? 0.072;
}

export function clearCarbonCache(orgId?: string): void {
  if (orgId) factorCache.delete(orgId);
  else factorCache.clear();
}

export function normalizeVehicleType(input: any): string {
  const v = typeof input === 'string' ? input.trim() : '';
  return FALLBACK_FACTORS[v] !== undefined ? v : DEFAULT_VEHICLE_TYPE;
}
