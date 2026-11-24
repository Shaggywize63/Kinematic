/**
 * Incentive accrual: what earns, what does not, how much, and the clawback.
 *
 * The rate is never hard-coded in the service, so every case here drives it from a rule row —
 * which is also the point: a client with no rule must accrue nothing at all.
 */
type Row = Record<string, any>;

const db: { rules: Row[]; entries: Row[]; insertError?: { code?: string; message: string } } = {
  rules: [], entries: [],
};

jest.mock('../src/lib/supabase', () => {
  // A thenable query builder covering exactly the shapes incentive.service uses.
  class Q implements PromiseLike<any> {
    private table: string;
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: any = null;
    private preds: Array<(r: Row) => boolean> = [];
    constructor(table: string) { this.table = table; }
    private rows(): Row[] { return this.table === 'incentive_rules' ? db.rules : db.entries; }
    select() { return this; }
    insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
    update(p: any) { this.op = 'update'; this.payload = p; return this; }
    eq(col: string, val: any) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
    is(col: string, val: any) { this.preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
    or(expr: string) {
      // Only `client_id.is.null,client_id.eq.<uuid>` is used.
      const m = /client_id\.eq\.([^,]+)/i.exec(expr);
      const id = m?.[1];
      this.preds.push((r) => r.client_id == null || (!!id && String(r.client_id) === id));
      return this;
    }
    limit() { return this; }
    private run() {
      if (this.op === 'insert') {
        if (db.insertError) return { data: null, error: db.insertError };
        const dup = db.entries.some((e) => e.order_id === this.payload.order_id);
        if (dup) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        db.entries.push({ id: `e${db.entries.length + 1}`, ...this.payload });
        return { data: null, error: null };
      }
      const hit = this.rows().filter((r) => this.preds.every((p) => p(r)));
      if (this.op === 'update') {
        hit.forEach((r) => Object.assign(r, this.payload));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      return { data: hit, error: null };
    }
    then(res: any, rej?: any) { return Promise.resolve(this.run()).then(res, rej); }
  }
  return { supabaseAdmin: { from: (t: string) => new Q(t) } };
});

import * as inc from '../src/services/distribution/incentive.service';

const ORG = 'org-1';
const CLIENT = 'client-1';
const REP = 'rep-1';

const rule = (over: Row = {}): Row => ({
  id: 'rule-1', org_id: ORG, client_id: CLIENT, name: 'Sales incentive',
  rate_pct: 2, basis: 'taxable_value', earn_on: 'approved', is_active: true, ...over,
});

const order = (over: Row = {}): any => ({
  id: 'ord-1', org_id: ORG, client_id: CLIENT, salesman_id: REP, status: 'approved',
  taxable_value: 23800, grand_total: 28084, ...over,
});

beforeEach(() => { db.rules = []; db.entries = []; db.insertError = undefined; });

describe('incentive accrual', () => {
  it('pays the configured rate on the net value when the order reaches the earning status', async () => {
    db.rules.push(rule());
    const r = await inc.accrueForOrder(order());
    expect(r).toEqual({ accrued: true, amount: 476 });            // 23,800 x 2%
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0]).toMatchObject({
      order_id: 'ord-1', salesman_id: REP, basis: 'taxable_value',
      basis_amount: 23800, rate_pct: 2, amount: 476, status: 'earned',
    });
  });

  it('a client with NO rule accrues nothing — the module is inert until configured', async () => {
    const r = await inc.accrueForOrder(order());
    expect(r).toEqual({ accrued: false, reason: 'no_rule' });
    expect(db.entries).toHaveLength(0);
  });

  it('does not pay before the order reaches the earning status', async () => {
    db.rules.push(rule({ earn_on: 'invoiced' }));
    expect(await inc.accrueForOrder(order({ status: 'approved' })))
      .toEqual({ accrued: false, reason: 'wrong_status' });
    expect(await inc.accrueForOrder(order({ status: 'invoiced' })))
      .toMatchObject({ accrued: true });
  });

  it('pays on the GST-inclusive total when the rule says so', async () => {
    db.rules.push(rule({ basis: 'grand_total' }));
    const r = await inc.accrueForOrder(order());
    expect(r).toEqual({ accrued: true, amount: 561.68 });          // 28,084 x 2%
  });

  it('honours a rate other than 2 — nothing is hard-coded', async () => {
    db.rules.push(rule({ rate_pct: 3.5 }));
    expect(await inc.accrueForOrder(order())).toEqual({ accrued: true, amount: 833 });
  });

  it('never pays the same order twice, however many times it is approved', async () => {
    db.rules.push(rule());
    expect(await inc.accrueForOrder(order())).toMatchObject({ accrued: true });
    expect(await inc.accrueForOrder(order())).toEqual({ accrued: false, reason: 'already_exists' });
    expect(db.entries).toHaveLength(1);
  });

  it('skips an order with no rep and one with no value', async () => {
    db.rules.push(rule());
    expect(await inc.accrueForOrder(order({ salesman_id: null })))
      .toEqual({ accrued: false, reason: 'no_salesman' });
    expect(await inc.accrueForOrder(order({ taxable_value: 0 })))
      .toEqual({ accrued: false, reason: 'zero_value' });
    expect(db.entries).toHaveLength(0);
  });

  it('rounds to paise', async () => {
    db.rules.push(rule());
    expect(await inc.accrueForOrder(order({ taxable_value: 1333.33 })))
      .toEqual({ accrued: true, amount: 26.67 });                 // 26.6666 -> 26.67
  });

  it('a client-specific rule beats an org-wide one', async () => {
    db.rules.push(rule({ id: 'org-rule', client_id: null, rate_pct: 1 }));
    db.rules.push(rule({ id: 'client-rule', client_id: CLIENT, rate_pct: 5 }));
    expect(await inc.accrueForOrder(order())).toEqual({ accrued: true, amount: 1190 });
  });

  it('reads the net or gross figure as the basis', () => {
    expect(inc.basisAmount(order(), 'taxable_value')).toBe(23800);
    expect(inc.basisAmount(order(), 'grand_total')).toBe(28084);
    expect(inc.basisAmount(order({ taxable_value: '23800.50' }), 'taxable_value')).toBe(23800.5);
  });
});

describe('incentive reversal', () => {
  it('reverses an earned entry when the order is cancelled, keeping it for the audit trail', async () => {
    db.rules.push(rule());
    await inc.accrueForOrder(order());
    expect(await inc.reverseForOrder('ord-1', 'Dealer backed out')).toBe(true);
    expect(db.entries[0]).toMatchObject({ status: 'reversed', reversal_reason: 'Dealer backed out' });
    expect(db.entries).toHaveLength(1);                            // reversed, never deleted
  });

  it('leaves an already-paid entry alone — a clawback after payout is a human decision', async () => {
    db.rules.push(rule());
    await inc.accrueForOrder(order());
    db.entries[0].status = 'paid';
    expect(await inc.reverseForOrder('ord-1', 'Order cancelled')).toBe(false);
    expect(db.entries[0].status).toBe('paid');
  });

  it('is a no-op for an order that never earned', async () => {
    expect(await inc.reverseForOrder('ord-never', 'Order cancelled')).toBe(false);
  });
});
