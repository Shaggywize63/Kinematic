/**
 * Zero-config onboarding for the Tally connector.
 *
 * Admin side (JWT, admin-only, mounted under /distribution/integrations/:id/...):
 *   pairing code, readiness checklist, "create missing ledgers", "pull masters",
 *   review + import of the pulled stock items / parties.
 * Agent side (public routes, per-integration agent key via ?key=):
 *   pair (code -> config), profile, masters, command-result.
 */
import { Request, Response } from 'express';
import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, notFound } from '../../utils';
import { logger } from '../../lib/logger';
import { verifyAgentSecret } from './integrations.controller';
import { scopeIntegrations } from '../../lib/companyVisibility';
import { ensureCompanyPriceList, tallyPrice } from '../../services/distribution/companyPriceList';
import { pinnedCompany } from '../../services/distribution/integrations/enqueue.poller';
import {
  PAIRING_TTL_MS, publicApiBase, generatePairingCode, hashPairingCode, normalisePairingCode,
  computeHealth, missingLedgers, buildCreateLedgersXml,
  sanitiseMaster, matchParty, matchStockItem, cleanGstin, partyCode,
  type TallyProfile, type MasterKind, type MatchCandidate,
} from '../../services/distribution/integrations/tally.onboarding';
import type { TallyIntegrationConfig } from '../../services/distribution/integrations/tally.mapper';

const MAX_MASTERS_PER_POST = 500;
const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

interface Command { id: string; type: 'pull_masters' | 'pull_vouchers' | 'tally_xml'; label?: string; xml?: string }

async function loadTallyIntegration(org_id: string, id: string, user?: { client_id?: string | null; company_client_ids?: string[] }) {
  if (!isUuid(id)) return null;
  const { data } = await scopeIntegrations(supabaseAdmin.from('distribution_integrations')
    .select('id, org_id, provider, config, last_seen_at, agent_version, tally_profile, tally_profile_at, pending_commands, last_command_result, master_sync_requested_at, last_master_sync_at')
    .eq('id', id).eq('org_id', org_id).eq('provider', 'tally'), user).maybeSingle();
  return data as null | {
    id: string; org_id: string; config: TallyIntegrationConfig; last_seen_at: string | null; agent_version: string | null;
    tally_profile: TallyProfile | null; tally_profile_at: string | null; pending_commands: Command[] | null;
    last_command_result: unknown; master_sync_requested_at: string | null; last_master_sync_at: string | null;
  };
}

/** Queue a command, replacing any not-yet-acked command of the same type + label. */
async function queueCommand(integrationId: string, current: Command[] | null, cmd: Command) {
  const kept = (current ?? []).filter(c => !(c.type === cmd.type && (c.label ?? '') === (cmd.label ?? '')));
  await supabaseAdmin.from('distribution_integrations').update({ pending_commands: [...kept, cmd] }).eq('id', integrationId);
}

// ── Admin ───────────────────────────────────────────────────────────────────

export const createPairingCode = asyncHandler<AuthRequest>(async (req, res) => {
  const integ = await loadTallyIntegration(req.user!.org_id, req.params.id, req.user);
  if (!integ) return notFound(res, 'Tally integration not found');
  const code = generatePairingCode();
  const expires = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const { error } = await supabaseAdmin.from('distribution_integrations')
    .update({ pairing_code_hash: hashPairingCode(code), pairing_expires_at: expires }).eq('id', integ.id);
  if (error) return badRequest(res, error.message);
  return ok(res, { code, expires_at: expires, server_url: publicApiBase() });
});

export const getHealth = asyncHandler<AuthRequest>(async (req, res) => {
  const integ = await loadTallyIntegration(req.user!.org_id, req.params.id, req.user);
  if (!integ) return notFound(res, 'Tally integration not found');
  const health = computeHealth({ agentSeenAt: integ.last_seen_at, profile: integ.tally_profile, config: integ.config ?? {} });

  const { data: rows } = await supabaseAdmin.from('distribution_tally_masters')
    .select('kind, status').eq('integration_id', integ.id).limit(20000);
  const counts: Record<string, Record<string, number>> = { stock_item: {}, party: {} };
  for (const r of rows ?? []) {
    const k = r.kind as string; const s = r.status as string;
    (counts[k] ??= {})[s] = (counts[k][s] ?? 0) + 1;
  }
  return ok(res, {
    ...health,
    agent_version: integ.agent_version,
    last_seen_at: integ.last_seen_at,
    profile: integ.tally_profile ? {
      companies: integ.tally_profile.companies ?? [], current_company: integ.tally_profile.current_company ?? null,
      stock_item_count: integ.tally_profile.stock_item_count ?? null, party_count: integ.tally_profile.party_count ?? null,
    } : null,
    master_counts: counts,
    last_master_sync_at: integ.last_master_sync_at,
    master_sync_pending: !!integ.master_sync_requested_at,
    pending_commands: (integ.pending_commands ?? []).length,
    last_command_result: integ.last_command_result,
  });
});

export const createMissingLedgers = asyncHandler<AuthRequest>(async (req, res) => {
  const integ = await loadTallyIntegration(req.user!.org_id, req.params.id, req.user);
  if (!integ) return notFound(res, 'Tally integration not found');
  const company = integ.config?.company_name?.trim();
  if (!company) return badRequest(res, 'Choose the Tally company first');
  if (!integ.tally_profile) return badRequest(res, 'The connector has not reported yet');
  const missing = missingLedgers(integ.config ?? {}, integ.tally_profile);
  if (missing.length === 0) return ok(res, { queued: 0, ledgers: [] });
  const cmd: Command = { id: crypto.randomUUID(), type: 'tally_xml', label: 'create_ledgers', xml: buildCreateLedgersXml(company, missing) };
  await queueCommand(integ.id, integ.pending_commands, cmd);
  return ok(res, { queued: missing.length, ledgers: missing.map(m => m.name) });
});

export const requestMasterPull = asyncHandler<AuthRequest>(async (req, res) => {
  const integ = await loadTallyIntegration(req.user!.org_id, req.params.id, req.user);
  if (!integ) return notFound(res, 'Tally integration not found');
  const cmd: Command = { id: crypto.randomUUID(), type: 'pull_masters' };
  await queueCommand(integ.id, integ.pending_commands, cmd);
  await supabaseAdmin.from('distribution_integrations')
    .update({ master_sync_requested_at: new Date().toISOString() }).eq('id', integ.id);
  return ok(res, { queued: true });
});

/** Queue a "pull voucher/order status from Tally" command (the fetch-back half of 2-way order sync). */
export const requestVoucherPull = asyncHandler<AuthRequest>(async (req, res) => {
  const integ = await loadTallyIntegration(req.user!.org_id, req.params.id, req.user);
  if (!integ) return notFound(res, 'Tally integration not found');
  const cmd: Command = { id: crypto.randomUUID(), type: 'pull_vouchers' };
  await queueCommand(integ.id, integ.pending_commands, cmd);
  return ok(res, { queued: true });
});

export const listMasters = asyncHandler<AuthRequest>(async (req, res) => {
  const integ = await loadTallyIntegration(req.user!.org_id, req.params.id, req.user);
  if (!integ) return notFound(res, 'Tally integration not found');
  const kind = req.query.kind === 'party' ? 'party' : 'stock_item';
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  let q = supabaseAdmin.from('distribution_tally_masters')
    .select('id, kind, tally_guid, name, data, status, matched_ref_id, match_method, last_seen_at', { count: 'exact' })
    .eq('integration_id', integ.id).eq('kind', kind);
  const status = req.query.status as string | undefined;
  if (status && ['new', 'matched', 'imported', 'ignored'].includes(status)) q = q.eq('status', status);
  const term = String(req.query.q ?? '').trim().replace(/[%,()]/g, ' ');
  if (term) q = q.ilike('name', `%${term}%`);
  const { data, error, count } = await q.order('name').range(offset, offset + limit - 1);
  if (error) return badRequest(res, error.message);
  return ok(res, { items: data ?? [], total: count ?? 0 });
});

/** body: { kind, action: 'import'|'ignore'|'link', ids?: uuid[], all_new?: boolean, link_to?: uuid } */
export const actOnMasters = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const integ = await loadTallyIntegration(user.org_id, req.params.id, user);
  if (!integ) return notFound(res, 'Tally integration not found');
  const { action, ids, all_new, link_to } = req.body as { kind?: string; action?: string; ids?: unknown[]; all_new?: boolean; link_to?: string };
  const kind: MasterKind = req.body.kind === 'party' ? 'party' : 'stock_item';
  if (!['import', 'ignore', 'link'].includes(action ?? '')) return badRequest(res, 'action must be import, ignore or link');

  let q = supabaseAdmin.from('distribution_tally_masters').select('*')
    .eq('integration_id', integ.id).eq('kind', kind);
  if (all_new) q = q.eq('status', 'new').limit(2000);
  else {
    const good = (ids ?? []).filter(isUuid);
    if (good.length === 0) return badRequest(res, 'ids required');
    q = q.in('id', good.slice(0, 500));
  }
  const { data: rows, error } = await q;
  if (error) return badRequest(res, error.message);
  const items = rows ?? [];
  const now = new Date().toISOString();

  if (action === 'ignore') {
    await supabaseAdmin.from('distribution_tally_masters').update({ status: 'ignored', updated_at: now })
      .in('id', items.map(i => i.id as string)).neq('status', 'imported');
    return ok(res, { updated: items.length });
  }

  if (action === 'link') {
    if (items.length !== 1 || !isUuid(link_to)) return badRequest(res, 'link needs exactly one item and link_to');
    const table = kind === 'party' ? 'distributors' : 'skus';
    const { data: target } = await supabaseAdmin.from(table).select('id').eq('id', link_to).eq('org_id', user.org_id).maybeSingle();
    if (!target) return notFound(res, 'Link target not found');
    // One Kinematic record maps to one Tally master (the voucher mapper picks the first).
    await supabaseAdmin.from('distribution_tally_masters').update({ status: 'new', matched_ref_id: null, match_method: null })
      .eq('integration_id', integ.id).eq('kind', kind).eq('matched_ref_id', link_to);
    await supabaseAdmin.from('distribution_tally_masters')
      .update({ status: 'matched', matched_ref_id: link_to, match_method: 'manual', updated_at: now }).eq('id', items[0].id as string);
    return ok(res, { updated: 1 });
  }

  // import — records land under the Tally connection's own company when it is pinned to one
  const pinned = pinnedCompany(integ.config as Record<string, unknown> | null);
  const companyId = pinned ?? user.client_id ?? null;
  // Only a connection pinned to a company feeds that company's price list (other imports are unchanged).
  const priceListId = pinned && kind === 'stock_item' ? await ensureCompanyPriceList(user.org_id, pinned, user.id) : null;
  const results = { created: 0, unpriced: 0, failed: [] as Array<{ name: string; error: string }> };
  for (const it of items) {
    if (it.status === 'imported' || it.status === 'matched') continue;
    const d = (it.data ?? {}) as Record<string, unknown>;
    let refId: string | null = null; let errMsg: string | null = null;
    if (kind === 'party') {
      const gstin = cleanGstin(d.gstin);
      const days = Number(d.credit_period_days);
      const dealerRow = {
        org_id: user.org_id, client_id: companyId, created_by: user.id,
        name: it.name, code: partyCode(it.tally_guid as string), legal_name: it.name,
        gstin, pan: gstin ? gstin.slice(2, 12) : null, state_code: gstin ? gstin.slice(0, 2) : null,
        contact_name: (d.contact as string) || null, contact_mobile: (d.phone as string) || null, email: (d.email as string) || null,
        address: { line1: d.address ?? '', city: d.city ?? '', state: d.state ?? '', pincode: d.pincode ?? '' },
        credit_limit: Number(d.credit_limit) > 0 ? Number(d.credit_limit) : 0,
        payment_terms_days: Number.isFinite(days) && days > 0 ? Math.floor(days) : 0,
        customer_class: 'distributor', is_active: true,
        // This dealer came FROM Tally — mark it in-sync so the enqueue poller doesn't
        // immediately push it back up as an "edit" (two-way loop guard).
        tally_synced_at: now,
      };
      // `tally_synced_at` comes with the two-way-sync migration; on a database without it, import without the loop guard.
      let ins = await supabaseAdmin.from('distributors').insert(dealerRow).select('id').single();
      if (ins.error && /tally_synced_at/i.test(ins.error.message)) {
        const { tally_synced_at: _omit, ...withoutGuard } = dealerRow;
        ins = await supabaseAdmin.from('distributors').insert(withoutGuard).select('id').single();
      }
      const row = ins.data; const e = ins.error;
      refId = row?.id ?? null; errMsg = e?.message ?? null;
    } else {
      const { data: row, error: e } = await supabaseAdmin.from('skus').insert({
        org_id: user.org_id, client_id: companyId,
        sku_code: (d.part_number as string) || `TLY-${(it.tally_guid as string).slice(-8).toUpperCase()}`,
        name: it.name, unit: (d.unit as string) || 'PCS', category: (d.category as string) || null,
        tally_stock_item_name: it.name,       // exact Tally spelling, used by vouchers
      }).select('id').single();
      refId = row?.id ?? null; errMsg = e?.message ?? null;
      if (refId) {
        const { error: e2 } = await supabaseAdmin.from('product_distribution_ext').insert({
          sku_id: refId, org_id: user.org_id, client_id: companyId,
          hsn_code: (d.hsn_code as string) || null, gst_rate: Number(d.gst_rate) || 0,
          uom: (d.unit as string) || 'PCS', mrp: Number(d.mrp) || Number(d.rate) || 0, is_active: true,
        });
        if (e2) errMsg = `Created the product but not its tax details: ${e2.message}`;
        if (priceListId) {
          const price = tallyPrice(d);
          if (price === null) results.unpriced++;
          else {
            const { error: e3 } = await supabaseAdmin.from('price_list_items').insert({ price_list_id: priceListId, sku_id: refId, base_price: price });
            if (e3 && !errMsg) errMsg = `Created the product but not its price: ${e3.message}`;
          }
        }
      }
    }
    if (refId) {
      await supabaseAdmin.from('distribution_tally_masters')
        .update({ status: 'imported', matched_ref_id: refId, match_method: 'created', updated_at: now }).eq('id', it.id as string);
      results.created++;
    }
    if (errMsg) results.failed.push({ name: it.name as string, error: errMsg });
  }
  return ok(res, results);
});

// ── Agent (public, ?key=) ───────────────────────────────────────────────────

/** Exchange a one-time pairing code for the agent's config. Single use. */
export const agentPair = asyncHandler<Request>(async (req, res) => {
  const norm = normalisePairingCode(req.body?.code);
  if (norm.length !== 6) { res.status(400).json({ ok: false, error: 'Enter the 6-character code from the dashboard' }); return; }
  const hash = hashPairingCode(norm);
  // Clear-and-return in one statement so a code can never be redeemed twice.
  const { data: integ } = await supabaseAdmin.from('distribution_integrations')
    .update({ pairing_code_hash: null, pairing_expires_at: null })
    .eq('pairing_code_hash', hash).gt('pairing_expires_at', new Date().toISOString()).eq('provider', 'tally')
    .select('id, agent_secret, config').maybeSingle();
  if (!integ) { res.status(404).json({ ok: false, error: 'That code is invalid or has expired. Generate a new one in the dashboard.' }); return; }
  const base = publicApiBase();
  res.status(200).json({
    ok: true,
    config: {
      integration_id: integ.id,
      agent_secret: integ.agent_secret,
      polling_endpoint: `${base}/api/v1/integrations/tally/jobs/${integ.id}?key=${integ.agent_secret}`,
      report_endpoint: `${base}/api/v1/integrations/tally/jobs/${integ.id}/result?key=${integ.agent_secret}`,
      tally_url: 'http://localhost:9000',
      poll_interval_seconds: 30,
    },
    company_name: (integ.config as TallyIntegrationConfig | null)?.company_name ?? null,
  });
});

async function authAgent(req: Request, res: Response) {
  const id = req.params.id;
  if (!isUuid(id)) { res.status(404).json({ ok: false, error: 'unknown integration' }); return null; }
  const { data: integ } = await supabaseAdmin.from('distribution_integrations')
    .select('id, org_id, provider, status, agent_secret, config, pending_commands').eq('id', id).maybeSingle();
  if (!integ || integ.provider !== 'tally') { res.status(404).json({ ok: false, error: 'unknown integration' }); return null; }
  if (!verifyAgentSecret(req, integ.agent_secret as string | null)) { res.status(403).json({ ok: false, error: 'bad agent key' }); return null; }
  return integ as { id: string; org_id: string; config: TallyIntegrationConfig; pending_commands: Command[] | null };
}

export const agentProfile = asyncHandler<Request>(async (req, res) => {
  const integ = await authAgent(req, res); if (!integ) return;
  const b = req.body ?? {};
  const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const strs = (v: unknown, max = 50) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max).map(x => (x as string).slice(0, 200)) : undefined);
  const profile: TallyProfile = {
    tally_reachable: !!b.tally_reachable,
    tally_error: str(b.tally_error, 400),
    companies: strs(b.companies),
    current_company: str(b.current_company) ?? null,
    ledgers: Array.isArray(b.ledgers)
      ? b.ledgers.slice(0, 5000).filter((l: any) => l && typeof l.name === 'string').map((l: any) => ({ name: l.name.slice(0, 200), parent: str(l.parent) }))
      : undefined,
    voucher_types: strs(b.voucher_types, 100),
    stock_item_count: Number.isFinite(b.stock_item_count) ? Number(b.stock_item_count) : undefined,
    party_count: Number.isFinite(b.party_count) ? Number(b.party_count) : undefined,
  };
  await supabaseAdmin.from('distribution_integrations').update({
    tally_profile: profile, tally_profile_at: new Date().toISOString(),
    agent_version: str(b.agent_version, 40) ?? null, last_seen_at: new Date().toISOString(),
  }).eq('id', integ.id);
  res.status(200).json({ ok: true });
});

export const agentMasters = asyncHandler<Request>(async (req, res) => {
  const integ = await authAgent(req, res); if (!integ) return;
  const kind: MasterKind | null = req.body?.kind === 'stock_item' ? 'stock_item' : req.body?.kind === 'party' ? 'party' : null;
  if (!kind) { res.status(400).json({ ok: false, error: 'kind must be stock_item or party' }); return; }
  const rawItems: unknown[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, MAX_MASTERS_PER_POST) : [];
  const items = rawItems.map(sanitiseMaster).filter((x): x is NonNullable<typeof x> => !!x);
  const now = new Date().toISOString();

  if (items.length > 0) {
    // Existing rows keep their status/match; only data + last_seen are refreshed.
    const { data: existing } = await supabaseAdmin.from('distribution_tally_masters')
      .select('tally_guid').eq('integration_id', integ.id).eq('kind', kind).in('tally_guid', items.map(i => i.tally_guid));
    const have = new Set((existing ?? []).map(e => e.tally_guid as string));
    const fresh = items.filter(i => !have.has(i.tally_guid));
    const known = items.filter(i => have.has(i.tally_guid));

    for (const it of known) {
      const { tally_guid, name, ...data } = it;
      await supabaseAdmin.from('distribution_tally_masters')
        .update({ name, data, last_seen_at: now, updated_at: now })
        .eq('integration_id', integ.id).eq('kind', kind).eq('tally_guid', tally_guid);
    }

    if (fresh.length > 0) {
      // Auto-match against what the org already has, so most rows arrive pre-linked.
      const table = kind === 'party' ? 'distributors' : 'skus';
      const cols = kind === 'party' ? 'id, name, legal_name, gstin' : 'id, name, sku_code';
      const { data: cand } = await supabaseAdmin.from(table).select(cols).eq('org_id', integ.org_id).limit(10000);
      const candidates = (cand ?? []) as unknown as MatchCandidate[];
      const { data: taken } = await supabaseAdmin.from('distribution_tally_masters')
        .select('matched_ref_id').eq('integration_id', integ.id).eq('kind', kind).not('matched_ref_id', 'is', null);
      const used = new Set((taken ?? []).map(t => t.matched_ref_id as string));
      const rows = fresh.map(it => {
        const { tally_guid, name, ...data } = it;
        const m = kind === 'party' ? matchParty({ name, gstin: data.gstin }, candidates.filter(c => !used.has(c.id)))
                                   : matchStockItem({ name, part_number: data.part_number }, candidates.filter(c => !used.has(c.id)));
        if (m) used.add(m.id);
        return {
          org_id: integ.org_id, integration_id: integ.id, kind, tally_guid, name, data,
          status: m ? 'matched' : 'new', matched_ref_id: m?.id ?? null, match_method: m?.method ?? null, last_seen_at: now,
        };
      });
      const { error } = await supabaseAdmin.from('distribution_tally_masters').insert(rows);
      if (error) { logger.error({ integration_id: integ.id, err: error.message }, 'tally masters insert failed'); res.status(500).json({ ok: false, error: 'store failed' }); return; }
    }
  }

  if (req.body?.final === true) {
    await supabaseAdmin.from('distribution_integrations')
      .update({ last_master_sync_at: now, master_sync_requested_at: null }).eq('id', integ.id);
  }
  res.status(200).json({ ok: true, received: items.length });
});

/**
 * Agent reports vouchers exported from Tally — the fetch-back half of two-way order sync.
 * Each voucher carries the REMOTEID we stamped on push (KIN-ORD-/KIN-INV-/KIN-RET-<uuid>);
 * we match it back to our push event and record the Tally status (present | cancelled) plus
 * the Tally voucher id/number. For orders the status is also surfaced on the order row so the
 * dashboard/app can show "Synced to Tally / Cancelled in Tally". Never clobbers the event's
 * own push lifecycle status.
 */
const REMOTE_PREFIX: Record<string, string> = { 'KIN-ORD-': 'orders', 'KIN-INV-': 'invoices', 'KIN-RET-': 'returns' };
export const agentVouchers = asyncHandler<Request>(async (req, res) => {
  const integ = await authAgent(req, res); if (!integ) return;
  const rawItems: unknown[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, MAX_MASTERS_PER_POST) : [];
  const now = new Date().toISOString();
  let matched = 0;

  for (const raw of rawItems) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const remoteId = String(it.remote_id ?? it.remoteid ?? '').trim();
    if (!remoteId) continue;
    let ref_table: string | null = null; let ref_id: string | null = null;
    for (const [p, t] of Object.entries(REMOTE_PREFIX)) {
      if (remoteId.toUpperCase().startsWith(p)) { ref_table = t; ref_id = remoteId.slice(p.length); break; }
    }
    if (!ref_table || !isUuid(ref_id)) continue;

    const isCancelled = it.is_cancelled === true || String(it.is_cancelled ?? '').toLowerCase() === 'yes';
    const tallyStatus = isCancelled ? 'cancelled' : 'present';
    const voucherId = typeof it.master_id === 'string' ? it.master_id.slice(0, 100)
      : (typeof it.voucher_id === 'string' ? it.voucher_id.slice(0, 100) : null);
    const voucherNo = typeof it.voucher_no === 'string' ? it.voucher_no.slice(0, 100) : null;

    const evUpdate: Record<string, unknown> = { tally_status: tallyStatus, tally_checked_at: now };
    if (voucherId) evUpdate.tally_voucher_id = voucherId;
    const { data: evs } = await supabaseAdmin.from('distribution_integration_events')
      .update(evUpdate)
      .eq('integration_id', integ.id).eq('ref_table', ref_table).eq('ref_id', ref_id).select('id');
    if (!(evs ?? []).length) continue;     // not pushed through THIS connection: never touch the row (other companies' connections share the org)
    matched++;

    if (ref_table === 'orders') {
      await supabaseAdmin.from('orders')
        .update({ tally_status: tallyStatus, tally_voucher_no: voucherNo, tally_checked_at: now })
        .eq('id', ref_id).eq('org_id', integ.org_id);
    }
  }
  res.status(200).json({ ok: true, received: rawItems.length, matched });
});

export const agentCommandResult = asyncHandler<Request>(async (req, res) => {
  const integ = await authAgent(req, res); if (!integ) return;
  const { command_id, ok: success, error } = req.body as { command_id?: string; ok?: boolean; error?: string };
  if (!isUuid(command_id)) { res.status(400).json({ ok: false, error: 'command_id required' }); return; }
  const remaining = (integ.pending_commands ?? []).filter(c => c.id !== command_id);
  const done = (integ.pending_commands ?? []).find(c => c.id === command_id);
  await supabaseAdmin.from('distribution_integrations').update({
    pending_commands: remaining,
    last_command_result: { command_id, type: done?.type ?? null, label: done?.label ?? null, ok: !!success, error: success ? null : String(error ?? 'failed').slice(0, 500), at: new Date().toISOString() },
    ...(success ? {} : { last_error: String(error ?? 'command failed').slice(0, 500) }),
  }).eq('id', integ.id);
  res.status(200).json({ ok: true });
});
