/* eslint-disable no-console */
/**
 * PASA client onboarding — Tata (`default`) project.
 *
 * Runs as a ONE-OFF ECS task using the backend image, so it inherits the
 * backend's own service-role connection to the Tata Supabase project
 * (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — the tenant where SRS and BMW
 * Ventures already live. Nothing here runs inside the web server.
 *
 * Modes (argv):
 *   --inspect  (default) READ-ONLY. Dumps the Tata org model + SRS/BMW config
 *              so we can plan the write faithfully. Writes NOTHING.
 *   --dry-run  Prints the exact create plan (client, users, cities) — no writes.
 *   --commit   Performs the idempotent writes.
 *
 * Onboarding decisions (from the operator):
 *   • Both rosters: 25 sales users (BM/SM/ASO/CSE) + 15 Consumer Champions.
 *   • Every user gets a login; one shared temp password.
 *   • Krishna Kachhap (no email) is SKIPPED. Kishan Prasad (no location) is
 *     created but left unscoped pending a base location.
 *   • Designations: BM→Business Manager, SM→Sales Manager, ASO→Area Sales
 *     Officer, CSE→Consumer Sales Executive, CC→Consumer Champion.
 *   • Steel-dealer code behaviours: match SRS (handled by a separate code PR,
 *     not this data script).
 */
import 'dotenv/config';
import { adminClientFor, DEFAULT_PROJECT } from '../lib/projects';

const MODE: 'inspect' | 'dry-run' | 'commit' =
  process.argv.includes('--commit') ? 'commit'
  : process.argv.includes('--dry-run') ? 'dry-run'
  : 'inspect';

// The Tata project's service-role client (bypasses RLS).
const db = adminClientFor(DEFAULT_PROJECT);

/** Run a labelled section, capturing any error instead of aborting the report. */
async function section<T>(label: string, fn: () => Promise<T>): Promise<T | { __error: string }> {
  try { return await fn(); }
  catch (e: any) { return { __error: String(e?.message || e) }; }
}

async function countOf(table: string, col: string, val: string): Promise<number | null> {
  const { count } = await db.from(table).select('*', { count: 'exact', head: true }).eq(col, val);
  return count ?? null;
}

async function inspect() {
  const report: Record<string, unknown> = {
    project: DEFAULT_PROJECT,
    node_env: process.env.NODE_ENV,
    single_org_projects_env: process.env.SINGLE_ORG_PROJECTS ?? '(unset → org-per-client for ALL projects)',
    generated_at: new Date().toISOString(),
  };

  // ── Clients ────────────────────────────────────────────────────────────
  const clients = await section('clients', async () => {
    const { data, error } = await db
      .from('clients')
      .select('id,name,org_id,owner_org_id,is_active,data_project_key,data_client_id,created_at');
    if (error) throw error;
    return data || [];
  });
  report.all_clients = clients;

  const list = Array.isArray(clients) ? clients as any[] : [];
  const byName = (needle: string) => list.filter(c => String(c.name || '').toLowerCase().includes(needle));
  const srsMatches = byName('srs');
  const bmwMatches = byName('bmw');
  const pasaMatches = byName('pasa');
  report.srs_candidates = srsMatches;
  report.bmw_candidates = bmwMatches;
  report.pasa_existing = pasaMatches;

  const srs = srsMatches[0];
  const bmw = bmwMatches[0];
  const srsOrg: string | undefined = srs?.org_id;
  report.srs_org_id = srsOrg ?? null;
  report.model_shared_org_srs_bmw = (srs && bmw) ? (srs.org_id === bmw.org_id) : null;

  // ── Organisations ──────────────────────────────────────────────────────
  report.organisations = await section('organisations', async () => {
    const { data } = await db.from('organisations').select('id,name,slug');
    return data || [];
  });

  if (srsOrg) {
    // ── Designations (org_roles) ─────────────────────────────────────────
    report.org_roles = await section('org_roles', async () => {
      const { data } = await db.from('org_roles')
        .select('id,name,parent_id,data_scope,position,assigned_cities,permissions,permissions_write,deleted_at,color,description')
        .eq('org_id', srsOrg);
      return (data || []).map((r: any) => ({
        id: r.id, name: r.name, data_scope: r.data_scope, parent_id: r.parent_id,
        position: r.position, color: r.color, description: r.description,
        assigned_cities_count: Array.isArray(r.assigned_cities) ? r.assigned_cities.length : 0,
        assigned_cities_sample: Array.isArray(r.assigned_cities) ? r.assigned_cities.slice(0, 6) : r.assigned_cities,
        permissions: r.permissions, permissions_write: r.permissions_write,
        deleted: !!r.deleted_at,
      }));
    });

    // ── Config table counts (org-scoped ⇒ shared across the org's clients) ─
    report.config_counts = await section('config_counts', async () => ({
      crm_products: await countOf('crm_products', 'org_id', srsOrg),
      crm_product_categories: await countOf('crm_product_categories', 'org_id', srsOrg).catch(() => 'n/a'),
      crm_pipelines: await countOf('crm_pipelines', 'org_id', srsOrg),
      crm_deal_stages: await countOf('crm_deal_stages', 'org_id', srsOrg),
      crm_custom_field_defs: await countOf('crm_custom_field_defs', 'org_id', srsOrg),
      crm_lead_sources: await countOf('crm_lead_sources', 'org_id', srsOrg),
      crm_activity_subjects: await countOf('crm_activity_subjects', 'org_id', srsOrg),
      crm_cities: await countOf('crm_cities', 'org_id', srsOrg),
      crm_states: await countOf('crm_states', 'org_id', srsOrg),
      cities_ffm: await countOf('cities', 'org_id', srsOrg).catch(() => 'n/a'),
    }));

    // ── crm_settings (lead-form field visibility lives in config jsonb) ────
    report.crm_settings = await section('crm_settings', async () => {
      const { data } = await db.from('crm_settings').select('business_type,config').eq('org_id', srsOrg).maybeSingle();
      return { business_type: data?.business_type, config_keys: data?.config ? Object.keys(data.config as object) : [] };
    });

    // ── Lead-form field defs (org-scoped; are any client-scoped?) ──────────
    report.custom_field_defs = await section('custom_field_defs', async () => {
      const { data } = await db.from('crm_custom_field_defs')
        .select('entity,field_key,label,field_type,required,position,client_id')
        .eq('org_id', srsOrg).order('entity').order('position');
      return data || [];
    });

    // ── Activity subjects (org+client scoped per the guide) ────────────────
    report.activity_subjects = await section('activity_subjects', async () => {
      const { data } = await db.from('crm_activity_subjects')
        .select('id,name,client_id,is_active').eq('org_id', srsOrg).limit(100);
      return data || [];
    });

    // ── FFM cities shape for this org (used by user_city_assignments) ──────
    report.ffm_cities_sample = await section('ffm_cities', async () => {
      const { data } = await db.from('cities').select('id,name,state,client_id,org_id').eq('org_id', srsOrg).limit(30);
      return data || [];
    });
    report.crm_cities_sample = await section('crm_cities', async () => {
      const { data } = await db.from('crm_cities').select('id,name,state_id,client_id').eq('org_id', srsOrg).limit(30);
      return data || [];
    });
  }

  // ── SRS client detail: modules + users + how a user is city-scoped ───────
  if (srs) {
    report.srs_client_modules = await section('srs_client_modules', async () => {
      const { data } = await db.from('client_modules').select('module_id,enabled,source').eq('client_id', srs.id);
      return (data || []);
    });
    report.srs_users = await section('srs_users', async () => {
      const { data } = await db.from('users')
        .select('id,name,email,mobile,role,org_role_id,client_id,city,is_active')
        .eq('client_id', srs.id).limit(25);
      const count = (await db.from('users').select('*', { count: 'exact', head: true }).eq('client_id', srs.id)).count;
      // City-scope of the first user, to learn the assignment shape.
      let sample_city_assignments: unknown = null;
      if (data && data[0]) {
        const { data: uca } = await db.from('user_city_assignments').select('city_id,org_id').eq('user_id', data[0].id);
        sample_city_assignments = uca;
      }
      return { count, sample: data || [], sample_city_assignments };
    });
  }

  console.log('PASA_INSPECT_REPORT_BEGIN');
  console.log(JSON.stringify(report, null, 2));
  console.log('PASA_INSPECT_REPORT_END');
}

async function main() {
  console.log(`[onboard-pasa] mode=${MODE} project=${DEFAULT_PROJECT} node_env=${process.env.NODE_ENV}`);
  if (MODE === 'inspect') {
    await inspect();
    return;
  }
  // dry-run / commit are implemented after the inspection is reviewed.
  console.log(`[onboard-pasa] mode ${MODE} not yet implemented — run --inspect first.`);
  process.exit(2);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[onboard-pasa] FAILED:', e?.stack || e);
  process.exit(1);
});
