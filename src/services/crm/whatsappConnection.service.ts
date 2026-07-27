/**
 * Per-org WhatsApp Business connection (Phase 0). Stores how a tenant connects
 * (Cloud API or a BSP), encrypts the secrets (secretBox), and resolves the live
 * WhatsappProvider used by whatsapp.service. Also handles a connection test and
 * a Cloud-API template sync. Configured from Settings → WhatsApp (super-admin /
 * client-admin).
 */
import { supabaseAdmin } from '../../lib/supabase';
import { encryptSecret, decryptSecret } from '../../lib/secretBox';
import { logger } from '../../lib/logger';
import { stubWhatsappProvider } from './providers/stubWhatsapp.provider';
import { makeCloudApiProvider, GRAPH_VERSION } from './providers/cloudApiWhatsapp.provider';
import { makeBspProvider } from './providers/bspWhatsapp.provider';
import type { WhatsappProvider } from './providers/whatsappProvider.interface';

const DEFAULT_PURPOSES = ['whatsapp', 'marketing'];
const TABLE = 'crm_whatsapp_connections';

interface Row {
  org_id: string;
  connection_type: 'cloud_api' | 'bsp';
  bsp_name: string | null;
  phone_number_id: string | null;
  waba_id: string | null;
  from_phone: string | null;
  display_name: string | null;
  bsp_base_url: string | null;
  access_token_enc: string | null;
  bsp_api_key_enc: string | null;
  opt_in_purposes: string[] | null;
  is_active: boolean;
  verify_status: string | null;
  last_verified_at: string | null;
}

interface FullConnection extends Omit<Row, 'access_token_enc' | 'bsp_api_key_enc'> {
  access_token: string | null;
  bsp_api_key: string | null;
}

/** Load the org's connection with decrypted secrets. Returns null if none / on error. */
async function loadFull(org_id: string): Promise<FullConnection | null> {
  try {
    const { data, error } = await supabaseAdmin.from(TABLE).select('*').eq('org_id', org_id).maybeSingle();
    if (error || !data) return null;
    const r = data as unknown as Row;
    return {
      org_id: r.org_id,
      connection_type: r.connection_type,
      bsp_name: r.bsp_name,
      phone_number_id: r.phone_number_id,
      waba_id: r.waba_id,
      from_phone: r.from_phone,
      display_name: r.display_name,
      bsp_base_url: r.bsp_base_url,
      opt_in_purposes: r.opt_in_purposes?.length ? r.opt_in_purposes : DEFAULT_PURPOSES,
      is_active: r.is_active,
      verify_status: r.verify_status,
      last_verified_at: r.last_verified_at,
      access_token: decryptSecret(r.access_token_enc),
      bsp_api_key: decryptSecret(r.bsp_api_key_enc),
    };
  } catch {
    return null; // e.g. table absent on a tenant that hasn't been provisioned yet
  }
}

/** Public config for the settings UI — secrets redacted to booleans. */
export async function getConnection(org_id: string) {
  const c = await loadFull(org_id);
  if (!c) return null;
  return {
    connection_type: c.connection_type,
    bsp_name: c.bsp_name,
    phone_number_id: c.phone_number_id,
    waba_id: c.waba_id,
    from_phone: c.from_phone,
    display_name: c.display_name,
    bsp_base_url: c.bsp_base_url,
    opt_in_purposes: c.opt_in_purposes,
    is_active: c.is_active,
    verify_status: c.verify_status,
    last_verified_at: c.last_verified_at,
    has_access_token: !!c.access_token,
    has_bsp_api_key: !!c.bsp_api_key,
  };
}

export interface UpsertConnectionInput {
  connection_type: 'cloud_api' | 'bsp';
  bsp_name?: string | null;
  phone_number_id?: string | null;
  waba_id?: string | null;
  from_phone?: string | null;
  display_name?: string | null;
  bsp_base_url?: string | null;
  access_token?: string | null;   // plaintext; re-encrypted only when provided
  bsp_api_key?: string | null;    // plaintext; re-encrypted only when provided
  opt_in_purposes?: string[];
  is_active?: boolean;
  updated_by?: string | null;
}

export async function upsertConnection(org_id: string, input: UpsertConnectionInput) {
  const { data: existing } = await supabaseAdmin.from(TABLE)
    .select('access_token_enc, bsp_api_key_enc').eq('org_id', org_id).maybeSingle();

  const row: Record<string, unknown> = {
    org_id,
    connection_type: input.connection_type,
    bsp_name: input.bsp_name ?? null,
    phone_number_id: input.phone_number_id ?? null,
    waba_id: input.waba_id ?? null,
    from_phone: input.from_phone ?? null,
    display_name: input.display_name ?? null,
    bsp_base_url: input.bsp_base_url ?? null,
    opt_in_purposes: input.opt_in_purposes?.length ? input.opt_in_purposes : DEFAULT_PURPOSES,
    is_active: input.is_active ?? true,
    updated_by: input.updated_by ?? null,
    updated_at: new Date().toISOString(),
    verify_status: null, // config changed → require a re-test
  };
  // Preserve stored secrets unless a fresh value is supplied.
  row.access_token_enc = input.access_token ? encryptSecret(input.access_token) : (existing?.access_token_enc ?? null);
  row.bsp_api_key_enc = input.bsp_api_key ? encryptSecret(input.bsp_api_key) : (existing?.bsp_api_key_enc ?? null);

  const { error } = await supabaseAdmin.from(TABLE).upsert(row, { onConflict: 'org_id' });
  if (error) throw new Error(error.message);
  return getConnection(org_id);
}

/** The live provider for this org, or the stub when unconfigured/inactive/broken. */
export async function resolveWhatsappProvider(org_id: string): Promise<WhatsappProvider> {
  const c = await loadFull(org_id);
  if (!c || !c.is_active) return stubWhatsappProvider;
  try {
    if (c.connection_type === 'cloud_api' && c.phone_number_id && c.access_token) {
      return makeCloudApiProvider({ phoneNumberId: c.phone_number_id, accessToken: c.access_token, name: 'whatsapp_cloud' });
    }
    if (c.connection_type === 'bsp' && c.bsp_base_url && c.bsp_api_key) {
      return makeBspProvider({ baseUrl: c.bsp_base_url, apiKey: c.bsp_api_key, name: `whatsapp_bsp:${c.bsp_name || 'generic'}` });
    }
  } catch (e: any) {
    logger.warn(`[whatsapp] provider build failed org=${org_id}: ${e?.message || e}`);
  }
  return stubWhatsappProvider;
}

/** The configured "from" number for this org (falls back to the env default at the call site). */
export async function fromPhoneFor(org_id: string): Promise<string | null> {
  return (await loadFull(org_id))?.from_phone ?? null;
}

/** Consent purposes that count as WhatsApp opt-in for this org (defaults to whatsapp/marketing). */
export async function optInPurposes(org_id: string): Promise<string[]> {
  return (await loadFull(org_id))?.opt_in_purposes ?? DEFAULT_PURPOSES;
}

async function markVerify(org_id: string, status: string) {
  await supabaseAdmin.from(TABLE).update({ verify_status: status, last_verified_at: new Date().toISOString() }).eq('org_id', org_id);
}

/** Validate the saved credentials against the provider. */
export async function testConnection(org_id: string): Promise<{ ok: boolean; detail?: string }> {
  const c = await loadFull(org_id);
  if (!c) return { ok: false, detail: 'No WhatsApp connection configured yet.' };
  try {
    if (c.connection_type === 'cloud_api') {
      if (!c.phone_number_id || !c.access_token) return { ok: false, detail: 'Missing Phone Number ID or access token.' };
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${c.phone_number_id}?fields=verified_name,display_phone_number`, {
        headers: { Authorization: `Bearer ${c.access_token}` },
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) { await markVerify(org_id, 'failed'); return { ok: false, detail: json?.error?.message || `HTTP ${res.status}` }; }
      await markVerify(org_id, 'ok');
      return { ok: true, detail: json?.display_phone_number ? `Connected: ${json.verified_name} (${json.display_phone_number})` : 'Connected.' };
    }
    // BSP: credentials vary too much to health-check generically; a live send confirms it.
    if (!c.bsp_base_url || !c.bsp_api_key) return { ok: false, detail: 'Missing BSP base URL or API key.' };
    await markVerify(org_id, 'unknown');
    return { ok: true, detail: 'BSP credentials saved. A test send will confirm reachability.' };
  } catch (e: any) {
    await markVerify(org_id, 'failed');
    return { ok: false, detail: e?.message || 'Connection test failed.' };
  }
}

/** Pull approved templates from the Cloud API into crm_whatsapp_templates. */
export async function syncTemplates(org_id: string): Promise<{ synced: number }> {
  const c = await loadFull(org_id);
  if (!c) throw new Error('No WhatsApp connection configured.');
  if (c.connection_type !== 'cloud_api' || !c.waba_id || !c.access_token) {
    throw new Error('Template sync needs a Cloud API connection with a WABA ID + access token.');
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${c.waba_id}/message_templates?limit=200`, {
    headers: { Authorization: `Bearer ${c.access_token}` },
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  const templates: any[] = Array.isArray(json?.data) ? json.data : [];

  let synced = 0;
  for (const t of templates) {
    const comps: any[] = Array.isArray(t.components) ? t.components : [];
    const bodyC = comps.find((x) => x.type === 'BODY');
    const headerC = comps.find((x) => x.type === 'HEADER');
    const footerC = comps.find((x) => x.type === 'FOOTER');
    const row = {
      org_id,
      meta_template_name: String(t.name),
      category: String(t.category || 'UTILITY'),
      language: String(t.language || 'en'),
      status: String(t.status || 'APPROVED'),
      body_text: String(bodyC?.text || ''),
      header_text: headerC?.format === 'TEXT' ? (headerC?.text ?? null) : null,
      footer_text: footerC?.text ?? null,
      provider_template_id: t.id ? String(t.id) : null,
      updated_at: new Date().toISOString(),
    };
    const { data: existing } = await supabaseAdmin.from('crm_whatsapp_templates')
      .select('id').eq('org_id', org_id).eq('meta_template_name', row.meta_template_name)
      .eq('language', row.language).is('deleted_at', null).maybeSingle();
    const w = existing?.id
      ? await supabaseAdmin.from('crm_whatsapp_templates').update(row).eq('id', existing.id)
      : await supabaseAdmin.from('crm_whatsapp_templates').insert(row);
    if (!w.error) synced++;
  }
  return { synced };
}
