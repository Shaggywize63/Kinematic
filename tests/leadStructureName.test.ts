import { buildLeadDisplayName, productLinesLabel } from '../src/services/crm/visitBridge.service';

/**
 * Guards the agreed Spark & Ray lead-name format —
 *   Account · Plant · Department — Requirement
 * The PERSON, owner, product lines, group, city and state are deliberately NOT in
 * the name (they ride alongside as metadata). Blank segments drop out cleanly.
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

  it('is Account · Plant · Department — Requirement, never the person, owner or products', () => {
    const name = buildLeadDisplayName({
      ...base,
      productLines: [{ make_name: 'MAC', product_name: 'PV12', qty: 12, unit: 'Nos' }],
    });
    expect(name).toBe('Neelachal Ispat Nigam Limited · Pellet Plant · Instrumentation — Replace ASCO Pulse Valve with MAC Pulse Valves');
    expect(name).not.toContain('Prabhat Kumar'); // person stays out of the name
    expect(name).not.toContain('Pallab Mahatha'); // owner stays out of the name
    expect(name).not.toContain('PV12');           // product lines stay out of the name
    expect(name).not.toContain('Tata Steel');     // group stays out of the name
    expect(name).not.toContain('Jajpur');         // city stays out of the name
  });

  it('matches the agreed examples, dropping blank segments cleanly', () => {
    const ntpc = { company: 'NTPC', plant: 'Dadri', department: 'Procurement', requirement: '150 mm Gate Valves', productLines: [] };
    expect(buildLeadDisplayName(ntpc)).toBe('NTPC · Dadri · Procurement — 150 mm Gate Valves');
    expect(buildLeadDisplayName({ ...ntpc, department: null })).toBe('NTPC · Dadri — 150 mm Gate Valves');
    expect(buildLeadDisplayName({ ...ntpc, plant: '  ' })).toBe('NTPC · Procurement — 150 mm Gate Valves');
    expect(buildLeadDisplayName({ ...ntpc, requirement: null })).toBe('NTPC · Dadri · Procurement');
    expect(buildLeadDisplayName({ ...ntpc, plant: null, department: null, requirement: null })).toBe('NTPC');
    expect(buildLeadDisplayName({ company: null, requirement: 'Valves', productLines: [] })).toBe('Valves');
    expect(buildLeadDisplayName({ productLines: [] })).toBe('');
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
