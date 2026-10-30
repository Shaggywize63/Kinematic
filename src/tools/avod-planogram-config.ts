/* eslint-disable no-console */
/**
 * AVOD (Bahwancy) — Cooking-Oils planogram brand config (Rack 4).
 *
 * Sets the retail-execution brand config the planogram engine reads to compute
 * share-of-shelf and own-vs-competitor metrics for AVOD's "Store audit":
 *   - layout.own_brands  — AVOD's own cooking-oil brands. Any shelf pack of one
 *     of these counts as an OWN facing even when its exact variant is not in
 *     expected_skus (planogram.service: "uncataloged own-brand packs are
 *     identified, not dropped"), so shelf_share_own is reliable from day one.
 *   - layout.competitors — the rival SKUs seen on the AVOD oils bay (Savola's
 *     Mazola / Afia, Dalia's, Sun Vita …), so competitor detection matches an
 *     explicit list instead of being inferred.
 *   - layout.brand_terms — English/Arabic spelling synonyms so bilingual shelf
 *     labels still match the right brand.
 *
 * It NEVER writes expected_skus / expected_posm: those come from the AI parse
 * step on the Rack-4 PDF (POST /api/v1/planograms/parse → PATCH), and this tool
 * merges its brand config into whatever that produced without clobbering it.
 * Compliance % and OSA need those expected_skus; share-of-shelf does not, so
 * running this first already lights up the own-vs-competitor split.
 *
 * ADOPTS an existing planogram when one is given/known (AVOD_PLANOGRAM_ID, or a
 * single oils planogram on the client), else CREATEs a 5-shelf skeleton (the
 * PDF has five shelves) with empty expected_skus for the parse step to fill.
 *
 * Runs against the **kinematic** project (service role), never Tata. Idempotent.
 * Modes (argv): --inspect (default, read-only) / --dry-run / --commit.
 * Optional env:
 *   AVOD_CLIENT_NAME       client to resolve (default "Bahwancy")
 *   AVOD_EXPECT_CLIENT_ID / AVOD_EXPECT_ORG_ID   resolve cross-checks
 *   AVOD_PLANOGRAM_ID      adopt this exact planogram id instead of resolving one
 *   AVOD_PLANOGRAM_NAME    name used when creating (default below)
 *   AVOD_STORE_FORMAT      planogram store_format / channel tag (default unset)
 *
 * Usage (backend image, one-off ECS task):
 *   node dist/tools/avod-planogram-config.js --inspect
 *   node dist/tools/avod-planogram-config.js --commit
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { adminClientFor, isKnownProject } from '../lib/projects';

const PROJECT = 'kinematic';
if (!isKnownProject(PROJECT)) {
  console.error('[avod-planogram] the "kinematic" Supabase project is not configured — refusing to run against the wrong database.');
  process.exit(1);
}
const db = adminClientFor(PROJECT);

const MODE: 'inspect' | 'dry-run' | 'commit' =
  process.argv.includes('--commit') ? 'commit'
  : process.argv.includes('--dry-run') ? 'dry-run'
  : 'inspect';
const dry = MODE !== 'commit';

const CLIENT_NAME = (process.env.AVOD_CLIENT_NAME || 'Bahwancy').trim();
const PLANOGRAM_NAME = (process.env.AVOD_PLANOGRAM_NAME || 'AVOD — Cooking Oils (Rack 4)').trim();
const STORE_FORMAT = (process.env.AVOD_STORE_FORMAT || '').trim() || null;
const CATEGORY = 'Cooking Oils';
const SHELF_COUNT = 5; // Rack 4 section PDF = 5 shelves.

// ── AVOD's own cooking-oil brands (operator-confirmed: full list) ──────────
const OWN_BRANDS = [
  'Minara', 'Areej', 'Sohar', 'Khafeef', 'Jabal Akhdar', 'Sindbad', 'Taj', 'Hafla',
];

// ── Competitor SKUs seen on the AVOD oils bay (seed; extend as needed) ──────
// Stable sku_ids so re-runs and detections keep one identity. brand feeds the
// own-vs-competitor split; category feeds per-category rollups.
const COMPETITORS: Array<{ sku_id: string; sku_name: string; brand: string; category: string }> = [
  { sku_id: 'comp-mazola-corn',   sku_name: 'Mazola Corn Oil',        brand: 'Mazola',   category: CATEGORY },
  { sku_id: 'comp-afia-corn',     sku_name: 'Afia Corn Oil',          brand: 'Afia',     category: CATEGORY },
  { sku_id: 'comp-afia-sun',      sku_name: 'Afia Sunflower Oil',     brand: 'Afia',     category: CATEGORY },
  { sku_id: 'comp-dalia-corn',    sku_name: "Dalia's Corn Oil",       brand: "Dalia's",  category: CATEGORY },
  { sku_id: 'comp-sunvita',       sku_name: 'Sun Vita Oil',           brand: 'Sun Vita', category: CATEGORY },
];

// ── Brand/variant synonyms (EN ⇄ AR) so bilingual shelf labels still match ─
const BRAND_TERMS: Record<string, string[]> = {
  // own brands
  Minara: ['المنارة', 'منارة', 'Al Minara'],
  Areej: ['عريج', 'أريج'],
  Sohar: ['صحار'],
  Khafeef: ['خفيف'],
  'Jabal Akhdar': ['الجبل الأخضر', 'Jabal Al Akhdar', 'Al Jabal Al Akhdar'],
  Sindbad: ['سندباد', 'Sinbad'],
  Taj: ['تاج'],
  Hafla: ['حفلة'],
  // competitors
  Mazola: ['مازولا'],
  Afia: ['عافية'],
};

function log(...a: unknown[]) { console.log(...a); }

const isPlainObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
type ClientRow = { id: string; org_id: string | null; name: string | null; settings: unknown };
const isSoftDeleted = (c: ClientRow) => isPlainObj(c.settings) && !!(c.settings as any).deleted_at;

/** Resolve the AVOD/Bahwancy client by name (abort on 0 or >1), with optional
 *  AVOD_EXPECT_* cross-checks. Mirrors onboard-bahwancy's resolver. */
async function resolveClient(): Promise<{ orgId: string; clientId: string; name: string }> {
  const { data, error } = await db.from('clients').select('id, org_id, name, settings').ilike('name', CLIENT_NAME);
  if (error) throw new Error(`clients lookup: ${error.message}`);
  const live = ((data as ClientRow[] | null) || []).filter((c) => !isSoftDeleted(c));
  if (live.length === 0) throw new Error(`no live client named "${CLIENT_NAME}" on the kinematic project.`);
  if (live.length > 1) {
    const lines = live.map((c) => `  - ${c.name} id=${c.id} org=${c.org_id}`).join('\n');
    throw new Error(`several live clients match "${CLIENT_NAME}" — refusing to guess:\n${lines}\nSet AVOD_EXPECT_CLIENT_ID.`);
  }
  const c = live[0];
  const expectClient = (process.env.AVOD_EXPECT_CLIENT_ID || '').trim();
  const expectOrg = (process.env.AVOD_EXPECT_ORG_ID || '').trim();
  if (expectClient && c.id !== expectClient) throw new Error(`resolved client ${c.id} != AVOD_EXPECT_CLIENT_ID ${expectClient}.`);
  if (expectOrg && c.org_id !== expectOrg) throw new Error(`resolved org ${c.org_id} != AVOD_EXPECT_ORG_ID ${expectOrg}.`);
  if (!c.org_id) throw new Error(`client ${c.id} has no org_id.`);
  return { orgId: c.org_id, clientId: c.id, name: c.name || CLIENT_NAME };
}

type PlanogramRow = {
  id: string; name: string | null; category: string | null; store_format: string | null;
  layout: unknown; expected_skus: unknown;
};

/** Find the planogram to configure: AVOD_PLANOGRAM_ID if set, else a single
 *  oils planogram on this client, else none (→ create a skeleton). */
async function resolvePlanogram(orgId: string, clientId: string): Promise<PlanogramRow | null> {
  const explicit = (process.env.AVOD_PLANOGRAM_ID || '').trim();
  if (explicit) {
    const { data, error } = await db.from('planograms').select('id, name, category, store_format, layout, expected_skus')
      .eq('id', explicit).eq('org_id', orgId).maybeSingle();
    if (error) throw new Error(`planogram ${explicit}: ${error.message}`);
    if (!data) throw new Error(`AVOD_PLANOGRAM_ID ${explicit} not found on org ${orgId}.`);
    return data as PlanogramRow;
  }
  const { data, error } = await db.from('planograms')
    .select('id, name, category, store_format, layout, expected_skus')
    .eq('org_id', orgId).eq('client_id', clientId);
  if (error) throw new Error(`planograms lookup: ${error.message}`);
  const rows = (data as PlanogramRow[] | null) || [];
  const oils = rows.filter((p) => /oil/i.test(p.name || '') || /oil/i.test(p.category || ''));
  if (oils.length === 1) return oils[0];
  if (oils.length > 1) {
    const lines = oils.map((p) => `  - ${p.name} id=${p.id}`).join('\n');
    throw new Error(`several oils planograms on this client — set AVOD_PLANOGRAM_ID:\n${lines}`);
  }
  return null; // none → create a skeleton
}

/** Merge the brand config into an existing layout, preserving every other key
 *  (expected_skus stays in its own column, untouched). */
function mergeLayout(existing: unknown): Record<string, unknown> {
  const layout: Record<string, unknown> = isPlainObj(existing) ? { ...existing } : {};
  if (!Array.isArray(layout.shelves) || layout.shelves.length === 0) {
    layout.shelves = Array.from({ length: SHELF_COUNT }, (_, i) => ({ index: i }));
  }
  layout.own_brands = OWN_BRANDS;
  layout.brand_terms = BRAND_TERMS;
  // Union competitors by sku_id so hand-added ones in the dashboard survive.
  const have = new Map<string, any>();
  if (Array.isArray(layout.competitors)) for (const c of layout.competitors as any[]) if (c?.sku_id) have.set(c.sku_id, c);
  for (const c of COMPETITORS) have.set(c.sku_id, { ...have.get(c.sku_id), ...c });
  layout.competitors = [...have.values()];
  return layout;
}

async function resolveCreatedBy(orgId: string): Promise<string | null> {
  const { data } = await db.from('users').select('id').eq('org_id', orgId).eq('is_active', true).limit(1).maybeSingle();
  return (data as any)?.id ?? null;
}

async function main() {
  log(`[avod-planogram] mode=${MODE} project=${PROJECT}`);
  const { orgId, clientId, name } = await resolveClient();
  log(`client "${name}"  org_id=${orgId}  client_id=${clientId}`);
  const existing = await resolvePlanogram(orgId, clientId);

  const expectedCount = Array.isArray((existing as any)?.expected_skus) ? (existing as any).expected_skus.length : 0;
  if (existing) {
    log(`planogram FOUND: "${existing.name}" id=${existing.id} (expected_skus=${expectedCount} — left untouched)`);
  } else {
    log(`planogram NONE on client → will CREATE skeleton "${PLANOGRAM_NAME}" (${SHELF_COUNT} shelves, expected_skus=[] for the parse step)`);
  }
  log(`own_brands (${OWN_BRANDS.length}): ${OWN_BRANDS.join(', ')}`);
  log(`competitors (${COMPETITORS.length}): ${COMPETITORS.map((c) => c.brand).join(', ')}`);
  log(`brand_terms: ${Object.keys(BRAND_TERMS).length} entries`);

  if (MODE === 'inspect') { log('\nINSPECT only — no writes. Re-run with --dry-run to preview, --commit to apply.'); return; }

  log(`\n=== AVOD oils planogram config (${dry ? 'DRY-RUN — NO WRITES' : 'COMMIT — WRITING'}) ===`);

  if (existing) {
    const layout = mergeLayout(existing.layout);
    log(`update planogram ${existing.id}: merge own_brands/competitors/brand_terms (expected_skus preserved)`);
    if (!dry) {
      const { error } = await db.from('planograms')
        .update({ layout, updated_at: new Date().toISOString() })
        .eq('id', existing.id).eq('org_id', orgId);
      if (error) throw new Error(`planogram update: ${error.message}`);
    }
    log(`\n=== ${dry ? 'DRY-RUN complete' : 'COMMIT complete'} === planogram=${existing.id}`);
  } else {
    const id = randomUUID();
    const layout = mergeLayout(null);
    const createdBy = dry ? null : await resolveCreatedBy(orgId);
    log(`create planogram ${id} "${PLANOGRAM_NAME}" category="${CATEGORY}" store_format=${STORE_FORMAT ?? '(none)'}`);
    if (!dry) {
      const { error } = await db.from('planograms').insert({
        id, org_id: orgId, client_id: clientId, name: PLANOGRAM_NAME, category: CATEGORY,
        store_format: STORE_FORMAT, layout, expected_skus: [], expected_posm: [], created_by: createdBy,
      });
      if (error) throw new Error(`planogram insert: ${error.message}`);
    }
    log(`\n=== ${dry ? 'DRY-RUN complete' : 'COMMIT complete'} === planogram=${id}`);
    log('Next: run the AI parse on the Rack-4 PDF (POST /api/v1/planograms/parse) and PATCH the result into expected_skus to light up compliance % + OSA. Share-of-shelf already works from own_brands.');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[avod-planogram] FAILED:', e?.message || e); process.exit(1); });
