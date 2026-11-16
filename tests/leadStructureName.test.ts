import { buildLeadDisplayName, productLinesLabel } from '../src/services/crm/visitBridge.service';

/**
 * Guards the Spark & Ray lead-name format the client signed off on:
 *   Group – Company – City – State – Plant – Department – Person – Requirement – <products> – Owner
 * A single product line reads "Make – Product – Qty"; several collapse into one
 * "Make Product ×Qty; …" segment; every blank segment drops out.
 */
describe('buildLeadDisplayName', () => {
  const base = {
    group: 'Tata Steel Limited',
    company: 'Neelachal Ispat Nigam Limited',
    city: 'Jajpur',
    state: 'Odisha',
    plant: 'Pellet Plant',
    department: null as string | null,
    person: 'Prabhat Kumar',
    requirement: 'Requirement to Replace ASCO Pulse Valve with MAC Pulse Valves',
    owner: 'Pallab Mahatha',
  };

  it('formats the signed-off single-product example exactly', () => {
    const name = buildLeadDisplayName({
      ...base,
      productLines: [{ make_name: 'MAC', product_name: 'PV12', qty: 12, unit: 'Nos' }],
    });
    expect(name).toBe(
      'Tata Steel Limited – Neelachal Ispat Nigam Limited – Jajpur – Odisha – Pellet Plant – ' +
      'Prabhat Kumar – Requirement to Replace ASCO Pulse Valve with MAC Pulse Valves – MAC – PV12 – 12 Nos – Pallab Mahatha',
    );
  });

  it('collapses several product lines into one segment', () => {
    const name = buildLeadDisplayName({
      ...base,
      productLines: [
        { make_name: 'MAC', product_name: 'PV12', qty: 12, unit: 'Nos' },
        { make_name: 'MAC', product_name: 'DK-200', qty: 50, unit: 'Nos' },
      ],
    });
    expect(name).toContain('– MAC PV12 ×12; MAC DK-200 ×50 – Pallab Mahatha');
    // the single-line three-segment form must NOT appear when there are several
    expect(name).not.toContain('– PV12 – 12 Nos');
  });

  it('drops blank segments (no group, no department, no products yet)', () => {
    const name = buildLeadDisplayName({
      ...base,
      group: null,
      productLines: [],
    });
    expect(name).toBe(
      'Neelachal Ispat Nigam Limited – Jajpur – Odisha – Pellet Plant – ' +
      'Prabhat Kumar – Requirement to Replace ASCO Pulse Valve with MAC Pulse Valves – Pallab Mahatha',
    );
  });

  it('includes the department when present, between plant and person', () => {
    const name = buildLeadDisplayName({ ...base, department: 'Instrumentation', productLines: [] });
    expect(name).toContain('Pellet Plant – Instrumentation – Prabhat Kumar');
  });
});

describe('productLinesLabel', () => {
  it('returns three segments for a single line', () => {
    expect(productLinesLabel([{ make_name: 'MAC', product_name: 'PV12', qty: 12, unit: 'Nos' }]).segments)
      .toEqual(['MAC', 'PV12', '12 Nos']);
  });
  it('returns one combined segment for several lines', () => {
    expect(productLinesLabel([
      { make_name: 'MAC', product_name: 'PV12', qty: 12 },
      { make_name: 'Rotork', product_name: 'IQ3', qty: 6 },
    ]).segments).toEqual(['MAC PV12 ×12; Rotork IQ3 ×6']);
  });
  it('ignores fully-empty rows', () => {
    expect(productLinesLabel([{ make_name: null, product_name: null, qty: null }]).segments).toEqual([]);
  });
});
