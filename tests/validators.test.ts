/**
 * Unit tests for the CRM Zod validators (src/validators/crm.validators.ts).
 *
 * These schemas are the request-boundary contract every CRM write goes
 * through, and several encode hard-won product rules (a lead needs at least
 * one name part; Indian mobile must be exactly 10 digits; a deal auto-defaults
 * amount/currency; an activity must link to a parent entity). We lock those in.
 */
import {
  leadCreateSchema,
  leadUpdateSchema,
  dealSchema,
  contactSchema,
  accountSchema,
  activitySchema,
  activitySchemaBase,
} from '../src/validators/crm.validators';

describe('leadCreateSchema', () => {
  it('accepts a lead with only a first name', () => {
    const r = leadCreateSchema.safeParse({ first_name: 'Asha' });
    expect(r.success).toBe(true);
  });

  it('accepts a lead with only a last name', () => {
    expect(leadCreateSchema.safeParse({ last_name: 'Kumar' }).success).toBe(true);
  });

  it('rejects an entirely nameless lead', () => {
    const r = leadCreateSchema.safeParse({ email: 'x@y.com' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('last_name'))).toBe(true);
  });

  it('enforces a 10-digit phone', () => {
    expect(leadCreateSchema.safeParse({ first_name: 'A', phone: '9876543210' }).success).toBe(true);
    expect(leadCreateSchema.safeParse({ first_name: 'A', phone: '+91 98765 43210' }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ first_name: 'A', phone: '12345' }).success).toBe(false);
  });

  it('rejects an invalid email and out-of-range status', () => {
    expect(leadCreateSchema.safeParse({ first_name: 'A', email: 'nope' }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ first_name: 'A', status: 'converted' }).success).toBe(false); // create can't set converted
  });

  it('coerces numeric latitude/longitude and range-checks them', () => {
    const ok = leadCreateSchema.safeParse({ first_name: 'A', latitude: '12.9', longitude: '77.5' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.latitude).toBeCloseTo(12.9);
    expect(leadCreateSchema.safeParse({ first_name: 'A', latitude: 200 }).success).toBe(false);
  });
});

describe('leadUpdateSchema', () => {
  it('additionally allows converted / lost status and a null city', () => {
    expect(leadUpdateSchema.safeParse({ status: 'converted' }).success).toBe(true);
    expect(leadUpdateSchema.safeParse({ status: 'lost', city: null }).success).toBe(true);
  });
});

describe('dealSchema', () => {
  it('defaults amount to 0 and currency to INR', () => {
    const r = dealSchema.safeParse({ name: 'Big Deal' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.amount).toBe(0);
      expect(r.data.currency).toBe('INR');
    }
  });

  it('requires a name and rejects probability >= 100', () => {
    expect(dealSchema.safeParse({}).success).toBe(false);
    expect(dealSchema.safeParse({ name: 'X', probability: 100 }).success).toBe(false);
    expect(dealSchema.safeParse({ name: 'X', probability: 99 }).success).toBe(true);
  });
});

describe('contactSchema / accountSchema', () => {
  it('accounts require a non-empty name', () => {
    expect(accountSchema.safeParse({ name: '' }).success).toBe(false);
    expect(accountSchema.safeParse({ name: 'Acme' }).success).toBe(true);
  });

  it('contacts accept an optional loyalty tier enum but reject unknown tiers', () => {
    expect(contactSchema.safeParse({ first_name: 'A', loyalty_tier: 'gold' }).success).toBe(true);
    expect(contactSchema.safeParse({ first_name: 'A', loyalty_tier: 'diamond' }).success).toBe(false);
  });
});

describe('activitySchema', () => {
  it('requires the activity to be linked to a parent entity', () => {
    expect(activitySchema.safeParse({ type: 'call' }).success).toBe(false);
    expect(activitySchema.safeParse({ type: 'call', lead_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }).success).toBe(true);
  });

  it('base schema defaults status to completed and validates the type slug', () => {
    const r = activitySchemaBase.safeParse({ type: 'site_visit' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.status).toBe('completed');
    expect(activitySchemaBase.safeParse({ type: 'bad type!' }).success).toBe(false);
  });
});
