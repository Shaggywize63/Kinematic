import { istifyForModel } from '../src/services/crm/ai/aiClient';

/**
 * KINI's tools return DB rows whose timestamps are UTC. Before a tool result is
 * handed to the model, istifyForModel() rewrites every timestamp to IST and
 * every plain date to DD/MM/YYYY, so KINI never quotes a bare UTC value back to
 * the rep (who works in IST). This guards that transform.
 */
describe('istifyForModel — UTC → IST / DD-MM-YYYY for the model', () => {
  it('converts a UTC ISO datetime (Z) to IST with a DD/MM/YYYY date and IST label', () => {
    // 2026-11-26T10:15:00Z === 15:45 IST on 26/11/2026
    const out = istifyForModel('2026-11-26T10:15:00Z') as string;
    expect(out).toContain('26/11/2026');
    expect(out).toMatch(/3:45\s?PM/i);
    expect(out).toContain('IST');
    expect(out).not.toContain('Z');
  });

  it('treats a zone-less DB timestamp ("YYYY-MM-DD HH:mm:ss") as UTC and shifts +5:30', () => {
    // 2026-01-01 20:00:00 UTC === 01:30 IST on 02/01/2026 (crosses midnight)
    const out = istifyForModel('2026-01-01 20:00:00') as string;
    expect(out).toContain('02/01/2026');
    expect(out).toMatch(/1:30\s?AM/i);
    expect(out).toContain('IST');
  });

  it('rewrites a plain calendar date (no time) to DD/MM/YYYY without inventing a time', () => {
    expect(istifyForModel('2026-11-26')).toBe('26/11/2026');
  });

  it('recurses through nested objects and arrays, leaving non-date strings untouched', () => {
    const row = {
      name: 'Rahul',
      created_at: '2026-11-26T10:15:00Z',
      activities: [{ at: '2026-01-01 20:00:00', note: 'called — no answer' }],
      due_date: '2026-12-01',
      score: 72,
    };
    const out = istifyForModel(row) as any;
    expect(out.name).toBe('Rahul');
    expect(out.score).toBe(72);
    expect(out.created_at).toContain('26/11/2026');
    expect(out.created_at).toContain('IST');
    expect(out.due_date).toBe('01/12/2026');
    expect(out.activities[0].at).toContain('02/01/2026');
    expect(out.activities[0].note).toBe('called — no answer'); // prose with a dash is not a date
  });

  it('leaves a malformed date-shaped string unchanged rather than emitting Invalid Date', () => {
    // Passes the datetime regex but is not a real date — Date() is NaN, so return as-is.
    expect(istifyForModel('2026-13-45T99:99:99Z')).toBe('2026-13-45T99:99:99Z');
  });

  it('does not mangle numbers, booleans, or null', () => {
    expect(istifyForModel(42)).toBe(42);
    expect(istifyForModel(true)).toBe(true);
    expect(istifyForModel(null)).toBe(null);
  });
});
