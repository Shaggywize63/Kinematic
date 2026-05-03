import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { asyncHandler, ok, badRequest, notFound, isDemo } from '../utils';
import { audit } from '../utils/audit';

// GET /api/v1/organisations/me — current user's org
export const me = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) {
    return ok(res, {
      id: '00000000-0000-0000-0000-000000000000',
      name: 'Kinematic Demo Org',
      slug: 'demo',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'IN',
      logo_url: null,
      settings: { support_email: 's@kinematicapp.com' },
      is_active: true,
    });
  }
  const { data, error } = await supabaseAdmin
    .from('organisations').select('*').eq('id', user.org_id).maybeSingle();
  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Organisation not found');
  ok(res, data);
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  logo_url: z.string().url().optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  state: z.string().max(120).optional().nullable(),
  country: z.string().max(60).optional().nullable(),
  support_email: z.string().email().optional(),
  // Free-form merge into settings jsonb. Caller can also patch top-level fields.
  settings_patch: z.record(z.any()).optional(),
});

// PATCH /api/v1/organisations/me — admin-only top-level + settings merge
export const update = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: 'demo', ...req.body });
  if (!['super_admin', 'admin'].includes(String(user.role))) {
    return badRequest(res, 'Only admins can update organisation details');
  }

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);

  const { data: before } = await supabaseAdmin
    .from('organisations').select('*').eq('id', user.org_id).maybeSingle();
  if (!before) return notFound(res, 'Organisation not found');

  const top: Record<string, unknown> = {};
  for (const k of ['name', 'logo_url', 'address', 'city', 'state', 'country'] as const) {
    if (parsed.data[k] !== undefined) top[k] = parsed.data[k];
  }

  // Merge: existing settings + explicit settings_patch + the convenience support_email field.
  const settings = {
    ...(before.settings || {}),
    ...(parsed.data.settings_patch || {}),
    ...(parsed.data.support_email !== undefined ? { support_email: parsed.data.support_email } : {}),
  };

  const { data: after, error } = await supabaseAdmin
    .from('organisations')
    .update({ ...top, settings, updated_at: new Date().toISOString() })
    .eq('id', user.org_id)
    .select().single();
  if (error) return badRequest(res, error.message);

  await audit(req, 'organisation.update', 'organisations', after.id, before, after);
  ok(res, after, 'Organisation updated');
});
