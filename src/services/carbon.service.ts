// Vehicle-type registry shared by route planning and team auto-plan.
// (The carbon / emission-factor logic that previously lived here has been
// removed with the ESG feature; only vehicle-type handling remains.)

export const VEHICLE_TYPES = [
  '2w_petrol',
  '2w_ev',
  '4w_petrol',
  '4w_diesel',
  '4w_ev',
  'public_bus',
  'auto_rickshaw',
  'walking',
];

export const DEFAULT_VEHICLE_TYPE = '2w_petrol';

export function normalizeVehicleType(input: any): string {
  const v = typeof input === 'string' ? input.trim() : '';
  return VEHICLE_TYPES.includes(v) ? v : DEFAULT_VEHICLE_TYPE;
}
