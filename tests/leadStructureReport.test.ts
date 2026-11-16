import { computeLeadStructureReport, type ReportInput } from '../src/services/crm/leadStructureReport.service';

/**
 * Guards the Spark & Ray lead-structure roll-up: counts by group / company / plant
 * / make / product, distinct-lead counts and quantity totals on product lines, and
 * the drill-down filters (group / make / product).
 */
const INPUT: ReportInput = {
  // 3 NINL leads + 1 TSK lead, both under the Tata Steel group; 1 standalone NTPC lead.
  leads: [
    { id: 'L1', account_id: 'ninl', site_id: 'pellet' },
    { id: 'L2', account_id: 'ninl', site_id: 'pellet' },
    { id: 'L3', account_id: 'ninl', site_id: 'sinter' },
    { id: 'L4', account_id: 'tsk', site_id: null },
    { id: 'L5', account_id: 'ntpc', site_id: null },
  ],
  accounts: [
    { id: 'ninl', name: 'Neelachal Ispat Nigam Limited', parent_account_id: 'tatasteel' },
    { id: 'tsk', name: 'Tata Steel Kalinganagar', parent_account_id: 'tatasteel' },
    { id: 'ntpc', name: 'NTPC Limited', parent_account_id: null },
  ],
  groups: [{ id: 'tatasteel', name: 'Tata Steel Limited' }],
  sites: [{ id: 'pellet', name: 'Pellet Plant' }, { id: 'sinter', name: 'Sinter Plant' }],
  lines: [
    { lead_id: 'L1', make_id: 'mac', make_name: 'MAC', product_id: 'pv12', product_name: 'PV12', qty: 12 },
    { lead_id: 'L1', make_id: 'mac', make_name: 'MAC', product_id: 'dk200', product_name: 'DK-200', qty: 50 },
    { lead_id: 'L2', make_id: 'mac', make_name: 'MAC', product_id: 'pv12', product_name: 'PV12', qty: 8 },
    { lead_id: 'L3', make_id: 'rotork', make_name: 'Rotork', product_id: 'iq3', product_name: 'IQ3', qty: 6 },
  ],
};

const find = (rows: { id: string | null; name: string }[], id: string) => rows.find((r) => r.id === id);

describe('computeLeadStructureReport', () => {
  it('rolls up leads by group, company and plant', () => {
    const r = computeLeadStructureReport(INPUT);
    expect(r.total_leads).toBe(5);
    // Tata Steel group = NINL(3) + TSK(1) = 4; NTPC has no group.
    expect(find(r.by_group, 'tatasteel')?.lead_count).toBe(4);
    expect(r.by_group.find((g) => g.id === null)?.lead_count).toBe(1); // NTPC, "No group"
    expect(find(r.by_company, 'ninl')?.lead_count).toBe(3);
    expect(find(r.by_company, 'tsk')?.lead_count).toBe(1);
    expect(find(r.by_plant, 'pellet')?.lead_count).toBe(2);
    expect(find(r.by_plant, 'sinter')?.lead_count).toBe(1);
    expect(r.by_plant.find((p) => p.id === null)?.lead_count).toBe(2); // L4 + L5, "No plant"
  });

  it('counts distinct leads and total quantity per make / product', () => {
    const r = computeLeadStructureReport(INPUT);
    // MAC appears on L1 (twice) and L2 → 2 distinct leads; qty 12+50+8 = 70.
    expect(find(r.by_make, 'mac')).toMatchObject({ lead_count: 2, qty_total: 70 });
    expect(find(r.by_make, 'rotork')).toMatchObject({ lead_count: 1, qty_total: 6 });
    // PV12 on L1 + L2 → 2 leads, qty 20; DK-200 on L1 → 1 lead, qty 50.
    expect(find(r.by_product, 'pv12')).toMatchObject({ lead_count: 2, qty_total: 20 });
    expect(find(r.by_product, 'dk200')).toMatchObject({ lead_count: 1, qty_total: 50 });
  });

  it('drills down by group', () => {
    const r = computeLeadStructureReport(INPUT, { group_id: 'tatasteel' });
    expect(r.total_leads).toBe(4); // NINL(3) + TSK(1), NTPC excluded
    expect(find(r.by_company, 'ntpc')).toBeUndefined();
  });

  it('drills down by make — leads and their lines restricted to that make', () => {
    const r = computeLeadStructureReport(INPUT, { make_id: 'mac' });
    expect(r.total_leads).toBe(2); // only L1, L2 carry a MAC line
    expect(find(r.by_make, 'rotork')).toBeUndefined();
    expect(find(r.by_product, 'pv12')?.lead_count).toBe(2);
  });

  it('drills down by product', () => {
    const r = computeLeadStructureReport(INPUT, { product_id: 'dk200' });
    expect(r.total_leads).toBe(1); // only L1
    expect(find(r.by_company, 'ninl')?.lead_count).toBe(1);
  });
});
