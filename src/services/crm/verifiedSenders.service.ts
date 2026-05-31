/**
 * Per-tenant verified sender addresses for outbound email. Only verified
 * rows feed the From-dropdown on the alert composer; verification is a
 * token sent to the address that the recipient clicks to confirm.
 *
 * Verification flow:
 *   1. add(email, display_name) inserts a row with a fresh token, verified_at=null
 *   2. We email the address: "click here to verify" — link points at
 *      /api/v1/crm/verified-senders/verify/:token
 *   3. verify(token) flips verified_at to now() and clears the token
 */
import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { sendEmail } from './emails.service';

export interface VerifiedSender {
  id: string;
  email: string;
  display_name: string | null;
  verified_at: string | null;
  is_default: boolean;
  created_at: string;
}

export async function listSenders(org_id: string, verifiedOnly = false): Promise<VerifiedSender[]> {
  let q = supabaseAdmin
    .from('crm_verified_senders')
    .select('id, email, display_name, verified_at, is_default, created_at')
    .eq('org_id', org_id)
    .order('created_at', { ascending: false });
  if (verifiedOnly) q = q.not('verified_at', 'is', null);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data ?? []) as VerifiedSender[];
}

export async function addSender(
  org_id: string,
  client_id: string | null,
  created_by: string | null,
  email: string,
  display_name?: string | null,
): Promise<VerifiedSender> {
  const clean = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new AppError(400, 'Invalid email address', 'VALIDATION');
  }
  // Idempotent: if a row already exists, re-issue a fresh token instead
  // of erroring on the unique constraint. That way "re-send verification"
  // is just calling add() again.
  const token = crypto.randomBytes(24).toString('hex');
  const { data, error } = await supabaseAdmin
    .from('crm_verified_senders')
    .upsert(
      {
        org_id, client_id, email: clean, display_name: display_name ?? null,
        verification_token: token, verified_at: null, created_by,
      },
      { onConflict: 'org_id,email' },
    )
    .select('id, email, display_name, verified_at, is_default, created_at')
    .single();
  if (error || !data) throw new AppError(500, error?.message || 'Insert failed', 'DB_ERROR');

  // Fire the verification email. Failures bubble — the rep needs to know
  // the token never reached the address.
  await dispatchVerificationEmail(org_id, created_by, clean, token);

  return data as VerifiedSender;
}

export async function verifyToken(token: string): Promise<VerifiedSender | null> {
  if (!token || token.length < 16) return null;
  const { data, error } = await supabaseAdmin
    .from('crm_verified_senders')
    .update({ verified_at: new Date().toISOString(), verification_token: null })
    .eq('verification_token', token)
    .select('id, email, display_name, verified_at, is_default, created_at')
    .maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return (data as VerifiedSender) ?? null;
}

export async function deleteSender(org_id: string, id: string): Promise<void> {
  await supabaseAdmin.from('crm_verified_senders').delete().eq('org_id', org_id).eq('id', id);
}

export async function setDefault(org_id: string, id: string): Promise<void> {
  // Only one default per org — clear the rest first.
  await supabaseAdmin.from('crm_verified_senders').update({ is_default: false }).eq('org_id', org_id);
  await supabaseAdmin.from('crm_verified_senders').update({ is_default: true }).eq('org_id', org_id).eq('id', id);
}

async function dispatchVerificationEmail(
  org_id: string,
  user_id: string | null,
  to: string,
  token: string,
): Promise<void> {
  const base = process.env.DASHBOARD_URL || 'https://app.kinematicapp.com';
  const link = `${base.replace(/\/+$/, '')}/dashboard/crm/email-senders?verify=${encodeURIComponent(token)}`;
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;line-height:1.5;color:#111">
      <h2 style="margin:0 0 12px">Verify your sender address</h2>
      <p>Click below to confirm that this address can send email from Kinematic.</p>
      <p><a href="${link}" style="background:#E01E2C;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Verify address</a></p>
      <p style="font-size:12px;color:#666">If you didn't request this, ignore this email.</p>
    </div>`;
  await sendEmail({
    org_id, user_id: user_id ?? undefined,
    to, subject: 'Verify your Kinematic sender address',
    body_html: html,
  });
}
