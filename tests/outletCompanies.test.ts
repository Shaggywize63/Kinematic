import { outletClientIds } from '../src/lib/tenancy';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const req = (ids?: string[]) => ({ user: { company_client_ids: ids }, headers: {} }) as any;

describe('outletClientIds', () => {
  it('returns every assigned company so outlets are shared across them', () => {
    expect(outletClientIds(req([A, B]))).toEqual([A, B]);
  });
  it('is null for users without assigned companies (single-client scope unchanged)', () => {
    expect(outletClientIds(req(undefined))).toBeNull();
    expect(outletClientIds(req([]))).toBeNull();
  });
  it('drops values that are not UUIDs so they can never reach a query', () => {
    expect(outletClientIds(req([A, 'x),client_id.not.is.null,(y']))).toEqual([A]);
    expect(outletClientIds(req(['nope']))).toBeNull();
  });
});
