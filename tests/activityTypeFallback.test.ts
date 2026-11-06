/** A custom activity type must save even while the database still has the 7-type CHECK constraint. */
jest.mock('../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
import { AppError } from '../src/utils';
import { contactSchema } from '../src/validators/crm.validators';
import { writeActivityResilient, restoreCarrierType, withCarrierType, violatesTypeCheck } from '../src/services/crm/activityTypeFallback';

const typeCheck = () => new AppError(500, 'new row for relation "crm_activities" violates check constraint "crm_activities_type_check"', 'DB_ERROR');

describe('writeActivityResilient', () => {
  it('saves a built-in type untouched', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await writeActivityResilient({ type: 'call', subject: 's' }, async (p) => { seen.push(p); return 1; });
    expect(seen).toEqual([{ type: 'call', subject: 's' }]);
  });
  it('retries a rejected custom type under a carrier type and keeps the real one in metadata', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const r = await writeActivityResilient({ type: 'quotation_request', subject: 's', metadata: { a: 1 } }, async (p) => {
      seen.push(p);
      if (p.type === 'quotation_request') throw typeCheck();
      return 'saved';
    });
    expect(r).toBe('saved');
    expect(seen[1]).toEqual({ type: 'note', subject: 's', metadata: { a: 1, activity_type: 'quotation_request' } });
  });
  it('lets any other error through, and a built-in type that fails is not retried', async () => {
    await expect(writeActivityResilient({ type: 'x' }, async () => { throw new AppError(500, 'boom', 'DB_ERROR'); })).rejects.toThrow('boom');
    let calls = 0;
    await expect(writeActivityResilient({ type: 'call' }, async () => { calls++; throw typeCheck(); })).rejects.toThrow('crm_activities_type_check');
    expect(calls).toBe(1);
  });
  it('recognises the constraint error', () => {
    expect(violatesTypeCheck(typeCheck())).toBe(true);
    expect(violatesTypeCheck(new AppError(500, 'other', 'DB_ERROR'))).toBe(false);
  });
});

describe('restoreCarrierType', () => {
  it('shows the real type again, and leaves ordinary rows alone', () => {
    expect(restoreCarrierType(withCarrierType({ type: 'site_visit' }) as Record<string, unknown>).type).toBe('site_visit');
    expect(restoreCarrierType({ type: 'note', metadata: { other: 1 } }).type).toBe('note');
    expect(restoreCarrierType({ type: 'call', metadata: { activity_type: 'x' } }).type).toBe('call');
    expect(restoreCarrierType({ type: 'note' }).type).toBe('note');
  });
});

describe('contactSchema city', () => {
  it('accepts null on update (an existing contact with no city) but not a blank string', () => {
    expect(contactSchema.partial().safeParse({ first_name: 'R', city: null }).success).toBe(true);
    expect(contactSchema.partial().safeParse({ city: '' }).success).toBe(false);
    expect(contactSchema.partial().safeParse({ city: 'Siliguri' }).success).toBe(true);
  });
});
