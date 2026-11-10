import { scrubBody } from '../src/middleware/auditAll';

describe('audit log body scrubbing', () => {
  it('redacts the personal fields an HRMS employee body carries, in the spellings the dashboard and API use', () => {
    const body = {
      first_name: 'Asha', pan: 'ABCDE1234F', aadhaar_last4: '4321', aadhaarLast4: '4321', mobile: '9876543210', dob: '1990-01-01',
      bank: { accountHolder: 'Asha Rao', accountNumber: '1234567890', ifsc: 'HDFC0000123' },
      declaration: { landlordPan: 'BCDPS1234E', sec80C: 90000 },
      emergency_contact: { name: 'R Rao', mobile: '9000000000' }, emergencyContact: { name: 'R Rao' },
      father_name: 'S Rao', fatherName: 'S Rao', annual_ctc: 600000,
    };
    const out = scrubBody(body) as Record<string, unknown>;
    for (const k of ['pan', 'aadhaar_last4', 'aadhaarLast4', 'mobile', 'dob', 'bank', 'declaration', 'emergency_contact', 'emergencyContact', 'father_name', 'fatherName']) {
      expect(String(out[k])).toMatch(/REDACTED/);
    }
    // What is not personal stays readable for the audit trail.
    expect(out.first_name).toBe('Asha');
    expect(out.annual_ctc).toBe(600000);
  });

  it('reaches into nested rows (an import carries many employees)', () => {
    const out = scrubBody({ rows: [{ pan: 'ABCDE1234F', bank: { accountNumber: '111' }, first_name: 'A' }] }) as any;
    expect(String(out.rows[0].pan)).toMatch(/REDACTED/);
    expect(String(out.rows[0].bank)).toMatch(/REDACTED/);
    expect(out.rows[0].first_name).toBe('A');
  });
});
