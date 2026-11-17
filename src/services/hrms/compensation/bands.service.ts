import { db, fail, fetchAll, HrmsScope, isUniqueViolation, must, scopeCols, scoped } from '../scope';
import type { Row } from '../payroll/common';
import { invalid, notFound, now } from '../payroll/common';
import { bandOut } from './mapping';
import { STANDARD_BANDS, validateBand } from './engine';

// The grade pay bands (one row per grade, unique per org). createBand / saveBand / setPublished mirror the dashboard's
// rewards/store.ts saveBand + setPublished; the dashboard edits bands that already exist, so the empty-state seeds them
// first — seedStandard posts the sample template (STANDARD_BANDS), exactly as benefits' "Add the standard plans" does.
// validateBand's words ("Enter all four amounts as positive numbers." / "...minimum below the midpoint..." / "...2.5
// times its minimum...") are reproduced here and the CHECK constraints are the backstop.

const T = 'hrms_comp_bands';

const amountCols = (b: { min: number; mid: number; max: number; market: number }): Row =>
  ({ band_min: Math.round(b.min), band_mid: Math.round(b.mid), band_max: Math.round(b.max), market: Math.round(b.market) });

export async function listBands(s: HrmsScope): Promise<Row[]> {
  return fetchAll<Row>((from, to) => scoped(db().from(T).select('*'), s).order('grade', { ascending: true }).range(from, to));
}

const findByGrade = async (s: HrmsScope, grade: string): Promise<Row | null> =>
  must(await scoped(db().from(T).select('*'), s).eq('grade', grade).maybeSingle()) as Row | null;

export async function createBand(s: HrmsScope, input: { grade: string; min: number; mid: number; max: number; market: number; published?: boolean }): Promise<Row> {
  const grade = String(input.grade).trim();
  if (!grade) throw invalid('Enter a grade for the band.');
  const err = validateBand(input);
  if (err) throw invalid(err);
  const res = await db().from(T).insert({ ...scopeCols(s), grade, ...amountCols(input), published: !!input.published }).select('*').single();
  if (res.error) {
    if (isUniqueViolation(res.error)) throw invalid(`There is already a pay band for grade ${grade}.`);
    throw fail(res.error);
  }
  return bandOut(res.data as Row);
}

export async function saveBand(s: HrmsScope, grade: string, patch: { min: number; mid: number; max: number; market: number }): Promise<Row> {
  const err = validateBand(patch);
  if (err) throw invalid(err);
  const res = await scoped(db().from(T).update({ ...amountCols(patch), updated_at: now() }), s).eq('grade', grade).select('*');
  if (res.error) throw fail(res.error);
  const rows = (res.data ?? []) as Row[];
  if (!rows.length) throw notFound('There is no pay band for that grade.');
  return bandOut(rows[0]!);
}

export async function setPublished(s: HrmsScope, grade: string, published: boolean): Promise<Row> {
  const res = await scoped(db().from(T).update({ published, updated_at: now() }), s).eq('grade', grade).select('*');
  if (res.error) throw fail(res.error);
  const rows = (res.data ?? []) as Row[];
  if (!rows.length) throw notFound('There is no pay band for that grade.');
  return bandOut(rows[0]!);
}

/** The empty-state seed: create any of the sample bands the org does not already have, then return the full list. Idempotent. */
export async function seedStandard(s: HrmsScope): Promise<{ bands: Row[]; created: number }> {
  const existing = new Set((await listBands(s)).map((b) => String(b.grade)));
  const toAdd = STANDARD_BANDS.filter((b) => !existing.has(b.grade));
  if (toAdd.length) {
    const rows = toAdd.map((b) => ({ ...scopeCols(s), grade: b.grade, ...amountCols(b), published: b.published }));
    const res = await db().from(T).insert(rows).select('id');
    if (res.error && !isUniqueViolation(res.error)) throw fail(res.error);
  }
  return { bands: (await listBands(s)).map(bandOut), created: toAdd.length };
}
