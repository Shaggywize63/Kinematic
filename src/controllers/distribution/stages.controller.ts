// ═══════════════════════════════════════════════════════════
// src/controllers/distribution/stages.controller.ts
//
// Configurable route-to-market stages (Network Setup). An org defines its own
// chain — Brand → Distributor → Retailer → Consumer by default, but stages can
// be inserted/removed/reordered (super-stockist, wholesaler, fabricator, …) so
// the module is generic, not FMCG-only. Stored in distribution_stages, ordered
// by `position`. GET returns the org's stages, or the sensible default set when
// none are configured yet (so the Control Tower spine always renders).
// ═══════════════════════════════════════════════════════════
import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, isDemo } from '../../utils';

export interface Stage { key: string; label: string; entity?: string | null; icon?: string | null; optional?: boolean; }

export const DEFAULT_STAGES: Stage[] = [
  { key: 'brand',       label: 'Brand',         entity: 'brand',       icon: '🏭', optional: false },
  { key: 'distributor', label: 'Distributor',   entity: 'distributor', icon: '🏢', optional: false },
  { key: 'retailer',    label: 'Retailer',      entity: 'outlet',      icon: '🏪', optional: false },
  { key: 'consumer',    label: 'End customer',  entity: 'consumer',    icon: '🧑', optional: false },
];

const slug = (s: string) => (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

/** GET /api/v1/distribution/stages → { stages, is_default } */
export const getStages = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { stages: DEFAULT_STAGES, is_default: true });

  const { data, error } = await supabaseAdmin
    .from('distribution_stages')
    .select('key, label, entity, icon, optional, position')
    .eq('org_id', org_id)
    .order('position', { ascending: true });
  if (error) return badRequest(res, error.message);

  const rows = (data as any[]) || [];
  if (!rows.length) return ok(res, { stages: DEFAULT_STAGES, is_default: true });
  return ok(res, {
    stages: rows.map((r) => ({ key: r.key, label: r.label, entity: r.entity, icon: r.icon, optional: !!r.optional })),
    is_default: false,
  });
});

/**
 * POST /api/v1/distribution/stages  { stages: Stage[] }
 * Replace-all: validates the ordered list, then rewrites the org's stages.
 */
export const saveStages = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  if (isDemo(req.user)) return ok(res, { stages: DEFAULT_STAGES, is_default: true });

  const input = Array.isArray(req.body?.stages) ? req.body.stages : null;
  if (!input || input.length < 2) return badRequest(res, 'At least two stages (a source and an end customer) are required.');
  if (input.length > 8) return badRequest(res, 'A route to market can have at most 8 stages.');

  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < input.length; i++) {
    const s = input[i] as any;
    const label = String(s?.label || '').trim();
    if (!label) return badRequest(res, 'Every stage needs a label.');
    const key = slug(s?.key || label) || `stage_${i + 1}`;
    if (seen.has(key)) return badRequest(res, `Duplicate stage "${label}". Give each stage a distinct name.`);
    seen.add(key);
    rows.push({
      org_id, position: i, key, label: label.slice(0, 60),
      entity: s?.entity ? String(s.entity).slice(0, 40) : null,
      icon: s?.icon ? String(s.icon).slice(0, 8) : null,
      optional: !!s?.optional,
      updated_at: new Date().toISOString(),
    });
  }

  // Replace-all inside the org scope.
  const del = await supabaseAdmin.from('distribution_stages').delete().eq('org_id', org_id);
  if (del.error) return badRequest(res, del.error.message);
  const ins = await supabaseAdmin.from('distribution_stages').insert(rows).select('key, label, entity, icon, optional, position').order('position');
  if (ins.error) return badRequest(res, ins.error.message);

  return ok(res, {
    stages: (ins.data as any[]).map((r) => ({ key: r.key, label: r.label, entity: r.entity, icon: r.icon, optional: !!r.optional })),
    is_default: false,
  });
});
