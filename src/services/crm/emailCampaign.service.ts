/**
 * Email Campaigns — bulk email to CRM leads/contacts. The email sibling of the
 * WhatsApp broadcast engine (broadcast.service.ts).
 *
 * Flow: segment leads (has email, optional consent / status / source / city /
 * tags filters) → snapshot a saved crm_email_templates body → insert one
 * recipient row per person → a paced scheduler advances one batch/minute,
 * calling the shared sendEmail() for each. sendEmail() already carries
 * suppression (bounce + unsubscribe), the open pixel, click rewriting, and the
 * RFC-8058 one-click List-Unsubscribe header — we thread a `campaign_id` so all
 * of that engagement rolls up to per-campaign analytics via crm_email_logs.
 *
 * Pacing is scheduler-driven (server.ts calls processDueEmailCampaignsAllProjects
 * every ~60s): each tick sends up to `throttle_per_min` for every in-flight
 * campaign. Launch kicks an immediate first batch so the user sees instant
 * progress. Batch claiming is a compare-and-swap on recipient.status so the
 * launch call and a scheduler tick never double-send the same row.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';
import { logger } from '../../lib/logger';
import { knownProjectKeys, runWithProject } from '../../lib/projects';
import { sendEmail, renderTemplate, htmlToPlainText } from './emails.service';

const CAMPAIGNS = 'crm_email_campaigns';
const RECIPIENTS = 'crm_email_campaign_recipients';
const TEMPLATES = 'crm_email_templates';
const LOGS = 'crm_email_logs';
const UNSUBS = 'crm_email_unsubscribes';
const LEADS = 'crm_leads';

const MAX_AUDIENCE = 50_000;
const DEFAULT_THROTTLE = 60;          // emails per minute (per campaign)
const MAX_THROTTLE = 500;
const SEND_CONCURRENCY = 5;           // parallel provider calls within a batch
const INSERT_CHUNK = 500;
const BATCH_IDLE_MS = 55 * 1000;      // a campaign is "due" ~1 batch/minute

export interface Scope { orgId: string; clientId: string | null; userId?: string | null; }

// Audience filter persisted on the campaign (jsonb). All keys optional; an empty
// filter = "every lead in scope that has an email".
export interface AudienceFilter {
  lead_ids?: string[];          // explicit selection — overrides the filters below
  marketing_consent?: boolean;  // require marketing_consent = true
  status?: string[];            // lead.status in
  source_ids?: string[];        // lead.source_id in
  city?: string[];              // lead.city in
  state?: string[];             // lead.state in
  tags?: string[];              // lead.tags overlaps
  is_b2c?: boolean;             // lead.is_b2c eq
}

export interface AudienceRecipient {
  lead_id: string | null;
  email: string;
  first_name: string | null;
  vars: Record<string, string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clampThrottle = (n: unknown) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_THROTTLE;
  return Math.min(Math.max(v, 1), MAX_THROTTLE);
};
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

// ── Audience resolution ──────────────────────────────────────────────────────

/** Resolve a lead audience into de-duped, suppression-filtered email recipients. */
export async function resolveAudience(
  scope: Scope,
  filter: AudienceFilter,
  limitN = MAX_AUDIENCE,
): Promise<{ recipients: AudienceRecipient[]; skipped: { no_email: number; duplicate: number; suppressed: number }; total_candidates: number }> {
  let q = supabaseAdmin
    .from(LEADS)
    .select('id, email, first_name, last_name, client_id')
    .eq('org_id', scope.orgId)
    .is('deleted_at', null)
    .not('email', 'is', null)
    .limit(limitN);

  // Leads are tenant-isolated — scope to the current client when one is set.
  if (scope.clientId) q = q.eq('client_id', scope.clientId);

  const ids = (filter.lead_ids || []).filter((x) => UUID_RE.test(String(x)));
  if (ids.length) {
    q = q.in('id', ids.slice(0, limitN));
  } else {
    if (filter.marketing_consent === true) q = q.eq('marketing_consent', true);
    if (typeof filter.is_b2c === 'boolean') q = q.eq('is_b2c', filter.is_b2c);
    if (filter.status?.length) q = q.in('status', filter.status);
    if (filter.source_ids?.length) q = q.in('source_id', filter.source_ids.filter((x) => UUID_RE.test(String(x))));
    if (filter.city?.length) q = q.in('city', filter.city);
    if (filter.state?.length) q = q.in('state', filter.state);
    if (filter.tags?.length) q = q.overlaps('tags', filter.tags);
  }

  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  const rows = (data || []) as Array<{ id: string; email: string | null; first_name: string | null; last_name: string | null }>;

  const suppressed = await suppressionSet(scope.orgId);
  const seen = new Set<string>();
  const recipients: AudienceRecipient[] = [];
  const skipped = { no_email: 0, duplicate: 0, suppressed: 0 };

  for (const r of rows) {
    const email = norm(r.email);
    if (!email || !email.includes('@')) { skipped.no_email++; continue; }
    if (seen.has(email)) { skipped.duplicate++; continue; }
    seen.add(email);
    if (suppressed.has(email)) { skipped.suppressed++; continue; }
    recipients.push({
      lead_id: r.id,
      email,
      first_name: r.first_name ?? null,
      vars: {
        // Graceful fallback so a "Hi {{first_name}}," greeting never renders as
        // "Hi ," for a contact with no name. The display column above keeps the
        // true value (null) for the recipients table / CSV; only the render var
        // gets the friendly default.
        first_name: (r.first_name && r.first_name.trim()) || 'there',
        last_name: (r.last_name && r.last_name.trim()) || '',
        email,
      },
    });
  }
  return { recipients, skipped, total_candidates: rows.length };
}

/** Lowercased set of unsubscribed + hard-bounced emails for this org. */
export async function suppressionSet(orgId: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const { data: unsubs } = await supabaseAdmin.from(UNSUBS).select('email').eq('org_id', orgId);
    for (const u of (unsubs || []) as { email: string }[]) set.add(norm(u.email));
  } catch (e) { logger.warn(`[email-campaign] unsub load failed: ${(e as Error).message}`); }
  try {
    const { data: bounces } = await supabaseAdmin.from(LOGS)
      .select('to_email').eq('org_id', orgId).eq('status', 'bounced');
    for (const b of (bounces || []) as { to_email: string }[]) set.add(norm(b.to_email));
  } catch (e) { logger.warn(`[email-campaign] bounce load failed: ${(e as Error).message}`); }
  return set;
}

async function loadTemplate(orgId: string, templateId: string) {
  const { data } = await supabaseAdmin.from(TEMPLATES)
    .select('id, subject, body_html, body_text')
    .eq('org_id', orgId).eq('id', templateId).maybeSingle();
  return data as { id: string; subject: string | null; body_html: string | null; body_text: string | null } | null;
}

// ── Preview ──────────────────────────────────────────────────────────────────

export async function previewCampaign(
  scope: Scope,
  input: { template_id?: string | null; subject?: string; body_html?: string; audience: AudienceFilter },
) {
  const { recipients, skipped, total_candidates } = await resolveAudience(scope, input.audience || {});
  let subject = input.subject || '';
  let bodyHtml = input.body_html || '';
  if (input.template_id) {
    const tpl = await loadTemplate(scope.orgId, input.template_id);
    if (!tpl) throw new AppError(404, 'Email template not found', 'NOT_FOUND');
    subject = subject || tpl.subject || '';
    bodyHtml = bodyHtml || tpl.body_html || '';
  }
  const sampleVars = recipients[0]?.vars || { first_name: 'there', last_name: '', email: 'sample@example.com' };
  const sampleHtml = bodyHtml ? await renderTemplate(bodyHtml, sampleVars) : '';
  const sampleSubject = subject ? await renderTemplate(subject, sampleVars) : '';
  return {
    count: recipients.length,
    total_candidates,
    skipped,
    subject: sampleSubject,
    sample_html: sampleHtml,
    sample_recipients: recipients.slice(0, 8).map((r) => ({ email: r.email, first_name: r.first_name })),
  };
}

// ── CRUD / lifecycle ─────────────────────────────────────────────────────────

export async function listCampaigns(scope: Scope, query: Record<string, unknown> = {}) {
  let q = supabaseAdmin.from(CAMPAIGNS).select('*').eq('org_id', scope.orgId);
  if (scope.clientId) q = q.eq('client_id', scope.clientId);
  if (query.status) q = q.eq('status', String(query.status));
  const limit = Math.min(Number(query.limit ?? 50), 200);
  q = q.order('created_at', { ascending: false }).limit(limit);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

export async function getCampaign(scope: Scope, id: string) {
  const c = await loadCampaign(scope, id);
  return c;
}

async function loadCampaign(scope: Scope, id: string) {
  if (!UUID_RE.test(id)) throw new AppError(400, 'Invalid campaign id', 'BAD_REQUEST');
  const { data, error } = await supabaseAdmin.from(CAMPAIGNS).select('*')
    .eq('org_id', scope.orgId).eq('id', id).maybeSingle();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(404, 'Campaign not found', 'NOT_FOUND');
  return data as any;
}

export async function listRecipients(scope: Scope, id: string, query: Record<string, unknown> = {}) {
  await loadCampaign(scope, id);
  let q = supabaseAdmin.from(RECIPIENTS).select('*').eq('campaign_id', id);
  if (query.status) q = q.eq('status', String(query.status));
  const limit = Math.min(Number(query.limit ?? 100), 500);
  const page = Math.max(Number(query.page ?? 1), 1);
  q = q.order('created_at', { ascending: true }).range((page - 1) * limit, page * limit - 1);
  const { data, error } = await q;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data ?? [];
}

export async function createCampaign(
  scope: Scope,
  input: {
    name: string;
    template_id?: string | null;
    subject?: string;
    body_html?: string;
    body_text?: string;
    from_email?: string;
    audience: AudienceFilter;
    throttle_per_min?: number;
  },
) {
  let subject = (input.subject || '').trim();
  let bodyHtml = input.body_html || '';
  let bodyText = input.body_text || '';
  if (input.template_id) {
    const tpl = await loadTemplate(scope.orgId, input.template_id);
    if (!tpl) throw new AppError(404, 'Email template not found', 'NOT_FOUND');
    subject = subject || (tpl.subject || '');
    bodyHtml = bodyHtml || (tpl.body_html || '');
    bodyText = bodyText || (tpl.body_text || '');
  }
  if (!subject) throw new AppError(400, 'A subject is required', 'BAD_REQUEST');
  if (!bodyHtml) throw new AppError(400, 'Email body is required (pick a template or provide HTML)', 'BAD_REQUEST');

  const { data, error } = await supabaseAdmin.from(CAMPAIGNS).insert({
    org_id: scope.orgId,
    client_id: scope.clientId ?? null,
    name: input.name,
    template_id: input.template_id ?? null,
    subject,
    body_html: bodyHtml,
    body_text: bodyText || htmlToPlainText(bodyHtml),
    from_email: input.from_email || null,
    audience: input.audience || {},
    throttle_per_min: clampThrottle(input.throttle_per_min),
    status: 'draft',
    created_by: scope.userId ?? null,
  }).select('*').single();
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data;
}

/** Draft → sending. Materialises recipients, then kicks an immediate first batch. */
export async function launchCampaign(scope: Scope, id: string) {
  const campaign = await loadCampaign(scope, id);
  if (!['draft', 'paused'].includes(campaign.status)) {
    throw new AppError(400, `Cannot launch a campaign in status "${campaign.status}"`, 'BAD_STATE');
  }

  // Only (re)materialise recipients on the first launch from draft. A resume
  // from paused keeps the already-inserted recipient rows.
  if (campaign.status === 'draft') {
    const { recipients } = await resolveAudience(scope, (campaign.audience || {}) as AudienceFilter);
    if (!recipients.length) throw new AppError(400, 'Audience is empty — no eligible recipients with an email address.', 'EMPTY_AUDIENCE');

    for (let i = 0; i < recipients.length; i += INSERT_CHUNK) {
      const chunk = recipients.slice(i, i + INSERT_CHUNK).map((r) => ({
        campaign_id: id,
        org_id: scope.orgId,
        lead_id: r.lead_id,
        email: r.email,
        first_name: r.first_name,
        vars: r.vars,
        status: 'queued',
      }));
      const { error } = await supabaseAdmin.from(RECIPIENTS).insert(chunk);
      if (error) throw new AppError(500, error.message, 'DB_ERROR');
    }
    await supabaseAdmin.from(CAMPAIGNS).update({
      status: 'sending', total: recipients.length, sent: 0, failed: 0, skipped: 0,
      launched_at: new Date().toISOString(), last_batch_at: null, completed_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', id);
  } else {
    await supabaseAdmin.from(CAMPAIGNS).update({
      status: 'sending', last_batch_at: null, updated_at: new Date().toISOString(),
    }).eq('id', id);
  }

  // Immediate first batch (fire-and-forget). The claim CAS makes this safe even
  // if the scheduler fires the same campaign concurrently.
  void processCampaignBatch(scope.orgId, id).catch((e) =>
    logger.warn(`[email-campaign] first batch failed for ${id}: ${(e as Error).message}`));

  return loadCampaign(scope, id);
}

export async function pauseCampaign(scope: Scope, id: string) {
  const c = await loadCampaign(scope, id);
  if (c.status !== 'sending') throw new AppError(400, `Cannot pause a campaign in status "${c.status}"`, 'BAD_STATE');
  await supabaseAdmin.from(CAMPAIGNS).update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', id);
  return loadCampaign(scope, id);
}

export async function resumeCampaign(scope: Scope, id: string) {
  return launchCampaign(scope, id); // paused → sending, no re-materialise
}

export async function cancelCampaign(scope: Scope, id: string) {
  const c = await loadCampaign(scope, id);
  if (['completed', 'cancelled'].includes(c.status)) return c;
  await supabaseAdmin.from(CAMPAIGNS).update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', id);
  // Drop everything still queued so a stray scheduler tick can't resurrect it.
  await supabaseAdmin.from(RECIPIENTS).update({ status: 'skipped', skip_reason: 'cancelled' })
    .eq('campaign_id', id).eq('status', 'queued');
  return loadCampaign(scope, id);
}

// ── Paced sending ────────────────────────────────────────────────────────────

/**
 * Resolve the effective From address for a campaign send. If the campaign has
 * its own from_email, honour it. Otherwise fall back to the org's DEFAULT
 * VERIFIED sender — NOT the env CRM_FROM_EMAIL, which may point at an unverified
 * domain (e.g. mail.kinematicapp.com) that Resend 403s on every recipient. The
 * campaign wizard has no From picker today, so without this every send failed.
 */
async function resolveCampaignFrom(orgId: string, campaignFrom?: string | null): Promise<string | undefined> {
  if (campaignFrom) return campaignFrom;
  const { data } = await supabaseAdmin
    .from('crm_verified_senders')
    .select('email, display_name, is_default')
    .eq('org_id', orgId)
    .not('verified_at', 'is', null)
    .order('is_default', { ascending: false, nullsFirst: false })
    .order('verified_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!data) return undefined; // no verified sender — let sendEmail apply its env default
  const email = (data as { email?: string }).email;
  if (!email) return undefined;
  const name = (data as { display_name?: string | null }).display_name;
  return name ? `${name} <${email}>` : email;
}

/** Send one batch (up to throttle_per_min) for a campaign. CAS-claims rows so
 *  concurrent runners never double-send. Returns how many were sent this tick. */
export async function processCampaignBatch(orgId: string, id: string): Promise<{ sent: number; failed: number; skipped: number; done: boolean }> {
  const { data: campaign } = await supabaseAdmin.from(CAMPAIGNS).select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  if (!campaign || (campaign as any).status !== 'sending') return { sent: 0, failed: 0, skipped: 0, done: true };
  const c = campaign as any;
  const batchSize = clampThrottle(c.throttle_per_min);
  // Pick the verified From once per batch (avoids the unverified env fallback).
  const effectiveFrom = await resolveCampaignFrom(orgId, c.from_email);

  const { data: queued } = await supabaseAdmin.from(RECIPIENTS)
    .select('id').eq('campaign_id', id).eq('status', 'queued')
    .order('created_at', { ascending: true }).limit(batchSize);
  const ids = (queued || []).map((r: any) => r.id);
  if (!ids.length) {
    await finalizeIfDone(orgId, id);
    return { sent: 0, failed: 0, skipped: 0, done: true };
  }

  // Compare-and-swap claim: only rows still 'queued' flip to 'sending' and come
  // back — a competing runner gets the empty set for those ids.
  const { data: claimedRows } = await supabaseAdmin.from(RECIPIENTS)
    .update({ status: 'sending' }).in('id', ids).eq('status', 'queued').select('*');
  const claimed = (claimedRows || []) as any[];
  if (!claimed.length) return { sent: 0, failed: 0, skipped: 0, done: false };

  let sent = 0, failed = 0, skipped = 0;
  for (let i = 0; i < claimed.length; i += SEND_CONCURRENCY) {
    const slice = claimed.slice(i, i + SEND_CONCURRENCY);
    await Promise.all(slice.map(async (rec) => {
      const vars = (rec.vars || {}) as Record<string, string>;
      try {
        const subject = await renderTemplate(c.subject || '', vars);
        const html = await renderTemplate(c.body_html || '', vars);
        const text = c.body_text ? await renderTemplate(c.body_text, vars) : undefined;
        const result = await sendEmail({
          org_id: orgId,
          user_id: c.created_by ?? undefined,
          to: rec.email,
          subject,
          body_html: html,
          body_text: text,
          template_id: c.template_id ?? null,
          lead_id: rec.lead_id ?? null,
          from_email: effectiveFrom,
          campaign_id: id,
        }) as { id: string; suppressed?: string | null; status?: string; error?: string | null };

        if (result.suppressed) {
          skipped++;
          await supabaseAdmin.from(RECIPIENTS).update({
            status: 'skipped', skip_reason: result.suppressed, email_log_id: result.id ?? null,
          }).eq('id', rec.id);
        } else if (result.status === 'failed') {
          failed++;
          await supabaseAdmin.from(RECIPIENTS).update({
            status: 'failed', error: (result.error || 'send failed').slice(0, 300), email_log_id: result.id ?? null,
          }).eq('id', rec.id);
        } else {
          sent++;
          await supabaseAdmin.from(RECIPIENTS).update({
            status: 'sent', email_log_id: result.id ?? null, sent_at: new Date().toISOString(),
          }).eq('id', rec.id);
        }
      } catch (e) {
        failed++;
        await supabaseAdmin.from(RECIPIENTS).update({
          status: 'failed', error: (e as Error).message?.slice(0, 300) ?? 'unknown',
        }).eq('id', rec.id);
      }
    }));
  }

  // Roll the tallies into the campaign counters + stamp the batch time.
  await supabaseAdmin.from(CAMPAIGNS).update({
    sent: (c.sent ?? 0) + sent,
    failed: (c.failed ?? 0) + failed,
    skipped: (c.skipped ?? 0) + skipped,
    last_batch_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id);

  const done = await finalizeIfDone(orgId, id);
  return { sent, failed, skipped, done };
}

/** Marks a campaign completed once nothing is left queued/sending. */
async function finalizeIfDone(orgId: string, id: string): Promise<boolean> {
  const { count } = await supabaseAdmin.from(RECIPIENTS)
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', id).in('status', ['queued', 'sending']);
  if ((count ?? 0) > 0) return false;
  await supabaseAdmin.from(CAMPAIGNS).update({
    status: 'completed', completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'sending');
  return true;
}

// ── Scheduler (server.ts) ────────────────────────────────────────────────────

/** Advance every in-flight campaign in the CURRENT project by one batch. */
export async function processDueEmailCampaigns(): Promise<{ processed: number; sent: number }> {
  const cutoff = new Date(Date.now() - BATCH_IDLE_MS).toISOString();
  const { data } = await supabaseAdmin.from(CAMPAIGNS)
    .select('id, org_id, last_batch_at')
    .eq('status', 'sending')
    .or(`last_batch_at.is.null,last_batch_at.lt.${cutoff}`)
    .limit(50);
  let processed = 0, sent = 0;
  for (const c of (data || []) as any[]) {
    try {
      const r = await processCampaignBatch(c.org_id, c.id);
      processed++; sent += r.sent;
    } catch (e) {
      logger.warn(`[email-campaign] batch failed for ${c.id}: ${(e as Error).message}`);
    }
  }
  return { processed, sent };
}

export async function processDueEmailCampaignsAllProjects(): Promise<{ processed: number; sent: number }> {
  let processed = 0, sent = 0;
  for (const key of knownProjectKeys()) {
    try {
      const r = await runWithProject(key, () => processDueEmailCampaigns());
      processed += r.processed; sent += r.sent;
    } catch (e) {
      logger.warn(`[email-campaign] project ${key} run failed: ${(e as Error).message}`);
    }
  }
  return { processed, sent };
}

// ── Analytics / usage / export ───────────────────────────────────────────────

export async function getAnalytics(scope: Scope, id: string) {
  const campaign = await loadCampaign(scope, id);
  const base = () => supabaseAdmin.from(LOGS).select('id', { count: 'exact', head: true }).eq('org_id', scope.orgId).eq('campaign_id', id);
  const [total, failed, bounced, unsub, opened, clicked] = await Promise.all([
    base(),
    base().eq('status', 'failed'),
    base().eq('status', 'bounced'),
    base().eq('status', 'unsubscribed'),
    base().gt('open_count', 0),
    base().gt('click_count', 0),
  ]);
  const totalLogs = total.count ?? 0;
  const failedN = failed.count ?? 0;
  const bouncedN = bounced.count ?? 0;
  const delivered = Math.max(0, totalLogs - failedN - bouncedN);
  const openedN = opened.count ?? 0;
  const clickedN = clicked.count ?? 0;

  // Recipient-side skip breakdown (suppressed / cancelled etc.).
  const { data: skipRows } = await supabaseAdmin.from(RECIPIENTS)
    .select('skip_reason').eq('campaign_id', id).eq('status', 'skipped');
  const skips: Record<string, number> = {};
  for (const s of (skipRows || []) as { skip_reason: string | null }[]) {
    const k = s.skip_reason || 'skipped';
    skips[k] = (skips[k] || 0) + 1;
  }

  return {
    campaign,
    totals: {
      recipients: campaign.total ?? 0,
      queued: Math.max(0, (campaign.total ?? 0) - (campaign.sent ?? 0) - (campaign.failed ?? 0) - (campaign.skipped ?? 0)),
      sent: campaign.sent ?? 0,
      failed: failedN,
      skipped: campaign.skipped ?? 0,
      delivered,
      bounced: bouncedN,
      opened: openedN,
      clicked: clickedN,
      unsubscribed: unsub.count ?? 0,
    },
    open_rate: delivered ? Math.round((openedN / delivered) * 1000) / 10 : 0,
    click_rate: delivered ? Math.round((clickedN / delivered) * 1000) / 10 : 0,
    skips,
  };
}

export async function getUsage(scope: Scope) {
  const monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [campaigns, sent30] = await Promise.all([
    supabaseAdmin.from(CAMPAIGNS).select('id', { count: 'exact', head: true }).eq('org_id', scope.orgId),
    supabaseAdmin.from(LOGS).select('id', { count: 'exact', head: true })
      .eq('org_id', scope.orgId).not('campaign_id', 'is', null).gte('created_at', monthStart.toISOString()),
  ]);
  return { campaigns: campaigns.count ?? 0, emails_this_month: sent30.count ?? 0 };
}

export async function recipientsCsv(scope: Scope, id: string): Promise<string> {
  await loadCampaign(scope, id);
  const { data } = await supabaseAdmin.from(RECIPIENTS)
    .select('email, first_name, status, skip_reason, error, sent_at')
    .eq('campaign_id', id).order('created_at', { ascending: true }).limit(MAX_AUDIENCE);
  const header = ['email', 'first_name', 'status', 'skip_reason', 'error', 'sent_at'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of (data || []) as any[]) {
    lines.push([r.email, r.first_name, r.status, r.skip_reason, r.error, r.sent_at].map(esc).join(','));
  }
  return lines.join('\n');
}
