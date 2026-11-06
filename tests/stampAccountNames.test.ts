const mockIn = jest.fn();
jest.mock('../src/lib/supabase', () => ({
  supabaseAdmin: { from: jest.fn(() => ({ select: jest.fn(() => ({ in: mockIn })) })) },
}));

import { stampAccountNames, stampAccountName } from '../src/services/crm/owners.helper';

describe('stampAccountNames', () => {
  beforeEach(() => mockIn.mockReset());

  it('adds the company name to contacts that have an account_id', async () => {
    mockIn.mockResolvedValue({ data: [{ id: 'a1', name: 'Chanda Enterprises' }], error: null });
    const rows = await stampAccountNames([{ id: 'c1', account_id: 'a1' }, { id: 'c2', account_id: null }]);
    expect(rows[0].account_name).toBe('Chanda Enterprises');
    expect(rows[1].account_name).toBeNull();
    expect(mockIn).toHaveBeenCalledTimes(1);
  });

  it('does not query when no contact has an account', async () => {
    const rows = await stampAccountNames([{ id: 'c2', account_id: null }]);
    expect(rows).toHaveLength(1);
    expect(mockIn).not.toHaveBeenCalled();
  });

  it('leaves rows unchanged when the lookup fails', async () => {
    mockIn.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const input = [{ id: 'c1', account_id: 'a1' }];
    expect(await stampAccountNames(input)).toEqual(input);
  });

  it('single-row helper tolerates null', async () => {
    expect(await stampAccountName(null)).toBeNull();
  });
});
