import { AppError } from '../../../utils';
import { db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, newId, notFound, refuse } from '../payroll/common';
import { addMonthsISO, AssetEventKind, AssetType, nextTag } from './engine';
import { assetOut, eventOut } from './mapping';
import type { AssetCreateIn } from './schemas';
import { isDate } from './schemas';

// The asset register. The rules are the dashboard's rewards/store.ts (addAsset + issueAsset / returnAsset / transferAsset /
// sendToRepair / backFromRepair / markLost / retireAsset) and assetsEngine.ts (nextTag), with their exact plain words. The
// server is the authority: it refuses, and the UI shows the reason it gives.
//
//   in_stock --issue--> issued --return(in_stock|in_repair|retired)--> ...
//     \--repair_out--> in_repair --repair_back--> in_stock        issued --transfer--> issued
//      \--lost        in_stock|in_repair --retire--> retired      in_stock|issued --lost--> lost
//
// Create (the asset + its 'purchased' event) and every command are plpgsql functions (migration_hrms_assets.sql), so each
// is one transaction: an asset never exists without its opening event, and of two concurrent issues of one asset one wins.

const ASSETS = 'hrms_assets';
const EVENTS = 'hrms_asset_events';

const today = (): string => new Date().toISOString().slice(0, 10);

// ── reading ───────────────────────────────────────────────────────────────────
async function find(s: HrmsScope, id: string): Promise<Row | null> {
  return must(await scoped(db().from(ASSETS).select('*'), s).eq('id', id).maybeSingle()) as Row | null;
}
async function liveEmployee(s: HrmsScope, id: string): Promise<Row | null> {
  return must(await scoped(db().from('hrms_employees').select('id'), s).eq('id', id).is('deleted_at', null).maybeSingle()) as Row | null;
}
/** The asset's opening ('purchased') event — its earliest by insertion order. */
async function purchasedEvent(s: HrmsScope, assetId: string): Promise<Row | null> {
  const rows = (must(await scoped(db().from(EVENTS).select('*'), s).eq('asset_id', assetId)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1)) as Row[] | null) ?? [];
  return rows[0] ?? null;
}
async function readAssetAndEvent(s: HrmsScope, assetId: string, eventId: string): Promise<{ asset: Row; event: Row }> {
  const [asset, event] = await Promise.all([
    find(s, assetId),
    must(await scoped(db().from(EVENTS).select('*'), s).eq('id', eventId).maybeSingle()) as Promise<Row | null>,
  ]);
  if (!asset) throw notFound('That asset is not in the register.');
  return { asset: assetOut(asset), event: event ? eventOut(event) : eventOut({ asset_id: assetId }) };
}

// ── the dashboard's plain refusals ─────────────────────────────────────────────
const NOT_IN_REGISTER = 'That asset is not in the register.';

/** The state-transition reason for a command on an asset in the wrong status, word for word from store.ts. */
function stateRefusal(kind: AssetEventKind, asset: Row): AppError {
  const status = String(asset.status);
  const readable = status.replace('_', ' ');
  switch (kind) {
    case 'issued': return refuse(409, `${asset.tag} is ${readable}, so it cannot be issued.`, 'ASSET_STATE');
    case 'returned': return refuse(409, 'Only an issued asset can be returned.', 'ASSET_STATE');
    case 'transferred': return refuse(409, 'Only an issued asset can be transferred.', 'ASSET_STATE');
    case 'repair_out': return refuse(409, 'Only an asset in stock or issued can go for repair.', 'ASSET_STATE');
    case 'repair_back': return refuse(409, 'Only an asset in repair can come back from repair.', 'ASSET_STATE');
    case 'lost': return refuse(409, 'Only an asset in stock or issued can be marked lost.', 'ASSET_STATE');
    case 'retired': return refuse(409, 'Only an asset in stock or in repair can be retired.', 'ASSET_STATE');
    default: return refuse(409, 'That transition is not allowed.', 'ASSET_STATE');
  }
}

/** Map a failure of hrms_asset_apply_event (token as the message, SQLSTATE P0001) to the dashboard's plain refusal. */
async function rpcError(s: HrmsScope, assetId: string, kind: AssetEventKind, error: { code?: string; message?: string }): Promise<AppError> {
  switch ((error.message ?? '').trim()) {
    case 'ASSET_NOT_FOUND': return notFound(NOT_IN_REGISTER);
    case 'ASSET_SAME_HOLDER': return refuse(409, 'It is already with this person.', 'ASSET_STATE');
    case 'ASSET_STATE': {
      const a = await find(s, assetId);
      return a ? stateRefusal(kind, a) : notFound(NOT_IN_REGISTER);
    }
    default: return fail(error);
  }
}

interface ApplyParams { to_id?: string | null; condition?: string | null; next?: string | null; ack?: boolean | null; note?: string | null }

/** Apply one transition through the atomic function, then return the updated asset and the appended event. */
async function apply(s: HrmsScope, assetId: string, kind: AssetEventKind, p: ApplyParams): Promise<{ asset: Row; event: Row }> {
  const { data, error } = await db().rpc('hrms_asset_apply_event', {
    p_org: s.org_id, p_asset: assetId, p_kind: kind, p_on: today(),
    p_to_id: p.to_id ?? null, p_condition: p.condition ?? null, p_next_status: p.next ?? null,
    p_ack: p.ack ?? null, p_note: p.note ?? null, p_by: s.actor,
  });
  if (error) throw await rpcError(s, assetId, kind, error);
  return readAssetAndEvent(s, assetId, String(data));
}

// ── create (addAsset) ───────────────────────────────────────────────────────────
async function tagsOfType(s: HrmsScope, type: AssetType): Promise<string[]> {
  const rows = await fetchAll<Row>((from, to) => scoped(db().from(ASSETS).select('tag'), s).eq('type', type).range(from, to));
  return rows.map((r) => String(r.tag));
}
async function tagTaken(s: HrmsScope, tag: string): Promise<boolean> {
  return !!(must(await scoped(db().from(ASSETS).select('id'), s).eq('tag', tag).maybeSingle()) as Row | null);
}
/** A supplied tag if it is free, else the next tag for the type (the dashboard's nextTag). */
async function resolveTag(s: HrmsScope, type: AssetType, supplied: string | null): Promise<string> {
  if (supplied && !(await tagTaken(s, supplied))) return supplied;
  return nextTag(await tagsOfType(s, type), type);
}

async function assetWithPurchased(s: HrmsScope, asset: Row): Promise<{ asset: Row; event: Row }> {
  const ev = await purchasedEvent(s, String(asset.id));
  return { asset: assetOut(asset), event: ev ? eventOut(ev) : eventOut({ asset_id: asset.id }) };
}

export interface CreatedAsset { data: { asset: Row; event: Row }; created: boolean }

export async function createAsset(s: HrmsScope, input: AssetCreateIn): Promise<CreatedAsset> {
  // the dashboard addAsset checks, in its order and with its words
  if (!input.make.trim() || !input.model.trim()) throw invalid('Enter the make and the model.');
  if (!input.serial.trim()) throw invalid('Enter the serial number.');
  if (!(input.cost > 0)) throw invalid('Enter the purchase cost.');
  if (!isDate(input.purchase_date) || input.purchase_date > today()) throw invalid('The purchase date cannot be in the future.');

  const id = (input.id as string | undefined) ?? newId();
  if (input.id) {
    const existing = await find(s, id);
    if (existing) return { data: await assetWithPurchased(s, existing), created: false };
  }

  const make = input.make.trim();
  const model = input.model.trim();
  const serial = input.serial.trim();
  const cost = Math.round(input.cost);
  const warrantyEnd = input.warranty_months != null && input.warranty_months > 0
    ? addMonthsISO(input.purchase_date, input.warranty_months)
    : (input.warranty_end ?? null);
  let tag = await resolveTag(s, input.type as AssetType, (input.tag as string | undefined) ?? null);

  // The serial unique index and the tag unique index are the race-safe backstops: a serial clash is the dashboard's plain
  // reason, a raced tag is recomputed and retried (a supplied-but-just-taken tag also falls back to the next free one).
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await db().rpc('hrms_asset_create', {
      p_org: s.org_id, p_asset: id, p_tag: tag, p_type: input.type, p_make: make, p_model: model, p_serial: serial,
      p_purchase_date: input.purchase_date, p_cost: cost, p_warranty_end: warrantyEnd, p_condition: input.condition, p_on: input.purchase_date, p_by: s.actor,
    });
    if (!error) return { data: await readAssetAndEvent(s, id, String(data)), created: true };
    if (isUniqueViolation(error, 'hrms_assets_org_serial_uq')) throw invalid('This serial number is already in the register.');
    if (isUniqueViolation(error, 'hrms_assets_org_tag_uq')) { tag = nextTag(await tagsOfType(s, input.type as AssetType), input.type as AssetType); continue; }
    if (input.id && isUniqueViolation(error, 'pkey')) {
      const mine = await find(s, id);
      if (mine) return { data: await assetWithPurchased(s, mine), created: false };
      throw refuse(409, 'This id is already in use', 'ID_IN_USE');
    }
    throw fail(error);
  }
  throw refuse(409, 'Could not assign a free tag for this asset. Try again.', 'ASSET_TAG');
}

// ── the seven commands (store.ts, with its words and its order of checks) ───────
export async function issueAsset(s: HrmsScope, assetId: string, input: { person_id: string; condition: string; ack?: boolean; note?: string | null }): Promise<{ asset: Row; event: Row }> {
  const a = await find(s, assetId);
  if (!a) throw notFound(NOT_IN_REGISTER);
  if (a.status !== 'in_stock') throw stateRefusal('issued', a);
  if (!(await liveEmployee(s, input.person_id))) throw invalid('Choose who it is for.');
  if (!input.ack) throw invalid('The receiver has to acknowledge receipt before it is issued.');
  return apply(s, assetId, 'issued', { to_id: input.person_id, condition: input.condition, ack: true, note: input.note ?? null });
}

export async function returnAsset(s: HrmsScope, assetId: string, input: { condition: string; next: string; note?: string | null }): Promise<{ asset: Row; event: Row }> {
  const a = await find(s, assetId);
  if (!a) throw notFound(NOT_IN_REGISTER);
  if (a.status !== 'issued') throw stateRefusal('returned', a);
  return apply(s, assetId, 'returned', { condition: input.condition, next: input.next, note: input.note ?? null });
}

export async function transferAsset(s: HrmsScope, assetId: string, input: { to_id: string; condition: string; ack?: boolean; note?: string | null }): Promise<{ asset: Row; event: Row }> {
  const a = await find(s, assetId);
  if (!a) throw notFound(NOT_IN_REGISTER);
  if (a.status !== 'issued') throw stateRefusal('transferred', a);
  if (a.holder_id === input.to_id) throw refuse(409, 'It is already with this person.', 'ASSET_STATE');
  if (!(await liveEmployee(s, input.to_id))) throw invalid('Choose who receives it.');
  if (!input.ack) throw invalid('The new holder has to acknowledge receipt before it is transferred.');
  return apply(s, assetId, 'transferred', { to_id: input.to_id, condition: input.condition, ack: true, note: input.note ?? null });
}

export async function sendToRepair(s: HrmsScope, assetId: string, input: { note?: string | null }): Promise<{ asset: Row; event: Row }> {
  const a = await find(s, assetId);
  if (!a) throw notFound(NOT_IN_REGISTER);
  if (a.status !== 'in_stock' && a.status !== 'issued') throw stateRefusal('repair_out', a);
  return apply(s, assetId, 'repair_out', { note: input.note ?? null });
}

export async function backFromRepair(s: HrmsScope, assetId: string, input: { condition: string; note?: string | null }): Promise<{ asset: Row; event: Row }> {
  const a = await find(s, assetId);
  if (!a) throw notFound(NOT_IN_REGISTER);
  if (a.status !== 'in_repair') throw stateRefusal('repair_back', a);
  return apply(s, assetId, 'repair_back', { condition: input.condition, note: input.note ?? null });
}

export async function markLost(s: HrmsScope, assetId: string, input: { note?: string | null }): Promise<{ asset: Row; event: Row }> {
  const a = await find(s, assetId);
  if (!a) throw notFound(NOT_IN_REGISTER);
  if (a.status !== 'in_stock' && a.status !== 'issued') throw stateRefusal('lost', a);
  return apply(s, assetId, 'lost', { note: input.note ?? null });
}

export async function retireAsset(s: HrmsScope, assetId: string, input: { note?: string | null }): Promise<{ asset: Row; event: Row }> {
  const a = await find(s, assetId);
  if (!a) throw notFound(NOT_IN_REGISTER);
  if (a.status !== 'in_stock' && a.status !== 'in_repair') throw stateRefusal('retired', a);
  return apply(s, assetId, 'retired', { note: input.note ?? null });
}
