import { pickCompany } from '../src/lib/companyPick';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

describe('pickCompany', () => {
  const rep = { id: 'u1', client_id: A, company_client_ids: [A, B, C] };

  it('switches to an allowed company', () => {
    expect(pickCompany(rep, B).client_id).toBe(B);
    expect(pickCompany(rep, B.toUpperCase()).client_id).toBe(B);
  });

  it('never mutates the cached user', () => {
    pickCompany(rep, C);
    expect(rep.client_id).toBe(A);
  });

  it('ignores a company the user was not given', () => {
    expect(pickCompany(rep, OTHER)).toBe(rep);
  });

  it('ignores junk and missing headers', () => {
    expect(pickCompany(rep, undefined)).toBe(rep);
    expect(pickCompany(rep, 'not-a-uuid')).toBe(rep);
    expect(pickCompany(rep, '')).toBe(rep);
  });

  it('uses the first value of a repeated header', () => {
    expect(pickCompany(rep, [B, C]).client_id).toBe(B);
  });

  it('is a no-op for users with no assigned companies', () => {
    const plain = { id: 'u2', client_id: A };
    expect(pickCompany(plain, B)).toBe(plain);
    expect(pickCompany({ ...plain, company_client_ids: [] }, B).client_id).toBe(A);
  });
});
