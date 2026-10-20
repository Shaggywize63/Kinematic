import {
  NOTIFICATION_CATALOG, ALL_KINDS, canonicalKind, isKnownKind, parseEnabledKinds,
} from '../src/lib/notificationCatalog';
import { notificationKind } from '../src/lib/notificationRoute';

describe('notification catalogue', () => {
  it('lists each kind once and gives every entry a label, group and description', () => {
    const seen = new Set<string>();
    for (const e of NOTIFICATION_CATALOG) {
      for (const k of [e.kind, ...(e.aliases ?? [])]) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
      expect(e.label.trim()).not.toBe('');
      expect(e.description.trim()).not.toBe('');
      expect(['CRM', 'FieldForce', 'Distribution', 'System']).toContain(e.group);
    }
    expect(seen.has(ALL_KINDS)).toBe(false);
  });

  it('folds an alias onto its catalogue kind and leaves unknown kinds alone', () => {
    expect(canonicalKind('crm_lead_escalation')).toBe('crm_lead_stagnant');
    expect(canonicalKind('daily_briefing')).toBe('crm_home');
    expect(canonicalKind('sos')).toBe('sos');
    expect(canonicalKind('brand_new_kind')).toBe('brand_new_kind');
    expect(isKnownKind('daily_briefing')).toBe(true);
    expect(isKnownKind('brand_new_kind')).toBe(false);
  });

  it('marks the safety notifications as recommended', () => {
    const rec = NOTIFICATION_CATALOG.filter((e) => e.recommended).map((e) => e.kind).sort();
    expect(rec).toEqual(['security_alert', 'sos']);
  });

  it('knows the kind every writer derives for a row (row type + data)', () => {
    const rows: Array<[string, unknown]> = [
      ['sos', { sos_id: 'S1' }],
      ['general', { kind: 'lead_assigned' }],
      ['leave', { type: 'leave_request' }],
      ['attendance', { type: 'att_reg_decision' }],
      ['broadcast', null],
      ['message', { thread_id: 't' }],
      ['mention', {}],
      ['daily_briefing', { type: 'daily_briefing', kind: 'crm_home' }],
      ['crm_activity_due', { kind: 'crm_task_overdue' }],
      ['kini', { nudge_kind: 'cold_deals' }],
      ['finance_invoice_due', { kind: 'finance_invoice_due' }],
    ];
    for (const [type, data] of rows) {
      const kind = notificationKind(type, data);
      expect({ kind, known: isKnownKind(kind) }).toEqual({ kind, known: true });
    }
  });
});

describe('parseEnabledKinds', () => {
  it('keeps unique catalogue kinds and folds aliases', () => {
    expect(parseEnabledKinds(['sos', 'sos', ' lead_assigned ', 'daily_briefing', ''])).toEqual(['sos', 'lead_assigned', 'crm_home']);
  });
  it('the wildcard wins and an empty list switches everything off', () => {
    expect(parseEnabledKinds(['sos', ALL_KINDS])).toEqual([ALL_KINDS]);
    expect(parseEnabledKinds([])).toEqual([]);
  });
  it('rejects a kind that is not in the catalogue, and anything that is not a list', () => {
    expect(() => parseEnabledKinds(['sos', 'made_up'])).toThrow(/Unknown notification kind: made_up/);
    expect(() => parseEnabledKinds('sos')).toThrow(/array/);
    expect(() => parseEnabledKinds(null)).toThrow(/array/);
  });
});
