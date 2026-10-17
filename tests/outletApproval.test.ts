import {
  needsApproval, canApprove, stripApprovalFields, parseNewOutlet, newOutletCode,
} from '../src/services/outletApproval';

describe('who needs approval / who approves', () => {
  it('field reps need approval; managers and admins do not', () => {
    expect(needsApproval('executive')).toBe(true);
    expect(needsApproval('Field_Executive')).toBe(true);
    for (const r of ['admin', 'super_admin', 'city_manager', 'supervisor', 'hr', undefined, null]) {
      expect(needsApproval(r as any)).toBe(false);
    }
  });

  it('only managers and admins approve', () => {
    for (const r of ['super_admin', 'admin', 'main_admin', 'sub_admin', 'CITY_MANAGER']) expect(canApprove(r)).toBe(true);
    for (const r of ['executive', 'field_executive', 'supervisor', 'client', undefined]) expect(canApprove(r as any)).toBe(false);
  });
});

describe('stripApprovalFields', () => {
  it('removes everything only the approval flow may write and keeps the rest', () => {
    const out = stripApprovalFields({
      name: 'X', phone: '1', approval_status: 'approved', created_by: 'u', approved_by: 'u', approved_at: 't', rejection_reason: 'r',
    });
    expect(out).toEqual({ name: 'X', phone: '1' });
  });
});

describe('parseNewOutlet', () => {
  const good = { name: '  Mapusa Mini Mart ', owner_name: 'R. Naik', phone: '+91 98220 12345', address: 'Market Rd', lat: 15.59, lng: 73.81, store_type: 'On-Trade' };

  it('accepts a complete outlet and cleans it', () => {
    const r = parseNewOutlet(good) as any;
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ name: 'Mapusa Mini Mart', store_type: 'on_trade', lat: 15.59, lng: 73.81, city_id: null });
  });

  it('needs a name', () => {
    expect((parseNewOutlet({ ...good, name: '  ' }) as any).error).toMatch(/name/i);
    expect((parseNewOutlet(undefined) as any).ok).toBe(false);
  });

  it('wants both coordinates or neither, in range', () => {
    expect((parseNewOutlet({ ...good, lng: undefined }) as any).error).toMatch(/both/i);
    expect((parseNewOutlet({ ...good, lat: 95 }) as any).error).toMatch(/range/i);
    expect((parseNewOutlet({ ...good, lat: 'abc' }) as any).error).toMatch(/numbers/i);
    expect((parseNewOutlet({ name: 'A' }) as any).ok).toBe(true);
  });

  it('only on_trade / off_trade, a plausible phone, real UUIDs', () => {
    expect((parseNewOutlet({ ...good, store_type: 'wholesale' }) as any).error).toMatch(/on_trade/);
    expect((parseNewOutlet({ ...good, phone: 'call me' }) as any).error).toMatch(/phone/i);
    expect((parseNewOutlet({ ...good, city_id: 'x),is_active.eq.false' }) as any).error).toMatch(/city/i);
    expect((parseNewOutlet({ ...good, store_type: 'off trade' }) as any).value.store_type).toBe('off_trade');
  });

  it('ignores anything that is not an outlet field', () => {
    const r = parseNewOutlet({ ...good, id: 'x', client_id: 'y', approval_status: 'approved', org_id: 'z' }) as any;
    expect(Object.keys(r.value).sort()).toEqual(['address', 'city_id', 'lat', 'lng', 'name', 'owner_name', 'phone', 'store_type', 'zone_id']);
  });
});

describe('newOutletCode', () => {
  it('is OUT- plus six unambiguous characters', () => {
    for (let i = 0; i < 50; i++) expect(newOutletCode()).toMatch(/^OUT-[A-HJKMNP-Z2-9]{6}$/);
  });
  it('is driven by the random source', () => {
    expect(newOutletCode(() => 0)).toBe('OUT-AAAAAA');
  });
});
