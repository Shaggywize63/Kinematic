/*
 * One-time, idempotent boot-time migration runner for the Kinematic tenant.
 *
 * Context: the usual migration path (a one-off Fargate task that psql's into
 * RDS) needs AWS API access. When that is unavailable, this runner applies the
 * pending CRM migrations from inside the already-deployed backend, using the
 * backend's own service-role client for the Kinematic project — the same
 * `exec_migration` RPC that src/scripts/run_migration.ts uses. It runs once on
 * boot, records what it applied in `schema_migrations`, and is a no-op on every
 * boot after that.
 *
 * Safety:
 *  - Only runs where the Kinematic project is actually configured (production).
 *    In dev/CI (no KINEMATIC_SUPABASE_* env) it is a silent no-op, so it never
 *    touches a database during tests.
 *  - Targets the Kinematic project EXPLICITLY. In production the default project
 *    fallback is Tata, so we must pass 'kinematic' — never rely on the fallback.
 *  - Every embedded migration is additive and idempotent (IF NOT EXISTS / OR
 *    REPLACE / DROP CONSTRAINT IF EXISTS then re-add), so re-running is safe even
 *    if the tracking read is unavailable or two tasks boot at once.
 *  - Never throws into boot: failures are logged and the server keeps running.
 *  - Set AUTO_MIGRATE=off to disable.
 *
 * Prerequisite: the Kinematic database already has the public.exec_migration
 * SECURITY DEFINER function (src/scripts/add_exec_migration.sql), which is how
 * every prior migration was applied. If it is missing, this runner logs an error
 * and applies nothing (the server is otherwise unaffected).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClientFor, isKnownProject } from './projects';
import { logger } from './logger';
import { PENDING_MIGRATIONS } from './migrations/pendingMigrations.generated';

const PROJECT = 'kinematic';

const TRACK_TABLE = `CREATE TABLE IF NOT EXISTS public.schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

async function exec(admin: SupabaseClient, sql: string): Promise<void> {
  const { error } = await admin.rpc('exec_migration', { sql_query: sql });
  if (error) throw new Error(error.message || String(error));
}

export async function runPendingMigrations(): Promise<void> {
  if ((process.env.AUTO_MIGRATE || '').toLowerCase() === 'off') {
    logger.info('[auto-migrate] skipped (AUTO_MIGRATE=off)');
    return;
  }
  // Only act where the Kinematic tenant is configured — i.e. production. This
  // keeps the runner inert in dev/CI and during the Jest suite.
  if (!isKnownProject(PROJECT)) {
    logger.info('[auto-migrate] skipped (kinematic project not configured here)');
    return;
  }

  const admin = adminClientFor(PROJECT);

  // 1) Ensure the tracking table, then reload so PostgREST can read it.
  try {
    await exec(admin, TRACK_TABLE);
    await exec(admin, "NOTIFY pgrst, 'reload schema';");
  } catch (e) {
    logger.error(`[auto-migrate] could not ensure schema_migrations; aborting: ${(e as Error)?.message ?? e}`);
    return;
  }

  // 2) Which migrations are already recorded? (Read via the PostgREST table
  //    API, which returns rows — the exec_migration RPC returns void.)
  const applied = new Set<string>();
  try {
    const { data, error } = await admin.from('schema_migrations').select('name');
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ name: string }>) applied.add(row.name);
  } catch (e) {
    // The table may not be in the PostgREST schema cache yet. The migrations are
    // idempotent, so proceed and let IF NOT EXISTS make re-application harmless.
    logger.warn(`[auto-migrate] could not read schema_migrations (continuing; migrations are idempotent): ${(e as Error)?.message ?? e}`);
  }

  // 3) Apply the pending ones, in order.
  let appliedCount = 0;
  const failures: string[] = [];
  for (const m of PENDING_MIGRATIONS) {
    if (applied.has(m.name)) {
      logger.info(`[auto-migrate] already applied: ${m.name}`);
      continue;
    }
    try {
      await exec(admin, m.sql);
      // m.name is a trusted compile-time constant (no user input).
      await exec(admin, `INSERT INTO public.schema_migrations (name) VALUES ('${m.name}') ON CONFLICT (name) DO NOTHING;`);
      appliedCount++;
      logger.info(`[auto-migrate] applied: ${m.name}`);
    } catch (e) {
      failures.push(m.name);
      logger.error(`[auto-migrate] FAILED ${m.name} (continuing): ${(e as Error)?.message ?? e}`);
    }
  }

  // 4) Reload PostgREST so the new tables/columns are visible immediately.
  if (appliedCount > 0) {
    try {
      await exec(admin, "NOTIFY pgrst, 'reload schema';");
    } catch {
      /* best effort — PostgREST also reloads on its own interval */
    }
  }

  logger.info(
    `[auto-migrate] done — applied ${appliedCount}/${PENDING_MIGRATIONS.length}` +
      (failures.length ? `, failed: ${failures.join(', ')}` : ', no failures'),
  );
}
