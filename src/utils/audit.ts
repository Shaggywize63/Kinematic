import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { logger } from '../lib/logger';

/**
 * Append an entry to the immutable audit_log. Never throws; a logging failure
 * must never break a state-change.
 *
 * Usage:
 *   await audit(req, 'order.create', 'orders', order.id, null, order);
 *   await audit(req, 'invoice.cancel', 'invoices', inv.id, before, after);
 */
export async function audit(
  req: AuthRequest,
  action: string,
  entity_table: string,
  entity_id: string | null,
  before: unknown = null,
  after: unknown = null,
  metadata: Record<string, unknown> | null = null,
): Promise<void> {
  try {
    const user = req.user;
    if (!user) return;
    await supabaseAdmin.from('audit_log').insert({
      org_id: user.org_id,
      actor_user_id: user.id,
      actor_role: user.role,
      action,
      entity_table,
      entity_id,
      before: before ?? null,
      after: after ?? null,
      metadata: metadata ?? null,
      ip_address: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
      user_agent: (req.headers['user-agent'] as string) || null,
    });
  } catch (e: any) {
    logger.warn(`[audit] failed: ${e.message}`);
  }
}
