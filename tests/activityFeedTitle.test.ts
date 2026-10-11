/**
 * Home "Recent activity" card titles — the PURE matcher behind GET /analytics/activity-feed's
 * `customer_name` / `title` / `subtitle` (src/services/activityFeedTitle.service.ts). No I/O: the DB
 * read and the response shape are covered in activityFeed.test.ts.
 */
import {
  CUSTOMER_NAME_LABELS,
  FEED_TITLE_FALLBACK,
  UNKNOWN_STORE_FALLBACK,
  buildFeedTitle,
  customerNamesBySubmission,
  isRealOutletName,
  normaliseLabel,
  pickCustomerName,
} from '../src/services/activityFeedTitle.service';

const a = (label: string | null | undefined, value_text: string | null | undefined) => ({ label, value_text });

describe('CUSTOMER_NAME_LABELS', () => {
  it('is the agreed priority list, best match first', () => {
    expect([...CUSTOMER_NAME_LABELS]).toEqual([
      'customer name',
      'customer_name',
      'customer',
      'client name',
      'party name',
      'shop name',
      'outlet name',
    ]);
  });

  it('is already normalised, so every entry can match itself', () => {
    for (const l of CUSTOMER_NAME_LABELS) expect(normaliseLabel(l)).toBe(l);
  });
});

describe('normaliseLabel', () => {
  it('trims, lower-cases and collapses inner whitespace', () => {
    expect(normaliseLabel('  Customer   NAME \n')).toBe('customer name');
    expect(normaliseLabel('Shop Name')).toBe('shop name'); // NBSP counts as whitespace
  });

  it('is empty for anything that is not a string', () => {
    expect(normaliseLabel(null)).toBe('');
    expect(normaliseLabel(undefined)).toBe('');
    expect(normaliseLabel(42)).toBe('');
  });
});

describe('pickCustomerName', () => {
  it('returns the answer of a matching question', () => {
    expect(pickCustomerName([a('Notes', 'x'), a('Customer Name', 'Acme Traders')])).toBe('Acme Traders');
  });

  it('matches case-insensitively on the trimmed label', () => {
    expect(pickCustomerName([a('  CUSTOMER NAME  ', 'Acme')])).toBe('Acme');
    expect(pickCustomerName([a('Shop name', 'Kiosk')])).toBe('Kiosk');
    expect(pickCustomerName([a('customer_NAME', 'Under Score')])).toBe('Under Score');
  });

  it('does not match labels that merely contain a keyword', () => {
    expect(pickCustomerName([a('Customer phone', '9999999999'), a('Name of shop owner', 'Ravi')])).toBeNull();
  });

  it('honours the priority order whatever order the rows arrive in', () => {
    // Every label beats every label after it, in both row orders.
    for (let i = 0; i < CUSTOMER_NAME_LABELS.length; i++) {
      for (let j = i + 1; j < CUSTOMER_NAME_LABELS.length; j++) {
        const hi = a(CUSTOMER_NAME_LABELS[i], `hi-${i}`);
        const lo = a(CUSTOMER_NAME_LABELS[j], `lo-${j}`);
        expect(pickCustomerName([hi, lo])).toBe(`hi-${i}`);
        expect(pickCustomerName([lo, hi])).toBe(`hi-${i}`);
      }
    }
  });

  it('prefers "customer name" over "shop name" and "outlet name" in a realistic form', () => {
    expect(
      pickCustomerName([
        a('Outlet Name', 'Outlet A'),
        a('Shop Name', 'Shop B'),
        a('Customer Name', 'Customer C'),
      ]),
    ).toBe('Customer C');
  });

  it('trims the answer', () => {
    expect(pickCustomerName([a('Customer Name', '   Acme Traders \n')])).toBe('Acme Traders');
  });

  it('skips a matching question whose answer is empty or whitespace and falls to the next best', () => {
    expect(pickCustomerName([a('Customer Name', ''), a('Shop Name', 'Kiosk')])).toBe('Kiosk');
    expect(pickCustomerName([a('Customer Name', '   \t '), a('Client Name', 'Globex')])).toBe('Globex');
    expect(pickCustomerName([a('Customer Name', null), a('Outlet Name', 'Outlet A')])).toBe('Outlet A');
    expect(pickCustomerName([a('Customer Name', undefined), a('Outlet Name', 'Outlet A')])).toBe('Outlet A');
  });

  it('is null when every matching answer is blank', () => {
    expect(pickCustomerName([a('Customer Name', ''), a('Shop Name', '  ')])).toBeNull();
  });

  it('is null when no question matches', () => {
    expect(pickCustomerName([a('Remarks', 'ok'), a('Photo', '')])).toBeNull();
  });

  it('is null for no answers at all', () => {
    expect(pickCustomerName([])).toBeNull();
    expect(pickCustomerName(null)).toBeNull();
    expect(pickCustomerName(undefined)).toBeNull();
  });

  it('ignores answers with a missing label (a deleted question)', () => {
    expect(pickCustomerName([a(null, 'orphan'), a(undefined, 'orphan 2'), a('Customer', 'Acme')])).toBe('Acme');
  });

  it('does not choke on non-string values', () => {
    expect(pickCustomerName([{ label: 'Customer Name', value_text: 5 as any }, a('Shop Name', 'Kiosk')])).toBe('Kiosk');
  });

  it('with the same label twice, the first answered one wins', () => {
    expect(pickCustomerName([a('Customer Name', ''), a('Customer Name', 'First'), a('Customer Name', 'Second')])).toBe('First');
  });

  it('accepts a custom priority list', () => {
    expect(pickCustomerName([a('Dealer', 'D1'), a('Customer Name', 'C1')], ['dealer', 'customer name'])).toBe('D1');
  });
});

describe('isRealOutletName', () => {
  it('rejects blanks and the Unknown Store placeholder (any case)', () => {
    for (const v of [null, undefined, '', '   ', UNKNOWN_STORE_FALLBACK, 'unknown store', ' UNKNOWN STORE ']) {
      expect(isRealOutletName(v)).toBe(false);
    }
  });

  it('accepts a real name', () => {
    expect(isRealOutletName('Reliance Fresh - Koramangala')).toBe(true);
    expect(isRealOutletName('Unknown Store Pvt Ltd')).toBe(true);
  });
});

describe('buildFeedTitle', () => {
  it('uses the customer name and puts the form name in the subtitle', () => {
    expect(buildFeedTitle({ customerName: 'Acme', outletName: 'Outlet A', formName: 'Site Visit' })).toEqual({
      title: 'Acme',
      subtitle: 'Site Visit',
    });
  });

  it('falls back to a real outlet name, form name in the subtitle', () => {
    expect(buildFeedTitle({ customerName: null, outletName: 'Outlet A', formName: 'Site Visit' })).toEqual({
      title: 'Outlet A',
      subtitle: 'Site Visit',
    });
  });

  it('does not treat the Unknown Store placeholder as an outlet', () => {
    expect(buildFeedTitle({ customerName: null, outletName: UNKNOWN_STORE_FALLBACK, formName: 'Site Visit' })).toEqual({
      title: 'Site Visit',
      subtitle: null,
    });
    expect(buildFeedTitle({ customerName: null, outletName: null, formName: 'Site Visit' })).toEqual({
      title: 'Site Visit',
      subtitle: null,
    });
  });

  it('is "Form submission" when there is nothing else', () => {
    expect(buildFeedTitle({ customerName: null, outletName: null, formName: null })).toEqual({
      title: FEED_TITLE_FALLBACK,
      subtitle: null,
    });
    expect(FEED_TITLE_FALLBACK).toBe('Form submission');
    expect(buildFeedTitle({ customerName: '  ', outletName: '', formName: '   ' })).toEqual({
      title: 'Form submission',
      subtitle: null,
    });
  });

  it('has no subtitle when the title came from the customer but the form has no title', () => {
    expect(buildFeedTitle({ customerName: 'Acme', outletName: null, formName: null })).toEqual({
      title: 'Acme',
      subtitle: null,
    });
  });

  it('trims what it returns', () => {
    expect(buildFeedTitle({ customerName: ' Acme ', outletName: null, formName: ' Site Visit ' })).toEqual({
      title: 'Acme',
      subtitle: 'Site Visit',
    });
    expect(buildFeedTitle({ customerName: null, outletName: ' Outlet A ', formName: null }).title).toBe('Outlet A');
  });
});

describe('customerNamesBySubmission', () => {
  const row = (submission_id: any, label: any, value_text: any, asArray = false) => ({
    submission_id,
    value_text,
    builder_questions: label === undefined ? null : asArray ? [{ label }] : { label },
  });

  it('groups rows per submission and picks each one independently', () => {
    const m = customerNamesBySubmission([
      row('s1', 'Shop Name', 'Kiosk'),
      row('s2', 'Customer Name', 'Acme'),
      row('s1', 'Customer Name', 'Globex'),
      row('s3', 'Remarks', 'ok'),
    ]);
    expect(m.get('s1')).toBe('Globex');
    expect(m.get('s2')).toBe('Acme');
    expect(m.get('s3')).toBeNull();
    expect(m.has('s4')).toBe(false);
  });

  it('handles the embed arriving as a one-element array', () => {
    expect(customerNamesBySubmission([row('s1', 'Customer', 'Acme', true)]).get('s1')).toBe('Acme');
  });

  it('survives a missing question embed, blank answers and rows without a submission id', () => {
    const m = customerNamesBySubmission([
      row('s1', undefined, 'orphan'),
      row('s2', 'Customer Name', '   '),
      row(null, 'Customer Name', 'nobody'),
      null as any,
    ]);
    expect(m.get('s1')).toBeNull();
    expect(m.get('s2')).toBeNull();
    expect(m.size).toBe(2);
  });

  it('is an empty map for no rows', () => {
    expect(customerNamesBySubmission([]).size).toBe(0);
    expect(customerNamesBySubmission(null).size).toBe(0);
  });
});
