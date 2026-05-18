/**
 * Credential vault — thin wrapper around the pgcrypto-backed Postgres
 * functions `crm_integration_store_credentials` / `_read_credentials`.
 *
 * The ciphertext (bytea) never leaves Postgres. Node only ever holds
 * plaintext (briefly, in-memory) or the row without credentials.
 *
 * Key: `INTEGRATION_VAULT_KEY` env var. If unset, store/read fail loudly
 * — we will not silently downgrade to plaintext-at-rest.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { logger } from '../../../lib/logger';

function getKey(): string {
  const key = process.env.INTEGRATION_VAULT_KEY;
  if (!key || key.length < 16) {
    throw new Error(
      'INTEGRATION_VAULT_KEY env var is missing or too short (need >=16 chars). ' +
      'Lead-source integration credentials cannot be stored.'
    );
  }
  return key;
}

export async function storeCredentials(integration_id: string, plaintext: object): Promise<void> {
  const { error } = await supabaseAdmin.rpc('crm_integration_store_credentials', {
    p_integration_id: integration_id,
    p_plaintext: JSON.stringify(plaintext),
    p_key: getKey(),
  });
  if (error) {
    logger.error({ integration_id, err: error.message }, 'storeCredentials failed');
    throw new Error(`Vault write failed: ${error.message}`);
  }
}

export async function readCredentials<T = Record<string, unknown>>(integration_id: string): Promise<T | null> {
  const { data, error } = await supabaseAdmin.rpc('crm_integration_read_credentials', {
    p_integration_id: integration_id,
    p_key: getKey(),
  });
  if (error) {
    logger.error({ integration_id, err: error.message }, 'readCredentials failed');
    throw new Error(`Vault read failed: ${error.message}`);
  }
  if (!data) return null;
  try { return JSON.parse(data as string) as T; }
  catch (e) {
    logger.error({ integration_id }, 'readCredentials: decrypted blob is not valid JSON');
    throw new Error('Vault read failed: corrupt ciphertext');
  }
}
