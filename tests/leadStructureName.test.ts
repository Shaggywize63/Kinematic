import { buildLeadDisplayName, productLinesLabel } from '../src/services/crm/visitBridge.service';

/**
 * Guards the Spark & Ray lead-name format: company-centric and short —
 *   Company – Plant – Requirement
 * The PERSON is deliberately NOT in the name (the contact on a lead changes over
 * the deal), and the group / city / state / department / product lines / owner are
 * kept on their own fields and the structured account view, not crammed into the
 * name (the client found the full chain too long to scan in the list). Blanks drop.
 */
describe('buildLeadDisplayName', () => {
  const base = {
    group: 'Tata Steel Limited',
    company: 'Neelachal Ispat Nigam Limited',
    city: 'Jajpur',
    state: 'Odisha',
    plant: 'Pellet Plant',
    department: 'Instrumentation' as string | null,
    person: 'Prabhat Kumar',
    requirement: 'Replace ASCO Pulse Valve with MAC Pulse Valves',
    owner: 'Pallab Mahatha',
  };

  it('is company · plant · requirement, and never includes the person or owner', () => {
    const name = buildLeadDisplayName({
      ...base,
      productLines: [{ make_name: 'MAC', product_name: 'PV12', qty: 12, unit: 'Nos' }],
    });
    expect(name).toBe('Neelachal Ispat Nigam Limited – Pellet Plant – Replace ASCO Pulse Valve with MAC Pulse Valves');
    expect(name).not.toContain('Prabhat Kumar'); // person stays out of the name
    expect(name).not.toContain('Pallab Mahatha'); // owner stays out of the name
    expect(name).not.toContain('PV12');           // product lines stay out of the name
  });

  it('drops blank segments (no plant / no requirement yet)', () => {
    expect(buildLeadDisplayName({ ...base, plant: null, requirement: null, productLines: [] }))
      .toBe('Neelachal Ispat Nigam Limited');
    expect(buildLeadDisplayName({ ...base, requirement: null, productLines: [] }))
      .toBe('Neelachal Ispat Nigam Limited – Pellet Plant');
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
