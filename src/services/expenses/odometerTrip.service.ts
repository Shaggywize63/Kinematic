/**
 * Daily odometer trip — the two-step flow for field reps whose policy opts in with `odometer_daily_trip`.
 *
 * A rep cannot know the evening reading in the morning, so this splits the one before/after odometer line
 * into two moments:
 *   - START (morning): the rep records the starting reading + photo and picks the vehicle. The server opens
 *     the day's travel as a DRAFT expense claim carrying a single mileage line with only the start reading —
 *     exactly the "lenient draft" the claim engine already allows (see vehicleAllowance.ts).
 *   - END (evening): the rep records the ending reading + photo. The server fills the same line's end reading,
 *     and the normal pricing (distance = end − start, amount = distance × the vehicle's rate) runs, so the
 *     mileage line is built and priced automatically — the claim is then ready to review and submit.
 *
 * Nothing new is stored: the trip IS the day's draft claim + its mileage line, so odometer history, approval,
 * CSV export and everything else keep working unchanged. The combined before/after editor still works for
 * every other client; this only adds the split surface for the ones that turn the flag on (Agrisynx).
 *
 * Opt-in by data and gated: when the governing policy does not have `odometer_daily_trip` AND at least one
 * vehicle rate, GET reports the flow as off and START/END refuse — so the endpoints are a true no-op for
 * everyone else.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { Actor } from './access';
import { resolvePolicyForUserId, ExpensePolicy } from './policy.service';
import { signReceipt } from './receipts.service';
import { soleVehicle, vehicleFlowOn, VehicleRate } from './vehicleAllowance';
import { createClaim, updateClaim, getClaim, ClaimItemInput } from './expenses.service';

// ── pure rules (unit-tested) ─────────────────────────────────────────────────

export interface DailyTripRules {
  vehicle_rates?: VehicleRate[];
  odometer_daily_trip?: boolean;
  odometer_photos_required?: boolean;
  odometer_camera_only?: boolean;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const nonBlank = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/** The daily start/end flow is on only when the policy opts in AND pays by vehicle (it needs a rate to price). */
export function dailyTripEnabled(rules?: DailyTripRules | null): boolean {
  return !!rules?.odometer_daily_trip && vehicleFlowOn(rules ?? undefined);
}

/** A photo of each reading is mandatory unless the policy explicitly turns it off. */
export const photosRequired = (rules?: DailyTripRules | null): boolean => rules?.odometer_photos_required !== false;

/**
 * The vehicle id to record the trip against: the given one when it is one of the policy's rates, else the
 * policy's sole vehicle (nothing to choose when there is exactly one), else null (the rep must pick).
 */
export function resolveTripVehicle(vehicleType: unknown, rules?: DailyTripRules | null): string | null {
  const rates = rules?.vehicle_rates ?? [];
  const v = typeof vehicleType === 'string' ? vehicleType.trim() : '';
  if (v && rates.some((r) => r.id === v)) return v;
  const sole = soleVehicle(rates);
  return sole ? sole.id : null;
}

/** Distance for a start/end pair: end − start when both are present and end ≥ start, else null. */
export function tripDistance(start: unknown, end: unknown): number | null {
  const s = num(start);
  const e = num(end);
  if (s == null || e == null || e < s) return null;
  return round2(e - s);
}

export type TripStatus = 'none' | 'open' | 'closed';

/** none = no reading yet; open = started, waiting for the evening reading; closed = both readings in. */
export function tripStatus(start: unknown, end: unknown): TripStatus {
  if (num(start) == null) return 'none';
  return num(end) == null ? 'open' : 'closed';
}

export interface TripProblem { code: string; detail: string }

export interface StartInput { odometer_start?: unknown; vehicle_type?: unknown; start_photo_url?: unknown }
export interface EndInput { odometer_end?: unknown; end_photo_url?: unknown }

/** What is still missing before a day's trip can be STARTED. */
export function startProblems(input: StartInput, rules: DailyTripRules): TripProblem[] {
  const problems: TripProblem[] = [];
  if (!resolveTripVehicle(input.vehicle_type, rules)) {
    problems.push({ code: 'vehicle_missing', detail: 'Pick the vehicle you’re travelling in.' });
  }
  if (num(input.odometer_start) == null) {
    problems.push({ code: 'start_missing', detail: 'Enter the odometer reading at the start of the day.' });
  }
  if (photosRequired(rules) && !nonBlank(input.start_photo_url)) {
    problems.push({ code: 'start_photo_missing', detail: 'Add a photo of the starting odometer.' });
  }
  return problems;
}

/** What is still wrong before a started trip can be ENDED. `startReading` is the reading already on file. */
export function endProblems(startReading: unknown, input: EndInput, rules: DailyTripRules): TripProblem[] {
  const problems: TripProblem[] = [];
  const start = num(startReading);
  if (start == null) {
    problems.push({ code: 'not_started', detail: 'Record the starting reading before ending the day.' });
  }
  const end = num(input.odometer_end);
  if (end == null) {
    problems.push({ code: 'end_missing', detail: 'Enter the odometer reading at the end of the day.' });
  } else if (start != null && end < start) {
    problems.push({ code: 'end_before_start', detail: 'The end reading is lower than the start reading.' });
  }
  if (photosRequired(rules) && !nonBlank(input.end_photo_url)) {
    problems.push({ code: 'end_photo_missing', detail: 'Add a photo of the ending odometer.' });
  }
  return problems;
}

/** A readable title for the day's travel claim, e.g. "Travel — 2026-10-12". */
export const tripTitle = (date: string): string => `Travel — ${date}`;

// ── IST day ──────────────────────────────────────────────────────────────────
/** Today in IST as YYYY-MM-DD — the day boundary the apps and every other travel figure already use. */
export function tripDateIst(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const normDate = (d: unknown): string => (typeof d === 'string' && YMD.test(d.trim()) ? d.trim() : tripDateIst());

// ── DB orchestration ──────────────────────────────────────────────────────────

/** The vehicle rates + flags the apps need to render the trip surface. */
function tripConfig(rules: DailyTripRules) {
  return {
    vehicle_rates: (rules.vehicle_rates ?? []).map((r) => ({ id: r.id, label: r.label, rate_per_km: r.rate_per_km })),
    sole_vehicle: soleVehicle(rules.vehicle_rates ?? [])?.id ?? null,
    photos_required: photosRequired(rules),
    camera_only: rules.odometer_camera_only === true,
  };
}

// One query for the day's mileage line, mirroring odometerHistory's proven claim embed.
const LINE_COLUMNS = 'id, claim_id, item_date, vehicle_type, odometer_start, odometer_end, distance_km, amount, '
  + 'odometer_start_photo_url, odometer_end_photo_url, created_at, '
  + 'claim:expense_claims!inner(id, claim_no, status, user_id, org_id)';

interface TripLine {
  id: string; claim_id: string; claim_no: string | null; claim_status: string;
  item_date: string | null; vehicle_type: string | null;
  odometer_start: number | null; odometer_end: number | null; distance_km: number | null; amount: number;
  odometer_start_photo_url: string | null; odometer_end_photo_url: string | null; created_at: string | null;
}

/**
 * The day's trip line for the user, newest first. `editableOnly` keeps only DRAFT claims (what START/END may
 * touch); otherwise a submitted/rejected trip is returned too so the app can show today was already filed.
 * Cancelled claims are always excluded.
 */
async function findTripLines(actor: Actor, date: string, editableOnly: boolean): Promise<TripLine[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin.from('expense_claim_items').select(LINE_COLUMNS) as any)
    .eq('org_id', actor.org_id)
    .eq('claim.org_id', actor.org_id)
    .eq('claim.user_id', actor.id)
    .eq('category', 'mileage')
    .eq('item_date', date)
    .neq('claim.status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new AppError(500, error.message, 'DB');
  const rows = ((data as any[]) ?? [])
    .map((r) => ({ ...r, claim: Array.isArray(r.claim) ? r.claim[0] : r.claim }))
    .filter((r) => r.claim && r.claim.user_id === actor.id)
    .map((r): TripLine => ({
      id: r.id, claim_id: r.claim_id, claim_no: r.claim.claim_no ?? null, claim_status: r.claim.status,
      item_date: r.item_date ?? null, vehicle_type: r.vehicle_type ?? null,
      odometer_start: num(r.odometer_start), odometer_end: num(r.odometer_end),
      distance_km: num(r.distance_km), amount: Number(r.amount || 0),
      odometer_start_photo_url: r.odometer_start_photo_url ?? null, odometer_end_photo_url: r.odometer_end_photo_url ?? null,
      created_at: r.created_at ?? null,
    }));
  return editableOnly ? rows.filter((r) => r.claim_status === 'draft') : rows;
}

/** The open trip to extend: a draft mileage line that has a start reading and no end. */
const openTrip = (lines: TripLine[]): TripLine | undefined =>
  lines.find((l) => l.claim_status === 'draft' && l.odometer_start != null && l.odometer_end == null);

/** The best line to show for the day: an open one first, else the most recent (incl. closed/submitted). */
const displayTrip = (lines: TripLine[]): TripLine | undefined => openTrip(lines) ?? lines[0];

async function tripView(actor: Actor, line: TripLine | undefined) {
  if (!line) return null;
  const [startPhoto, endPhoto] = await Promise.all([
    signReceipt(actor.org_id, line.odometer_start_photo_url),
    signReceipt(actor.org_id, line.odometer_end_photo_url),
  ]);
  const submitted = line.claim_status !== 'draft';
  return {
    claim_id: line.claim_id,
    claim_no: line.claim_no,
    claim_status: line.claim_status,
    item_id: line.id,
    date: line.item_date,
    vehicle_type: line.vehicle_type,
    odometer_start: line.odometer_start,
    odometer_end: line.odometer_end,
    distance_km: line.distance_km,
    amount: line.amount,
    start_photo_url: startPhoto,
    end_photo_url: endPhoto,
    // A line whose claim is already submitted/approved can no longer be edited from the trip surface.
    status: submitted ? 'closed' : tripStatus(line.odometer_start, line.odometer_end),
    editable: !submitted,
  };
}

/** Turn a stored line into the input shape updateClaim expects, so untouched lines on the claim pass through. */
const lineToInput = (l: any): ClaimItemInput => ({
  id: l.id, category: l.category, item_date: l.item_date ?? null, description: l.description ?? null,
  amount: l.amount ?? null, distance_km: l.distance_km ?? null, from_location: l.from_location ?? null,
  to_location: l.to_location ?? null, merchant: l.merchant ?? null, receipt_url: l.receipt_url ?? null,
  vehicle_type: l.vehicle_type ?? null, odometer_start: l.odometer_start ?? null, odometer_end: l.odometer_end ?? null,
  odometer_start_photo_url: l.odometer_start_photo_url ?? null, odometer_end_photo_url: l.odometer_end_photo_url ?? null,
});

async function requireEnabled(actor: Actor): Promise<ExpensePolicy> {
  const policy = await resolvePolicyForUserId(actor.org_id, actor.client_id ?? null, actor.id);
  if (!dailyTripEnabled(policy.rules)) {
    throw new AppError(409, 'The daily odometer trip is not enabled for your expense policy', 'DAILY_TRIP_OFF');
  }
  return policy;
}

/** GET — the day's trip plus the config the app renders. Reports the flow as off instead of failing. */
export async function getTrip(actor: Actor, dateIn?: string) {
  const policy = await resolvePolicyForUserId(actor.org_id, actor.client_id ?? null, actor.id);
  const date = normDate(dateIn);
  if (!dailyTripEnabled(policy.rules)) return { enabled: false, date, trip: null };
  const lines = await findTripLines(actor, date, false);
  return { enabled: true, date, ...tripConfig(policy.rules), trip: await tripView(actor, displayTrip(lines)) };
}

/** POST /start — record the morning reading. Idempotent for the day: a second start updates the open trip. */
export async function startTrip(
  actor: Actor,
  input: { odometer_start?: unknown; vehicle_type?: unknown; start_photo_url?: unknown; date?: unknown },
) {
  const policy = await requireEnabled(actor);
  const rules = policy.rules;
  const problems = startProblems(input, rules);
  if (problems.length) throw new AppError(400, problems[0].detail, 'VALIDATION');

  const date = normDate(input.date);
  const vehicle = resolveTripVehicle(input.vehicle_type, rules)!;
  const start = num(input.odometer_start)!;
  const startPhoto = nonBlank(input.start_photo_url) ? String(input.start_photo_url).trim() : null;

  const existing = openTrip(await findTripLines(actor, date, true));
  if (existing) {
    // Re-start the same day: refresh the open line's start reading / photo / vehicle, leave the rest alone.
    const items = (await loadClaimInputs(actor, existing.claim_id)).map((it) => (it.id === existing.id
      ? { ...it, vehicle_type: vehicle, odometer_start: start, odometer_start_photo_url: startPhoto }
      : it));
    await updateClaim(actor, existing.claim_id, { items });
    return getTrip(actor, date);
  }

  await createClaim(actor, {
    title: tripTitle(date),
    items: [{
      category: 'mileage', item_date: date, vehicle_type: vehicle,
      odometer_start: start, odometer_start_photo_url: startPhoto,
    }],
  });
  return getTrip(actor, date);
}

/** POST /end — record the evening reading; the mileage line is priced and the claim is ready to submit. */
export async function endTrip(
  actor: Actor,
  input: { odometer_end?: unknown; end_photo_url?: unknown; date?: unknown },
) {
  const policy = await requireEnabled(actor);
  const rules = policy.rules;
  const date = normDate(input.date);

  const open = openTrip(await findTripLines(actor, date, true));
  if (!open) throw new AppError(404, 'No trip has been started today to end', 'NO_OPEN_TRIP');

  const problems = endProblems(open.odometer_start, input, rules);
  if (problems.length) throw new AppError(400, problems[0].detail, 'VALIDATION');

  const end = num(input.odometer_end)!;
  const endPhoto = nonBlank(input.end_photo_url) ? String(input.end_photo_url).trim() : null;
  const items = (await loadClaimInputs(actor, open.claim_id)).map((it) => (it.id === open.id
    ? { ...it, odometer_end: end, odometer_end_photo_url: endPhoto }
    : it));
  await updateClaim(actor, open.claim_id, { items });

  // Return the completed trip view AND the full claim so the app can open it ready to submit.
  const trip = await getTrip(actor, date);
  const claim = await getClaim(actor, open.claim_id);
  return { ...trip, claim };
}

/** The current lines of a claim as updateClaim inputs (so we touch only the trip line and keep the others). */
async function loadClaimInputs(actor: Actor, claimId: string): Promise<ClaimItemInput[]> {
  const { data, error } = await supabaseAdmin.from('expense_claim_items').select('*').eq('claim_id', claimId);
  if (error) throw new AppError(500, error.message, 'DB');
  return ((data as any[]) ?? []).map(lineToInput);
}
