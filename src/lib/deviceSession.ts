import { randomUUID } from 'crypto';
import { logger } from './logger';

/**
 * Single-device session rotation for the mobile apps (users.active_session_id).
 *
 * The old login code wrapped `supabaseAdmin.rpc('rotate_user_session')` in try/catch — but supabase-js
 * NEVER throws for an RPC failure, it resolves `{ error }`. So when the rotation failed (function missing
 * on a project, permission change, DB blip) login still returned a freshly minted `session_id` that was
 * never stored. The device then sent that id on every request, the middleware compared it with the stale
 * `active_session_id` still in the row, and answered 401 DEVICE_REPLACED — which both apps treat as
 * "signed in on another device" and force-logout. Logged in, then immediately kicked.
 *
 * Contract now: returns the new session id ONLY when the database actually accepted it. On failure it
 * clears the row's session (so enforcement is off for this user rather than permanently mismatched) and
 * returns null — the client then simply carries no session id, exactly like a legacy login.
 */
export type RpcCapableAdmin = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error?: { message?: string } | null }>;
  from(table: string): {
    update(values: Record<string, unknown>): { eq(col: string, val: string): PromiseLike<{ error?: { message?: string } | null }> };
  };
};

export function buildDeviceLabel(opts: { model?: string; brand?: string; os?: string; platform?: string }): string {
  const left = [opts.brand, opts.model].filter(Boolean).join(' ').trim();
  const right = opts.os ? (opts.platform === 'ios' ? `iOS ${opts.os}` : `Android ${opts.os}`) : '';
  if (left && right) return `${left} · ${right}`;
  return left || right || 'mobile device';
}

export async function rotateDeviceSession(
  admin: RpcCapableAdmin,
  userId: string,
  deviceLabel: string,
  newId: string = randomUUID(),
): Promise<string | null> {
  try {
    const { error } = await admin.rpc('rotate_user_session', {
      p_user_id: userId,
      p_new_session_id: newId,
      p_device_label: deviceLabel,
    });
    if (!error) return newId;
    logger.error(`[Auth] rotate_user_session failed for ${userId}: ${error.message || 'unknown error'}`);
  } catch (e) {
    logger.error(`[Auth] rotate_user_session threw for ${userId}: ${(e as Error)?.message || e}`);
  }
  // Fail open: do not leave a stale id in the row that the new device can never match.
  try {
    await admin.from('users').update({ active_session_id: null, active_session_device: null }).eq('id', userId);
  } catch { /* best effort */ }
  return null;
}
