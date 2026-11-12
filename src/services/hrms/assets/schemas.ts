import { z } from 'zod';
import { isRealDate } from '../schemas';
import { ASSET_CONDITIONS, ASSET_TYPES } from './engine';

// Request validation for the Asset register (phase 6). Top-level keys are snake_case. zod only checks the TYPES/enums
// here; the plain-sentence rules whose words the dashboard already has ("Enter the make and the model.", "This serial
// number is already in the register.", the state-transition reasons) are applied in the service so the reason is the
// dashboard's, unprefixed.

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const uuid = z.string().uuid('Must be an id');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const num = z.number({ invalid_type_error: 'Must be a number', required_error: 'Required' }).finite('Must be a number');
const optText = (max: number) => z.preprocess(blank, z.string().max(max, `At most ${max} characters`).nullable().optional());

export const ASSET_TYPE = z.enum(ASSET_TYPES as [string, ...string[]]);
export const ASSET_CONDITION = z.enum(ASSET_CONDITIONS as [string, ...string[]]);
export const RETURN_NEXT = z.enum(['in_stock', 'in_repair', 'retired']);

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && isRealDate(s);

// ── create (addAsset) ─────────────────────────────────────────────────────────
// warranty is given either as warranty_months (the dashboard's NewAssetInput, used to compute warranty_end) or as an
// explicit warranty_end date; cost/condition/type/serial are checked for TYPE here and for the dashboard's rules in the
// service. tag is optional: the server assigns one unless a free tag is supplied.
export const assetCreate = z.object({
  id: uuid.optional(),
  tag: z.preprocess(blank, z.string().trim().max(60, 'At most 60 characters').nullable().optional()),
  type: ASSET_TYPE,
  make: z.string().max(120, 'At most 120 characters'),
  model: z.string().max(120, 'At most 120 characters'),
  serial: z.string().max(120, 'At most 120 characters'),
  purchase_date: z.string(),
  cost: num,
  warranty_months: z.preprocess(blank, z.number().int('Whole months only').min(0).max(600).nullable().optional()),
  warranty_end: z.preprocess(blank, dateStr.nullable().optional()),
  condition: ASSET_CONDITION,
});

// ── the seven commands ────────────────────────────────────────────────────────
export const issueBody = z.object({
  person_id: uuid,
  condition: ASSET_CONDITION,
  ack: z.boolean().optional(),
  note: optText(500),
});
export const returnBody = z.object({
  condition: ASSET_CONDITION,
  next: RETURN_NEXT,
  note: optText(500),
});
export const transferBody = z.object({
  to_id: uuid,
  condition: ASSET_CONDITION,
  ack: z.boolean().optional(),
  note: optText(500),
});
export const repairOutBody = z.object({ note: optText(500) });
export const repairBackBody = z.object({ condition: ASSET_CONDITION, note: optText(500) });
export const lostBody = z.object({ note: optText(500) });
export const retireBody = z.object({ note: optText(500) });

export type AssetCreateIn = z.infer<typeof assetCreate>;
