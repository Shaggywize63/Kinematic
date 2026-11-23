/**
 * Client documents (client_documents): the metadata layer linking an already-uploaded object
 * (POST /api/v1/upload/material) to a `clients` row — Client Management → Documents, platform-admin-only.
 * list / create / soft-delete, and a database without the migration answers NOT_MIGRATED instead of a
 * raw 500 — same pattern as makesBrands.service.ts / accountDocuments.service.ts.
 */
const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
let nextResult: { data: unknown; error: { code?: string; message?: string } | null } = { data: null, error: null };

jest.mock('../src/lib/supabase', () => {
  const chain: any = {};
  for (const m of ['select', 'eq', 'is', 'order', 'insert', 'update']) {
    chain[m] = jest.fn((...a: unknown[]) => { calls.push({ table: chain.__table, method: m, args: a }); return chain; });
  }
  chain.single = jest.fn(() => { calls.push({ table: chain.__table, method: 'single', args: [] }); return Promise.resolve(nextResult); });
  chain.maybeSingle = jest.fn(() => { calls.push({ table: chain.__table, method: 'maybeSingle', args: [] }); return Promise.resolve(nextResult); });
  chain.then = (resolve: (v: unknown) => void) => resolve(nextResult);
  return {
    supabaseAdmin: {
      from: jest.fn((table: string) => { chain.__table = table; return chain; }),
    },
  };
});

import {
  listClientDocuments, createClientDocument, deleteClientDocument, NOT_MIGRATED_MESSAGE,
} from '../src/services/clientDocuments.service';

const CLIENT = 'c1c1c1c1-1111-4111-8111-111111111111';
const ORG = '7c022ef5-f07d-449d-8970-7067a0b8d4e4';

beforeEach(() => { calls.length = 0; nextResult = { data: null, error: null }; });

describe('listClientDocuments', () => {
  it('scopes to client_id and excludes soft-deleted rows', async () => {
    const rows = [{ id: 'd1', name: 'Price list' }];
    nextResult = { data: rows, error: null };
    const result = await listClientDocuments(CLIENT);
    expect(result).toEqual(rows);
    expect(calls).toEqual(expect.arrayContaining([
      { table: 'client_documents', method: 'eq', args: ['client_id', CLIENT] },
      { table: 'client_documents', method: 'is', args: ['deleted_at', null] },
    ]));
  });

  it('maps a missing-table error to NOT_MIGRATED (503)', async () => {
    nextResult = { data: null, error: { code: '42P01', message: 'relation "client_documents" does not exist' } };
    await expect(listClientDocuments(CLIENT)).rejects.toMatchObject({ statusCode: 503, message: NOT_MIGRATED_MESSAGE });
  });
});

describe('createClientDocument', () => {
  it('inserts the full row, defaulting unset optional fields to null', async () => {
    nextResult = { data: { id: 'd1' }, error: null };
    await createClientDocument({
      clientId: CLIENT, orgId: ORG, uploadedBy: 'u1',
      name: 'Price list', fileName: 'price-list.pdf', bucket: 'kinematic-materials',
      path: `${ORG}/u1/abc.pdf`,
    });
    const insert = calls.find((c) => c.method === 'insert')!;
    expect(insert.args[0]).toEqual({
      client_id: CLIENT, org_id: ORG, name: 'Price list', file_name: 'price-list.pdf',
      content_type: null, size_bytes: null, bucket: 'kinematic-materials', path: `${ORG}/u1/abc.pdf`, uploaded_by: 'u1',
    });
  });
});

describe('deleteClientDocument', () => {
  it('soft-deletes (sets deleted_at) scoped to client_id + id', async () => {
    nextResult = { data: { id: 'd1' }, error: null };
    await deleteClientDocument(CLIENT, 'd1');
    const update = calls.find((c) => c.method === 'update')!;
    expect(update.args[0]).toMatchObject({ deleted_at: expect.any(String) });
    expect(calls).toEqual(expect.arrayContaining([
      { table: 'client_documents', method: 'eq', args: ['client_id', CLIENT] },
      { table: 'client_documents', method: 'eq', args: ['id', 'd1'] },
    ]));
  });

  it('404s when the document is already gone', async () => {
    nextResult = { data: null, error: null };
    await expect(deleteClientDocument(CLIENT, 'missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});
