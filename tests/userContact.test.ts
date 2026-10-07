/**
 * A mobile number is optional when creating a user; a user must still be able to sign in
 * (mobile or email), and a mobile that is given must be exactly 10 digits.
 */
import { normalizeMobile, newUserContactProblem } from '../src/lib/userContact';

describe('normalizeMobile', () => {
  it('treats missing, empty and blank values as "no mobile"', () => {
    for (const v of [undefined, null, '', '   ']) expect(normalizeMobile(v)).toBeNull();
  });
  it('trims a real number', () => {
    expect(normalizeMobile(' 9876543210 ')).toBe('9876543210');
  });
});

describe('newUserContactProblem', () => {
  it('accepts an email with no mobile number', () => {
    expect(newUserContactProblem({ email: 'someone@example.com' })).toBeNull();
    expect(newUserContactProblem({ mobile: '', email: 'someone@example.com' })).toBeNull();
    expect(newUserContactProblem({ mobile: null, email: 'someone@example.com' })).toBeNull();
  });

  it('accepts a mobile with no email', () => {
    expect(newUserContactProblem({ mobile: '9876543210' })).toBeNull();
  });

  it('accepts both', () => {
    expect(newUserContactProblem({ mobile: '9876543210', email: 'a@b.co' })).toBeNull();
  });

  it('refuses a user with neither, because they could not sign in', () => {
    expect(newUserContactProblem({})).toMatch(/mobile number or an email/i);
    expect(newUserContactProblem({ mobile: '  ', email: ' ' })).toMatch(/mobile number or an email/i);
  });

  it('still requires a given mobile to be exactly 10 digits', () => {
    for (const bad of ['12345', '98765432101', '98765abcde', '+919876543210']) {
      expect(newUserContactProblem({ mobile: bad, email: 'a@b.co' })).toMatch(/exactly 10 digits/i);
    }
  });

  it('rejects a malformed email', () => {
    expect(newUserContactProblem({ mobile: '9876543210', email: 'not-an-email' })).toMatch(/valid email/i);
  });
});
