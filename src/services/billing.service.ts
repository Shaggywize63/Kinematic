/**
 * billing.service.ts
 *
 * Costs the planogram vision API usage recorded in `ai_usage` for the admin
 * Billing section: per-client totals over a period, with a per-model breakdown
 * and a daily total series for the chart. Cost is computed here from
 * aiPricing (not stored), so a rate change re-prices history.
 */
import { supabaseAdmin } from '../lib/supabase';
import { costUsd, usdToOmrRate } from '../lib/aiPricing';

interface UsageRow {
  client_id: string | null;
  model: string;
  capture_id: string | null;
  input_tokens: number | null;
  cache_write_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export interface ModelBreakdown {
  model: string;
  calls: number;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ClientBilling {
  client_id: string | null;
  client_name: string | null;
  captures: number;
  calls: number;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
  by_model: ModelBreakdown[];
}

export interface BillingSummary {
  from: string;
  to: string;
  feature: string;
  /** USD→OMR conversion the dashboard uses for its OMR toggle. */
  usd_to_omr: number;
  total_cost_usd: number;
  total_captures: number;
  total_calls: number;
  clients: ClientBilling[];
  /** Daily total cost (USD) across all clients, for the chart. */
  daily: Array<{ date: string; cost_usd: number }>;
}

function emptyModel(model: string): ModelBreakdown {
  return { model, calls: 0, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0 };
}

export class BillingService {
  /**
   * Vision API cost for `orgId` between [from, to], grouped by client and model.
   * Org-scoped like every other tenant read; a client admin sees their org's
   * clients, the platform operator (login-as) sees whichever org they act as.
   */
  static async visionUsage(orgId: string, from: string, to: string, feature = 'planogram_vision'): Promise<BillingSummary> {
    const { data, error } = await supabaseAdmin
      .from('ai_usage')
      .select('client_id, model, capture_id, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, created_at')
      .eq('org_id', orgId)
      .eq('feature', feature)
      .gte('created_at', from)
      .lte('created_at', to)
      .limit(100000);
    if (error) throw error;
    const rows = (data as UsageRow[] | null) || [];

    const byClient = new Map<string, ClientBilling>();
    const byModelInClient = new Map<string, Map<string, ModelBreakdown>>();
    const capturesInClient = new Map<string, Set<string>>();
    const daily = new Map<string, number>();
    let totalCost = 0;
    const totalCaptures = new Set<string>();

    for (const r of rows) {
      const key = r.client_id ?? '__none__';
      let cb = byClient.get(key);
      if (!cb) {
        cb = { client_id: r.client_id, client_name: null, captures: 0, calls: 0, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0, by_model: [] };
        byClient.set(key, cb);
        byModelInClient.set(key, new Map());
        capturesInClient.set(key, new Set());
      }
      const inTok = r.input_tokens ?? 0;
      const cwTok = r.cache_write_tokens ?? 0;
      const crTok = r.cache_read_tokens ?? 0;
      const outTok = r.output_tokens ?? 0;
      const rowCost = costUsd({ model: r.model, input_tokens: inTok, cache_write_tokens: cwTok, cache_read_tokens: crTok, output_tokens: outTok });

      cb.calls += 1;
      cb.input_tokens += inTok;
      cb.cache_write_tokens += cwTok;
      cb.cache_read_tokens += crTok;
      cb.output_tokens += outTok;
      cb.cost_usd += rowCost;
      if (r.capture_id) { capturesInClient.get(key)!.add(r.capture_id); totalCaptures.add(r.capture_id); }

      const mm = byModelInClient.get(key)!;
      let mb = mm.get(r.model);
      if (!mb) { mb = emptyModel(r.model); mm.set(r.model, mb); }
      mb.calls += 1;
      mb.input_tokens += inTok;
      mb.cache_write_tokens += cwTok;
      mb.cache_read_tokens += crTok;
      mb.output_tokens += outTok;
      mb.cost_usd += rowCost;

      totalCost += rowCost;
      const day = r.created_at.slice(0, 10);
      daily.set(day, (daily.get(day) ?? 0) + rowCost);
    }

    // Resolve client names.
    const clientIds = [...byClient.values()].map((c) => c.client_id).filter((id): id is string => !!id);
    if (clientIds.length) {
      const { data: cs } = await supabaseAdmin.from('clients').select('id, name').in('id', clientIds);
      const nameById = new Map((cs as Array<{ id: string; name: string | null }> | null || []).map((c) => [c.id, c.name]));
      for (const cb of byClient.values()) if (cb.client_id) cb.client_name = nameById.get(cb.client_id) ?? null;
    }

    const clients = [...byClient.entries()].map(([key, cb]) => {
      cb.captures = capturesInClient.get(key)!.size;
      cb.by_model = [...byModelInClient.get(key)!.values()].sort((a, b) => b.cost_usd - a.cost_usd);
      return cb;
    }).sort((a, b) => b.cost_usd - a.cost_usd);

    return {
      from,
      to,
      feature,
      usd_to_omr: usdToOmrRate(),
      total_cost_usd: totalCost,
      total_captures: totalCaptures.size,
      total_calls: rows.length,
      clients,
      daily: [...daily.entries()].map(([date, cost_usd]) => ({ date, cost_usd })).sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}
