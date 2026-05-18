/**
 * Distribution credential vault — thin wrapper around the existing CRM
 * pgcrypto-backed Postgres functions. No new SECURITY DEFINER functions
 * needed; same vault layer serves both modules.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

function getKey(): string {
  const key = process.env.INTEGRATION_VAULT_KEY;
  if (!key || key.length < 16) {
    throw new Error(
      'INTEGRATION_VAULT_KEY env var is missing or too short (need >=16 chars). ' +
      'Distribution integration credentials cannot be stored.'
    );
  }
  return key;
}

/**
 * Encrypts the JSON-stringified plaintext and writes it onto
 * distribution_integrations.credentials_encrypted. Uses the SAME
 * Postgres function CRM uses — the function is integration-agnostic,
 * just stores the bytea on whichever crm_lead_source_integrations or
 * distribution_integrations row matches the id.
 *
 * v1 limitation: the existing crm_integration_store_credentials function
 * is hardcoded to update crm_lead_source_integrations. To reuse it for
 * distribution, we'd need to either (a) create a parallel
 * dist_integration_store_credentials, or (b) refactor the existing
 * function to take a table-name parameter. For now we go with (a) —
 * one new pair of functions, same pgcrypto + key.
 *
 * Migration `dist_integration_credential_vault` (applied separately)
 * creates `dist_integration_store_credentials(uuid, text, text)` and
 * `dist_integration_read_credentials(uuid, text)` returning text, both
 * scoped to the distribution_integrations table.
 */
export async function storeCredentials(integration_id: string, plaintext: object): Promise<void> {
  const { error } = await supabaseAdmin.rpc('dist_integration_store_credentials', {
    p_integration_id: integration_id,
    p_plaintext: JSON.stringify(plaintext),
    p_key: getKey(),
  });
  if (error) {
    logger.error({ integration_id, err: error.message }, 'dist storeCredentials failed');
    throw new Error(`Vault write failed: ${error.message}`);
  }
}

export async function readCredentials<T = Record<string, unknown>>(integration_id: string): Promise<T | null> {
  const { data, error } = await supabaseAdmin.rpc('dist_integration_read_credentials', {
    p_integration_id: integration_id,
    p_key: getKey(),
  });
  if (error) {
    logger.error({ integration_id, err: error.message }, 'dist readCredentials failed');
    throw new Error(`Vault read failed: ${error.message}`);
  }
  if (!data) return null;
  try { return JSON.parse(data as string) as T; }
  catch {
    logger.error({ integration_id }, 'dist readCredentials: decrypted blob is not valid JSON');
    throw new Error('Vault read failed: corrupt ciphertext');
  }
}
