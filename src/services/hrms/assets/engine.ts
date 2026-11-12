// Asset register: the small pieces of the dashboard's assetsEngine.ts the server needs, ported verbatim (names, maths and
// comments kept) so tag assignment and the warranty date match the dashboard exactly. No database access here.
//   - ASSET_TYPES: the type -> tag prefix table (the rest of the dashboard row is UI only).
//   - nextTag(existingTagsOfType, type): AST-<PREFIX>-NNN, the next free number for that type.
//   - addMonthsISO(date, months): the warranty end date addAsset computes from warrantyMonths.

export type AssetType = 'laptop' | 'phone' | 'sim' | 'vehicle' | 'id_card' | 'uniform' | 'tool';
export type AssetStatus = 'in_stock' | 'issued' | 'in_repair' | 'lost' | 'retired';
export type AssetCondition = 'new' | 'good' | 'fair' | 'poor' | 'damaged';
export type AssetEventKind = 'purchased' | 'issued' | 'returned' | 'transferred' | 'repair_out' | 'repair_back' | 'lost' | 'retired';

export const ASSET_TYPES: AssetType[] = ['laptop', 'phone', 'sim', 'vehicle', 'id_card', 'uniform', 'tool'];
export const ASSET_STATUSES: AssetStatus[] = ['in_stock', 'issued', 'in_repair', 'lost', 'retired'];
export const ASSET_CONDITIONS: AssetCondition[] = ['new', 'good', 'fair', 'poor', 'damaged'];

/** The tag prefix per type (ASSET_TYPES in assetsEngine.ts). Only the prefix matters on the server; the rest is UI. */
const TYPE_PREFIX: Record<AssetType, string> = {
  laptop: 'LAP', phone: 'PHN', sim: 'SIM', vehicle: 'VEH', id_card: 'IDC', uniform: 'UNI', tool: 'TLS',
};
export const typePrefix = (t: AssetType): string => TYPE_PREFIX[t];

/**
 * The next tag for a type, the dashboard's nextTag: AST-<PREFIX>-NNN where NNN is one past the highest number already
 * used by a tag of that type. Takes the tags already in the register for that type (the service reads them scoped to the org).
 */
export function nextTag(tagsOfType: string[], type: AssetType): string {
  const prefix = typePrefix(type);
  const max = tagsOfType.reduce((m, tag) => Math.max(m, Number(String(tag).split('-').pop()) || 0), 0);
  return `AST-${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** Adds whole months, clamping the day to the end of a shorter month (31 Aug + 6 months = 28 Feb). From assetsEngine.ts. */
export function addMonthsISO(d: string, months: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
}
