/**
 * Self-service password reset.
 *
 * Backed by Supabase Auth's recovery token store — no custom table. We
 * call admin.generateLink({type:'recovery'}) to mint a one-time token,
 * compose a branded HTML body that references our own dashboard URL +
 * the kinematic:// deep-link, and deliver via the existing sendEmail()
 * abstraction (so password-reset rows show up alongside every other
 * outbound email in the dashboard's logs view).
 *
 * Anti-enumeration: requestReset NEVER throws on an unknown email —
 * the caller's controller always responds 200 OK. This means a curl
 * loop that walks a wordlist can't tell which addresses are real.
 *
 * The mailbox is locked to `noreply@kinematicapp.com` regardless of
 * CRM_FROM_EMAIL, because a password-reset email should never look
 * like it came from a person — replies are pointless and we want the
 * recipient to ignore them.
 */
import { supabase, supabaseAdmin } from '../../lib/supabase';
import { sendEmail } from '../crm/emails.service';
import { logger } from '../../lib/logger';

// Visible sender for every password-reset email. Defaults to the
// already-Resend-verified `mail.kinematicapp.com` subdomain (SPF + DKIM
// + DMARC live). Override with PASSWORD_RESET_FROM_EMAIL once the
// apex `kinematicapp.com` is also verified in Resend
// (https://resend.com/domains) — flipping the sender is then a
// no-deploy env change. Previously hard-coded to `noreply@kinematicapp.com`
// (the apex, not the verified subdomain), which Resend was 403-rejecting
// with "domain is not verified" so no reset email ever left the queue.
const FROM_EMAIL = process.env.PASSWORD_RESET_FROM_EMAIL || 'noreply@mail.kinematicapp.com';

/**
 * Where the reset link points the user. The token + email both ride
 * on the query string of /auth/reset-password. The DASHBOARD_URL env
 * var should be `https://dashboard.kinematicapp.com` in prod and the
 * preview URL in dev; falls back to a sensible default so a misconfig
 * doesn't strand the link.
 */
function buildWebLink(token: string, email: string): string {
  const base = (process.env.DASHBOARD_URL || 'https://dashboard.kinematicapp.com').replace(/\/$/, '');
  const t = encodeURIComponent(token);
  const e = encodeURIComponent(email);
  return `${base}/auth/reset-password?token=${t}&email=${e}`;
}

/**
 * Custom URL scheme so the same email body opens the iOS / Android app
 * directly when the user taps the link on their phone. Falls through
 * to the web link above on devices without the app installed.
 */
function buildAppLink(token: string, email: string): string {
  const t = encodeURIComponent(token);
  const e = encodeURIComponent(email);
  return `kinematic://reset-password?token=${t}&email=${e}`;
}

/**
 * Compose the branded reset email. Manrope-ish display + Inter body —
 * the email client's font fallbacks deliver close-enough rendering.
 * One red CTA on a white panel matches the brand guideline's
 * "transactional" email format (plain HTML, no imagery beyond the
 * wordmark).
 */
function composeBody(webLink: string, appLink: string): { html: string; text: string } {
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F6F8FB;font-family:'Inter',-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0A0E1A">
  <div style="max-width:560px;margin:32px auto;background:#FFFFFF;border:1px solid #EEF1F5;border-radius:14px;padding:36px">
    <div style="font-family:'Manrope',sans-serif;font-weight:800;font-size:22px;letter-spacing:-0.01em;color:#0A0E1A">Kinematic</div>
    <h1 style="font-family:'Manrope',sans-serif;font-weight:700;font-size:24px;color:#0A0E1A;margin:24px 0 12px">Reset your password</h1>
    <p style="font-size:15px;line-height:1.6;color:#0A0E1A;margin:0 0 18px">
      We received a request to reset the password for this Kinematic account.
      Click the button below to set a new one. The link expires in 60 minutes
      and can be used only once.
    </p>
    <p style="margin:28px 0">
      <a href="${webLink}" style="display:inline-block;background:#D01E2C;color:#FFFFFF;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:700;font-size:15px">Reset password</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#64748B;margin:0 0 6px">
      Using the Kinematic mobile app? Open this link instead:
    </p>
    <p style="font-size:13px;line-height:1.6;color:#0066FF;word-break:break-all;margin:0 0 24px">
      <a href="${appLink}" style="color:#0066FF;text-decoration:underline">${appLink}</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#64748B;margin:0">
      Didn't request this? You can safely ignore this email — your password
      stays the same until someone uses the link above.
    </p>
  </div>
  <div style="max-width:560px;margin:0 auto 32px;padding:0 16px;font-size:11px;color:#94A3B8;text-align:center;font-family:'Inter',sans-serif">
    Kinematic, a Kaiyo Technology Labs product · ${FROM_EMAIL}
  </div>
</body></html>`;

  const text = [
    'Reset your Kinematic password',
    '',
    'We received a request to reset the password for this account. Open the',
    'link below to set a new password. The link expires in 60 minutes and',
    'can be used only once.',
    '',
    webLink,
    '',
    'On the Kinematic mobile app, open this link instead:',
    appLink,
    '',
    'Didn\'t request this? Ignore this email — your password stays the same.',
    '',
    '— Kinematic',
  ].join('\n');

  return { html, text };
}

/**
 * Caller-visible API.
 *
 * @param email  Whatever the user typed. Trimmed + lower-cased before
 *               passing to Supabase Auth.
 * @returns      Always resolves (anti-enumeration). Logs internally
 *               when the email doesn't exist or the link generator
 *               fails so we can debug from server logs.
 */
export async function requestReset(email: string): Promise<void> {
  const cleaned = email.trim().toLowerCase();
  if (!cleaned) return;

  try {
    // generateLink({type:'recovery'}) stores a recovery token on
    // auth.users + returns both the hashed link and the plaintext OTP
    // we embed in our email. Supabase returns 422 for unknown emails;
    // we swallow that to avoid leaking existence.
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: cleaned,
    });
    if (error || !data?.properties?.email_otp) {
      logger.info(`[passwordReset] recovery link not generated for ${cleaned}: ${error?.message || 'no otp'}`);
      return;
    }

    const token = data.properties.email_otp;
    const webLink = buildWebLink(token, cleaned);
    const appLink = buildAppLink(token, cleaned);
    const body = composeBody(webLink, appLink);

    // org_id is a NOT-NULL column on crm_email_logs. For a pre-login
    // password reset we don't have one; resolve the user's org_id by
    // looking it up. If the email doesn't map to a user we still want
    // to record the attempt for audit, so we fall back to the zero
    // UUID which the dashboard filters out by default.
    const { data: userRow } = await supabaseAdmin
      .from('users')
      .select('id, org_id')
      .ilike('email', cleaned)
      .maybeSingle();

    await sendEmail({
      org_id: (userRow?.org_id as string | undefined) || '00000000-0000-0000-0000-000000000000',
      user_id: userRow?.id as string | undefined,
      to: cleaned,
      from_email: FROM_EMAIL,
      subject: 'Reset your Kinematic password',
      body_html: body.html,
      body_text: body.text,
      // Transactional — recipient asked for this; bounce/unsub list
      // doesn't apply.
      bypass_suppression: true,
    });
  } catch (e) {
    // Never propagate — anti-enumeration guarantees a 200 response.
    logger.warn(`[passwordReset] requestReset failed for ${cleaned}: ${(e as Error).message}`);
  }
}

export interface VerifyAndResetResult {
  success: boolean;
  /** Supabase Auth session — present on success, used by the controller
   *  to mint the auto-login response that mirrors /auth/login. */
  session?: {
    access_token: string;
    refresh_token: string;
    expires_at: number | undefined;
    user_id: string;
    email: string;
  };
  error?: string;
}

/**
 * Verify the recovery token + update the password + sign the user in
 * with the NEW password (so we return a session the client can save
 * immediately, no separate /auth/login round-trip required).
 *
 * Caller's controller wraps this in a standard error shape — we just
 * surface a boolean + a short reason so the caller can decide between
 * 400 (bad token) and 500 (unexpected provider failure).
 */
export async function verifyAndReset(
  email: string,
  token: string,
  newPassword: string,
): Promise<VerifyAndResetResult> {
  const cleanedEmail = email.trim().toLowerCase();
  const cleanedToken = token.trim();
  if (!cleanedEmail || !cleanedToken) {
    return { success: false, error: 'Missing email or token' };
  }
  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  // Step 1 — verify the recovery OTP. This both validates the token
  // and consumes it (subsequent calls with the same token 400 out).
  const { data: verify, error: verifyErr } = await supabase.auth.verifyOtp({
    email: cleanedEmail,
    token: cleanedToken,
    type: 'recovery',
  });
  if (verifyErr || !verify?.user) {
    return { success: false, error: 'Reset link is invalid or has expired. Request a new one.' };
  }

  // Step 2 — set the new password via admin API. The verifyOtp above
  // already authenticated us, but admin.updateUserById doesn't need a
  // user JWT, just the service role.
  const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(verify.user.id, {
    password: newPassword,
  });
  if (updErr) {
    return { success: false, error: updErr.message || 'Could not update password' };
  }

  // Step 3 — sign in with the new password to mint a fresh session.
  // We could reuse the session returned by verifyOtp, but a clean
  // signInWithPassword guarantees the session has the latest
  // password-set timestamp + expected expiry.
  const { data: session, error: signInErr } = await supabase.auth.signInWithPassword({
    email: cleanedEmail,
    password: newPassword,
  });
  if (signInErr || !session?.session) {
    return { success: false, error: 'Password updated, but auto-login failed. Sign in manually.' };
  }

  return {
    success: true,
    session: {
      access_token: session.session.access_token,
      refresh_token: session.session.refresh_token,
      expires_at: session.session.expires_at,
      user_id: session.user.id,
      email: cleanedEmail,
    },
  };
}
