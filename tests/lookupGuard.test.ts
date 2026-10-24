import {
  _resetOfferedLookupCache,
  isLookupTargetAllowed,
  isSensitiveColumn,
  isSensitiveTable,
  offeredLookupTables,
  stripSensitiveColumns,
} from '../src/lib/lookupGuard';

const curated = new Set(['crm_leads', 'crm_contacts', 'crm_accounts', 'crm_deals', 'people_directory', 'crm_blocks']);

describe('isLookupTargetAllowed', () => {
  const offered = new Set(['crm_products', 'crm_territories', 'crm_integrations', 'user_sessions', 'whatsapp_connections']);

  it('always allows the curated tables', () => {
    for (const t of curated) expect(isLookupTargetAllowed(t, curated, new Set())).toBe(true);
  });

  it('allows an offered table', () => {
    expect(isLookupTargetAllowed('crm_products', curated, offered)).toBe(true);
    expect(isLookupTargetAllowed('crm_territories', curated, offered)).toBe(true);
  });

  it('refuses a table the picker never offered', () => {
    expect(isLookupTargetAllowed('users', curated, offered)).toBe(false);
    expect(isLookupTargetAllowed('organizations', curated, offered)).toBe(false);
    expect(isLookupTargetAllowed('crm_leads_archive', curated, offered)).toBe(false);
  });

  it('refuses credential-style tables even when the catalogue lists them', () => {
    for (const t of ['crm_integrations', 'user_sessions', 'whatsapp_connections']) {
      expect(isLookupTargetAllowed(t, curated, offered)).toBe(false);
    }
  });

  it('refuses everything uncurated when the catalogue could not be loaded', () => {
    expect(isLookupTargetAllowed('crm_products', curated, new Set())).toBe(false);
    expect(isLookupTargetAllowed('crm_leads', curated, new Set())).toBe(true);
  });
});

describe('sensitive names', () => {
  it.each(['password_hash', 'api_key', 'apikey', 'access_token', 'refresh_token', 'client_secret', 'fcm_token',
    'apns_token', 'webhook_url', 'signature', 'session_id', 'otp', 'login_otp', 'encrypted_payload'])('%s is a sensitive column', (c) => {
    expect(isSensitiveColumn(c)).toBe(true);
  });

  it.each(['first_name', 'email', 'mobile', 'pin_code', 'city', 'footprint', 'district', 'custom_fields', 'owner_id'])('%s is not', (c) => {
    expect(isSensitiveColumn(c)).toBe(false);
  });

  it('flags credential tables', () => {
    for (const t of ['crm_integrations', 'integration_credentials', 'oauth_tokens', 'api_keys', 'audit_log']) expect(isSensitiveTable(t)).toBe(true);
    for (const t of ['crm_leads', 'crm_products', 'crm_territories']) expect(isSensitiveTable(t)).toBe(false);
  });
});

describe('stripSensitiveColumns', () => {
  it('drops credential-like keys and keeps the rest', () => {
    const row = { id: 'x', first_name: 'A', pin_code: '110001', access_token: 't', password_hash: 'h', custom_fields: { a: 1 } };
    expect(stripSensitiveColumns(row)).toEqual({ id: 'x', first_name: 'A', pin_code: '110001', custom_fields: { a: 1 } });
  });
});

describe('offeredLookupTables cache', () => {
  beforeEach(_resetOfferedLookupCache);

  it('loads once per project inside the TTL and again after it', async () => {
    const load = jest.fn(async () => [{ table_name: 'crm_products' }]);
    const a = await offeredLookupTables('default', load, 1_000);
    const b = await offeredLookupTables('default', load, 2_000);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
    await offeredLookupTables('default', load, 1_000 + 6 * 60_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps projects apart', async () => {
    const a = await offeredLookupTables('default', async () => [{ table_name: 'a' }], 1);
    const b = await offeredLookupTables('kinematic', async () => [{ table_name: 'b' }], 1);
    expect(a.has('a')).toBe(true);
    expect(b.has('a')).toBe(false);
  });

  it('does not cache a failed load', async () => {
    await expect(offeredLookupTables('default', async () => { throw new Error('boom'); }, 1)).rejects.toThrow('boom');
    const ok = await offeredLookupTables('default', async () => [{ table_name: 'crm_products' }], 2);
    expect(ok.has('crm_products')).toBe(true);
  });
});
