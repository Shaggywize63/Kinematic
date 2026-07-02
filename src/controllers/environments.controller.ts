import { Response } from 'express';
import { AuthRequest } from '../types';
import { asyncHandler, ok, badRequest, isUUID } from '../utils';
import { adminClientFor, knownProjectKeys } from '../lib/projects';
import { logger } from '../lib/logger';

/**
 * GET /api/v1/environments
 * Super-admin: list every staging org and its production promotion target,
 * across ALL configured projects (uses a per-project admin client, so a
 * Kinematic session can see/manage the Tata project's pairs too).
 */
export const listEnvironments = asyncHandler(async (_req: AuthRequest, res: Response) => {
  const pairs: Array<{
    project: string; staging_org_id: string; staging_name: string;
    prod_org_id: string | null; prod_name: string | null;
  }> = [];

  for (const project of knownProjectKeys()) {
    try {
      const remote = adminClientFor(project);
      const { data: stagings } = await remote
        .from('organisations')
        .select('id, name, environment, promotes_to')
        .eq('environment', 'staging');
      for (const s of stagings || []) {
        let prodName: string | null = null;
        if (s.promotes_to) {
          const { data: p } = await remote.from('organisations').select('name').eq('id', s.promotes_to).maybeSingle();
          prodName = p?.name ?? null;
        }
        pairs.push({
          project,
          staging_org_id: s.id,
          staging_name: s.name,
          prod_org_id: s.promotes_to ?? null,
          prod_name: prodName,
        });
      }
    } catch (e: any) {
      logger.warn(`[Env] list failed for project '${project}': ${e?.message || e}`);
    }
  }

  ok(res, pairs);
});

/**
 * POST /api/v1/environments/promote  { project, staging_org_id, dry_run }
 * Super-admin: promote the config (settings / field overrides) from a staging
 * org into its linked production org, within the given project. dry_run=true
 * (default) reports what WOULD change without writing.
 */
export const promoteEnvironment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { project, staging_org_id, dry_run } = req.body || {};
  if (!project || !knownProjectKeys().includes(project)) { badRequest(res, 'Unknown or missing project'); return; }
  if (!isUUID(staging_org_id)) { badRequest(res, 'Invalid staging_org_id'); return; }

  const remote = adminClientFor(project);
  const { data: s, error } = await remote
    .from('organisations')
    .select('id, environment, promotes_to, name')
    .eq('id', staging_org_id)
    .single();
  if (error || !s) { badRequest(res, 'Staging org not found'); return; }
  if (s.environment !== 'staging' || !s.promotes_to) {
    badRequest(res, 'This org is not a staging org with a production target');
    return;
  }

  const isDry = dry_run !== false; // default to a safe dry-run
  const { data, error: rpcErr } = await remote.rpc('promote_org_config', {
    p_src: staging_org_id,
    p_dst: s.promotes_to,
    p_dry_run: isDry,
  });
  if (rpcErr) { badRequest(res, `Promotion failed: ${rpcErr.message}`); return; }

  logger.info(`[Env] promote ${project} ${staging_org_id} -> ${s.promotes_to} (dry_run=${isDry})`);
  ok(res, { project, staging_org_id, prod_org_id: s.promotes_to, dry_run: isDry, result: data });
});
