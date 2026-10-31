/**
 * Contract tests for sanitisePostgrestSearch (src/utils/postgrest.ts).
 *
 * This one helper guards the injection-sensitive search path at 10+ call
 * sites — leads / deals / crud list, forms, distribution salesman, KINI
 * tools, broadcast, and three crm.routes search endpoints all interpolate
 * its output straight into a PostgREST `.or(...ilike...)` filter. If the
 * escaping silently regresses, every one of those searches either breaks
 * (wrong results) or opens the exact OR-filter break-out the function was
 * written to stop — and `tsc` stays green the whole time. These tests pin
 * the behaviour the call sites depend on so a regression fails CI instead.
 */
import { sanitisePostgrestSearch } from '../src/utils/postgrest';

// The structural characters that let a value break out of a PostgREST
// `.or()` predicate (comma starts a new predicate; parens group; quote and
// backslash are grammar), plus the ilike wildcards that would turn a literal
// search into a pattern. None of these may survive sanitisation.
const FORBIDDEN = ['%', '_', '*', '(', ')', ',', '"', '\\'];

describe('sanitisePostgrestSearch — non-string / empty input', () => {
  it('maps null and undefined to an empty string', () => {
    expect(sanitisePostgrestSearch(null)).toBe('');
    expect(sanitisePostgrestSearch(undefined)).toBe('');
  });

  it('maps an empty / whitespace-only string to an empty string', () => {
    expect(sanitisePostgrestSearch('')).toBe('');
    expect(sanitisePostgrestSearch('   ')).toBe('');
  });

  it('coerces a number to its digits', () => {
    expect(sanitisePostgrestSearch(9876500000)).toBe('9876500000');
  });
});

describe('sanitisePostgrestSearch — strips ilike wildcards', () => {
  it('removes %, _ and * so the term is a literal, not a pattern', () => {
    expect(sanitisePostgrestSearch('a%b_c*d')).toBe('abcd');
  });

  it('collapses a wildcard-only string to empty', () => {
    expect(sanitisePostgrestSearch('%%__**')).toBe('');
  });
});

describe('sanitisePostgrestSearch — strips OR-filter grammar', () => {
  it('removes parentheses, commas, double-quotes and backslashes', () => {
    expect(sanitisePostgrestSearch('a(b)c,d"e\\f')).toBe('abcdef');
  });

  it('neutralises the documented break-out payload', () => {
    // From the function's own doc comment: with the comma intact this would
    // inject a second, attacker-controlled predicate into the .or() filter.
    const out = sanitisePostgrestSearch('x,company.eq.target');
    expect(out).not.toContain(','); // no comma => cannot start a new predicate
    expect(out).toBe('xcompany.eq.target');
  });

  it('leaves no forbidden character in the output for a hostile input', () => {
    const hostile = '%_*(),"\\' + 'drop,company.eq.secret),(or.x';
    const out = sanitisePostgrestSearch(hostile);
    for (const ch of FORBIDDEN) expect(out).not.toContain(ch);
  });
});

describe('sanitisePostgrestSearch — preserves legitimate searches', () => {
  it('keeps letters, digits and spaces', () => {
    expect(sanitisePostgrestSearch('Ravi Kumar 42')).toBe('Ravi Kumar 42');
  });

  it('keeps dots (email / domain searches stay usable)', () => {
    // A dot alone cannot inject a predicate without a comma to separate it,
    // so it is deliberately preserved.
    expect(sanitisePostgrestSearch('ravi@acme.example.com')).toBe('ravi@acme.example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitisePostgrestSearch('  Nair Steel  ')).toBe('Nair Steel');
  });
});

describe('sanitisePostgrestSearch — length bound', () => {
  it('caps the result at 80 characters to keep query size predictable', () => {
    const long = 'a'.repeat(200);
    expect(sanitisePostgrestSearch(long)).toHaveLength(80);
  });

  it('counts length after stripping (stripped chars do not consume the budget)', () => {
    // 100 "a" interleaved with 100 wildcards: wildcards vanish, leaving 100
    // real chars, which the 80-cap then trims to 80.
    const mixed = 'a%'.repeat(100);
    const out = sanitisePostgrestSearch(mixed);
    expect(out).toBe('a'.repeat(80));
  });
});

describe('sanitisePostgrestSearch — idempotent', () => {
  it('sanitising an already-sanitised value is a no-op', () => {
    const once = sanitisePostgrestSearch('x,company.eq.target (%_*)');
    expect(sanitisePostgrestSearch(once)).toBe(once);
  });
});
