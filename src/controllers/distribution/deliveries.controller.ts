import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest, notFound, conflict, isDemo } from '../../utils';
import { audit } from '../../utils/audit';
import { isOurUploadUrl } from '../../utils/upload-signer';

const podSchema = z.object({
  invoice_id: z.string().uuid(),
  pod_image_url: z.string().url(),
  received_signature_url: z.string().url().optional(),
  received_by_name: z.string().optional(),
  gps: z.object({ lat: z.number(), lng: z.number() }).optional(),
  notes: z.string().optional(),
});

export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = podSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) return created(res, { id: 'demo-delivery', invoice_id: parsed.data.invoice_id });

  // POD URL must come from our signed-upload flow (anti-tamper).
  if (!isOurUploadUrl(parsed.data.pod_image_url, user.org_id, 'pod')) {
    return badRequest(res, 'pod_image_url must be a signed-upload URL we issued');
  }
  if (parsed.data.received_signature_url && !isOurUploadUrl(parsed.data.received_signature_url, user.org_id, 'signature')) {
    return badRequest(res, 'received_signature_url must be a signed-upload URL we issued');
  }

  const { data: invoice } = await supabaseAdmin.from('invoices')
    .select('*').eq('id', parsed.data.invoice_id).eq('org_id', user.org_id).maybeSingle();
  if (!invoice) return notFound(res, 'Invoice not found');
  if (invoice.status === 'cancelled') return conflict(res, 'Invoice is cancelled');

  const { data, error } = await supabaseAdmin.from('deliveries').insert({
    org_id: user.org_id,
    invoice_id: parsed.data.invoice_id,
    pod_image_url: parsed.data.pod_image_url,
    received_signature_url: parsed.data.received_signature_url ?? null,
    received_by_name: parsed.data.received_by_name ?? null,
    gps_lat: parsed.data.gps?.lat ?? null,
    gps_lng: parsed.data.gps?.lng ?? null,
    notes: parsed.data.notes ?? null,
    delivered_by_user_id: user.id,
  }).select().single();
  if (error) {
    if (error.code === '23505') return conflict(res, 'Delivery already recorded for this invoice');
    return badRequest(res, error.message);
  }
  await audit(req, 'delivery.create', 'deliveries', data.id, null, data);
  created(res, data, 'Delivery recorded');
});
