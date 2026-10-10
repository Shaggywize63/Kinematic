/**
 * Attendance rules (per client): the PURE logic — defaults + validation, resolution + settings merge, late
 * computation (IST, boundaries), working-day / presence / absence counting, and the captured_at acceptance
 * matrix for offline punches. No DB, no HTTP: services/attendanceRules.service.ts imports nothing with I/O.
 */
import {
  ATTENDANCE_RULES_DEFAULTS, ATTENDANCE_RULES_BOUNDS, defaultAttendanceRules, parseHHMM,
  validateRulesPatch, resolveAttendanceRules, mergeRulesIntoSettings, rulesAdminView,
  istParts, istDateOf, isValidYmd, addDaysYmd, weekdayOf, inclusiveDayCount,
  computeLate, classifyPunctuality, applyLate, lateTrackingEnabled, lateTrackingOn,
  decideCapturedAt, CAPTURED_AT_MAX_FUTURE_MS, CAPTURED_AT_MAX_AGE_MS,
  validateSummaryRange, workingDaysInRange, buildAttendanceSummary, SUMMARY_MAX_RANGE_DAYS,
  type AttendanceRules,
} from '../src/services/attendanceRules.service';
import { toIST } from '../src/utils';

/** An IST wall-clock moment as an ISO instant: ist('2026-09-03', '09:46') */
const ist = (date: string, hhmm: string, ss = '00') => new Date(Date.parse(`${date}T${hhmm}:${ss}+05:30`)).toISOString();

const rules = (over: Partial<AttendanceRules> = {}): AttendanceRules => ({ ...defaultAttendanceRules(), ...over });
const configured = (over: Partial<AttendanceRules> = {}) => ({ configured: true, rules: rules(over) });
const unconfigured = { configured: false, rules: defaultAttendanceRules() };

describe('defaults and bounds', () => {
  it('match the contract', () => {
    expect(ATTENDANCE_RULES_DEFAULTS).toEqual({
      shift_start: '09:30', shift_end: '18:00', grace_minutes: 15, weekly_off: [0], allow_offline_checkin: false,
      selfie_required: true, form_checkin_required: false,
    });
    expect(ATTENDANCE_RULES_BOUNDS.grace_minutes).toEqual({ min: 0, max: 120 });
  });

  it('defaultAttendanceRules() is a fresh copy that cannot corrupt the shared defaults', () => {
    const a = defaultAttendanceRules();
    a.weekly_off.push(6);
    a.grace_minutes = 99;
    expect(defaultAttendanceRules().weekly_off).toEqual([0]);
    expect(ATTENDANCE_RULES_DEFAULTS.weekly_off).toEqual([0]);
    expect(ATTENDANCE_RULES_DEFAULTS.grace_minutes).toBe(15);
  });
});

describe('parseHHMM', () => {
  it.each([['00:00', 0], ['09:30', 570], ['18:00', 1080], ['23:59', 1439]])('%s -> %d', (s, n) => {
    expect(parseHHMM(s)).toBe(n);
  });
  it.each(['9:30', '24:00', '09:60', '0930', '09:3', '09:30:00', ' 09:30', '', 'ab:cd', '-1:00'])('rejects %p', (s) => {
    expect(parseHHMM(s)).toBeNull();
  });
  it('rejects non-strings', () => {
    expect(parseHHMM(930)).toBeNull();
    expect(parseHHMM(null)).toBeNull();
    expect(parseHHMM(undefined)).toBeNull();
  });
});

describe('validateRulesPatch', () => {
  it('accepts selfie_required / form_checkin_required booleans (alone or with other keys)', () => {
    expect(validateRulesPatch({ selfie_required: false })).toEqual({ ok: true, patch: { selfie_required: false } });
    expect(validateRulesPatch({ form_checkin_required: true })).toEqual({ ok: true, patch: { form_checkin_required: true } });
    expect(validateRulesPatch({ selfie_required: true, form_checkin_required: false, grace_minutes: 5 }))
      .toEqual({ ok: true, patch: { selfie_required: true, form_checkin_required: false, grace_minutes: 5 } });
  });

  it.each([
    ['selfie_required as string', { selfie_required: 'false' }],
    ['selfie_required as number', { selfie_required: 0 }],
    ['selfie_required null', { selfie_required: null }],
    ['form_checkin_required as string', { form_checkin_required: 'true' }],
    ['form_checkin_required as number', { form_checkin_required: 1 }],
    ['one bad new key rejects the whole request', { grace_minutes: 5, selfie_required: 'no' }],
    ['one bad new key (form) rejects the whole request', { selfie_required: false, form_checkin_required: [] }],
  ])('rejects %s', (_label, body) => {
    expect(validateRulesPatch(body)).toMatchObject({ ok: false });
  });

  it('accepts any subset and returns only the keys sent', () => {
    expect(validateRulesPatch({ grace_minutes: 20 })).toEqual({ ok: true, patch: { grace_minutes: 20 } });
    expect(validateRulesPatch({ shift_start: '10:00', shift_end: '19:30', allow_offline_checkin: true }))
      .toEqual({ ok: true, patch: { shift_start: '10:00', shift_end: '19:30', allow_offline_checkin: true } });
  });

  it('accepts the bounds exactly', () => {
    expect(validateRulesPatch({ grace_minutes: 0 })).toEqual({ ok: true, patch: { grace_minutes: 0 } });
    expect(validateRulesPatch({ grace_minutes: 120 })).toEqual({ ok: true, patch: { grace_minutes: 120 } });
    expect(validateRulesPatch({ shift_start: '00:00', shift_end: '23:59' })).toMatchObject({ ok: true });
    expect(validateRulesPatch({ weekly_off: [] })).toEqual({ ok: true, patch: { weekly_off: [] } });
  });

  it('normalises weekly_off (sorted, de-duplicated)', () => {
    expect(validateRulesPatch({ weekly_off: [6, 0, 6, 3] })).toEqual({ ok: true, patch: { weekly_off: [0, 3, 6] } });
  });

  it.each([
    ['grace below 0', { grace_minutes: -1 }],
    ['grace above 120', { grace_minutes: 121 }],
    ['fractional grace', { grace_minutes: 15.5 }],
    ['string grace', { grace_minutes: '15' }],
    ['NaN grace', { grace_minutes: NaN }],
    ['null grace', { grace_minutes: null }],
    ['shift_start without zero pad', { shift_start: '9:30' }],
    ['shift_start 24:00', { shift_start: '24:00' }],
    ['shift_end bad minutes', { shift_end: '18:60' }],
    ['shift_end numeric', { shift_end: 1800 }],
    ['weekly_off 7', { weekly_off: [7] }],
    ['weekly_off negative', { weekly_off: [-1] }],
    ['weekly_off fractional', { weekly_off: [1.5] }],
    ['weekly_off strings', { weekly_off: ['0'] }],
    ['weekly_off not an array', { weekly_off: 0 }],
    ['weekly_off too long', { weekly_off: [0, 1, 2, 3, 4, 5, 6, 0] }],
    ['allow_offline_checkin as string', { allow_offline_checkin: 'true' }],
    ['allow_offline_checkin as number', { allow_offline_checkin: 1 }],
    ['unknown key', { grace: 10 }],
  ])('rejects %s', (_label, body) => {
    const r = validateRulesPatch(body);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBeTruthy();
  });

  it('rejects the WHOLE request when one value is bad, even if the others are fine', () => {
    expect(validateRulesPatch({ shift_start: '10:00', grace_minutes: 500 })).toMatchObject({ ok: false });
  });

  it.each([[null], [undefined], [[]], ['x'], [42], [{}]])('rejects a non-object / empty body: %p', (body) => {
    expect(validateRulesPatch(body)).toMatchObject({ ok: false });
  });
});

describe('resolveAttendanceRules', () => {
  it('a client with no attendance_rules is unconfigured and resolves to defaults', () => {
    for (const settings of [undefined, null, {}, { uses_supervisor_scope: true }, 'junk', [], { attendance_rules: null }, { attendance_rules: [] }, { attendance_rules: 'x' }]) {
      expect(resolveAttendanceRules(settings)).toEqual({ configured: false, lateTracking: false, rules: defaultAttendanceRules() });
    }
  });

  it('an empty attendance_rules object IS configured (all defaults) but has no shift rules', () => {
    expect(resolveAttendanceRules({ attendance_rules: {} })).toEqual({ configured: true, lateTracking: false, rules: defaultAttendanceRules() });
  });

  it('fills missing keys from the defaults', () => {
    const r = resolveAttendanceRules({ attendance_rules: { shift_start: '10:00', weekly_off: [0, 6] } });
    expect(r).toEqual({
      configured: true,
      lateTracking: true,
      rules: { shift_start: '10:00', shift_end: '18:00', grace_minutes: 15, weekly_off: [0, 6], allow_offline_checkin: false, selfie_required: true, form_checkin_required: false },
    });
  });

  it('a hand-edited invalid value falls back to its default instead of breaking', () => {
    const r = resolveAttendanceRules({ attendance_rules: { shift_start: '9am', grace_minutes: 999, weekly_off: [9], allow_offline_checkin: 'yes', shift_end: '17:00' } });
    expect(r.configured).toBe(true);
    expect(r.rules).toEqual({ shift_start: '09:30', shift_end: '17:00', grace_minutes: 15, weekly_off: [0], allow_offline_checkin: false, selfie_required: true, form_checkin_required: false });
  });

  it('exposes the admin view with defaults and bounds', () => {
    const v = rulesAdminView(resolveAttendanceRules({ attendance_rules: { grace_minutes: 5 } }));
    expect(v.configured).toBe(true);
    expect(v.rules.grace_minutes).toBe(5);
    expect(v.defaults).toEqual({ shift_start: '09:30', shift_end: '18:00', grace_minutes: 15, weekly_off: [0], allow_offline_checkin: false, selfie_required: true, form_checkin_required: false });
    expect(v.bounds).toEqual({ grace_minutes: { min: 0, max: 120 } });
  });

  it('resolves selfie_required / form_checkin_required from the stored booleans', () => {
    const r = resolveAttendanceRules({ attendance_rules: { selfie_required: false, form_checkin_required: true } });
    expect(r.rules.selfie_required).toBe(false);
    expect(r.rules.form_checkin_required).toBe(true);
    // Absent -> today's behaviour: selfie required, no form check-in.
    const d = resolveAttendanceRules({ attendance_rules: { shift_start: '10:00' } });
    expect(d.rules.selfie_required).toBe(true);
    expect(d.rules.form_checkin_required).toBe(false);
  });

  it('a hand-edited non-boolean selfie_required / form_checkin_required falls back to its default', () => {
    const r = resolveAttendanceRules({ attendance_rules: { selfie_required: 'no', form_checkin_required: 1 } });
    expect(r.rules.selfie_required).toBe(true);
    expect(r.rules.form_checkin_required).toBe(false);
  });

  it('the admin view lists the two new keys in both rules and defaults', () => {
    const v = rulesAdminView(resolveAttendanceRules({ attendance_rules: { selfie_required: false } }));
    expect(Object.keys(v.rules).sort()).toEqual(['allow_offline_checkin', 'form_checkin_required', 'grace_minutes', 'selfie_required', 'shift_end', 'shift_start', 'weekly_off']);
    expect(Object.keys(v.defaults).sort()).toEqual(Object.keys(v.rules).sort());
    expect(v.rules.selfie_required).toBe(false);
    expect(v.defaults.selfie_required).toBe(true);
    // The internal lateTracking flag is NOT part of the admin view.
    expect(v).not.toHaveProperty('lateTracking');
  });
});

describe('lateTrackingEnabled (the guard that keeps non-shift clients out of late behaviour)', () => {
  it.each([
    ['shift_start', { shift_start: '10:00' }],
    ['shift_end', { shift_end: '19:00' }],
    ['grace_minutes', { grace_minutes: 0 }],
    ['weekly_off', { weekly_off: [] }],
  ])('is true when %s is explicitly stored', (_k, raw) => {
    expect(lateTrackingEnabled(raw)).toBe(true);
    expect(lateTrackingEnabled({ selfie_required: false, ...raw })).toBe(true);
  });

  it('is false for an object holding ONLY non-shift keys', () => {
    expect(lateTrackingEnabled({ selfie_required: false })).toBe(false);
    expect(lateTrackingEnabled({ form_checkin_required: true })).toBe(false);
    expect(lateTrackingEnabled({ selfie_required: false, form_checkin_required: true, allow_offline_checkin: true })).toBe(false);
    expect(lateTrackingEnabled({})).toBe(false);
  });

  it('is false when nothing / junk is stored, and ignores explicit null/undefined shift keys', () => {
    for (const raw of [undefined, null, 'x', 5, [], { shift_start: null }, { grace_minutes: undefined }]) {
      expect(lateTrackingEnabled(raw)).toBe(false);
    }
  });

  it('resolveAttendanceRules marks lateTracking only when a shift key is stored', () => {
    expect(resolveAttendanceRules({ attendance_rules: { selfie_required: false } })).toMatchObject({ configured: true, lateTracking: false });
    expect(resolveAttendanceRules({ attendance_rules: { form_checkin_required: true } })).toMatchObject({ configured: true, lateTracking: false });
    expect(resolveAttendanceRules({ attendance_rules: { selfie_required: false, grace_minutes: 10 } })).toMatchObject({ configured: true, lateTracking: true });
    // Gomant-style full object: unaffected.
    expect(resolveAttendanceRules({ attendance_rules: { shift_start: '09:30', shift_end: '18:00', grace_minutes: 15, weekly_off: [0], allow_offline_checkin: true } }))
      .toMatchObject({ configured: true, lateTracking: true });
  });

  it('lateTrackingOn: needs configured AND shift keys; a hand-built {configured:true} (no flag) still means on', () => {
    expect(lateTrackingOn(resolveAttendanceRules({ attendance_rules: { selfie_required: false } }))).toBe(false);
    expect(lateTrackingOn(resolveAttendanceRules({ attendance_rules: { shift_end: '19:00' } }))).toBe(true);
    expect(lateTrackingOn(resolveAttendanceRules({}))).toBe(false);
    expect(lateTrackingOn(configured())).toBe(true);
    expect(lateTrackingOn(unconfigured)).toBe(false);
    expect(lateTrackingOn(null)).toBe(false);
  });

  it('a selfie/form-only client gets NO late key and the legacy 10:00 IST punctuality', () => {
    const only = resolveAttendanceRules({ attendance_rules: { selfie_required: false, form_checkin_required: true } });
    const rec: any = { checkin_at: ist('2026-10-09', '09:50') };            // late under the 09:30+15 defaults
    applyLate(rec, only);
    expect(rec).not.toHaveProperty('late');
    // legacy: before 10:00 IST is on time, from 10:00 late — NOT the 09:45 shift cutoff
    expect(classifyPunctuality(ist('2026-10-09', '09:50'), only)).toBe('on_time');
    expect(classifyPunctuality(ist('2026-10-09', '10:00'), only)).toBe('late');
  });

  it('a shift-keyed client keeps rule-based late + punctuality', () => {
    const shifted = resolveAttendanceRules({ attendance_rules: { shift_start: '09:30', shift_end: '18:00', grace_minutes: 15, weekly_off: [0], selfie_required: false } });
    const rec: any = { checkin_at: ist('2026-10-09', '09:50') };
    applyLate(rec, shifted);
    expect(rec.late).toEqual({ is_late: true, minutes_late: 20 });
    expect(classifyPunctuality(ist('2026-10-09', '09:50'), shifted)).toBe('late');
  });
});

describe('mergeRulesIntoSettings', () => {
  it('preserves every other settings key and every other attendance_rules key', () => {
    const settings = { uses_supervisor_scope: true, app_ui: { tabs: ['a'] }, attendance_rules: { shift_start: '10:00', grace_minutes: 5 } };
    const merged = mergeRulesIntoSettings(settings, { grace_minutes: 20, allow_offline_checkin: true });
    expect(merged).toEqual({
      uses_supervisor_scope: true,
      app_ui: { tabs: ['a'] },
      attendance_rules: { shift_start: '10:00', grace_minutes: 20, allow_offline_checkin: true },
    });
  });

  it('does not mutate its input', () => {
    const settings = { k: 1, attendance_rules: { shift_start: '10:00' } };
    const snapshot = JSON.parse(JSON.stringify(settings));
    mergeRulesIntoSettings(settings, { shift_start: '11:00' });
    expect(settings).toEqual(snapshot);
  });

  it('creates attendance_rules (and tolerates missing / non-object settings)', () => {
    expect(mergeRulesIntoSettings(null, { grace_minutes: 10 })).toEqual({ attendance_rules: { grace_minutes: 10 } });
    expect(mergeRulesIntoSettings({ a: 1 }, { weekly_off: [] })).toEqual({ a: 1, attendance_rules: { weekly_off: [] } });
    expect(mergeRulesIntoSettings([1, 2], { grace_minutes: 1 })).toEqual({ attendance_rules: { grace_minutes: 1 } });
  });

  it('only persists the keys the admin set (the rest keep resolving to defaults)', () => {
    const merged = mergeRulesIntoSettings({}, { shift_start: '08:00' });
    expect(merged).toEqual({ attendance_rules: { shift_start: '08:00' } });
    expect(resolveAttendanceRules(merged).rules.shift_end).toBe('18:00');
  });
});

describe('IST helpers', () => {
  it('converts an instant to its IST date and minute-of-day', () => {
    expect(istParts('2026-10-10T04:15:00Z')).toEqual({ date: '2026-10-10', minuteOfDay: 585 });   // 09:45 IST
    expect(istParts('2026-10-10T18:29:59Z')).toEqual({ date: '2026-10-10', minuteOfDay: 1439 });  // 23:59 IST
    expect(istParts('2026-10-10T18:30:00Z')).toEqual({ date: '2026-10-11', minuteOfDay: 0 });     // midnight IST = next IST day
    expect(istParts('2026-10-09T18:30:00Z')).toEqual({ date: '2026-10-10', minuteOfDay: 0 });
  });

  it('works across month and year ends', () => {
    expect(istDateOf('2026-12-31T20:00:00Z')).toBe('2027-01-01');
    expect(istDateOf('2026-02-28T19:00:00Z')).toBe('2026-03-01');
  });

  it('accepts epoch ms and Date, returns null for garbage', () => {
    expect(istDateOf(Date.parse('2026-10-10T20:00:00Z'))).toBe('2026-10-11');
    expect(istDateOf(new Date('2026-10-10T20:00:00Z'))).toBe('2026-10-11');
    expect(istParts('not a date')).toBeNull();
    expect(istParts(NaN)).toBeNull();
  });

  it('validates real calendar dates only', () => {
    expect(isValidYmd('2026-02-28')).toBe(true);
    expect(isValidYmd('2028-02-29')).toBe(true);
    expect(isValidYmd('2026-02-29')).toBe(false);
    expect(isValidYmd('2026-13-01')).toBe(false);
    expect(isValidYmd('2026-9-1')).toBe(false);
    expect(isValidYmd('01-09-2026')).toBe(false);
    expect(isValidYmd(20260901)).toBe(false);
  });

  it('does date arithmetic without DST / timezone drift', () => {
    expect(addDaysYmd('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-10-10')).toBe(6);   // Saturday
    expect(weekdayOf('2026-10-11')).toBe(0);   // Sunday
    expect(inclusiveDayCount('2026-09-01', '2026-09-30')).toBe(30);
    expect(inclusiveDayCount('2026-09-01', '2026-09-01')).toBe(1);
    expect(inclusiveDayCount('2026-09-02', '2026-09-01')).toBe(0);
  });
});

describe('computeLate (shift 09:30, grace 15 -> late after 09:45)', () => {
  const late = (date: string, hhmm: string, r = rules(), ss = '00') => computeLate(ist(date, hhmm, ss), r);

  it('is NOT late exactly at shift_start + grace', () => {
    expect(late('2026-10-09', '09:45')).toEqual({ is_late: false, minutes_late: 0 });
  });

  it('is late one minute after shift_start + grace, and minutes_late counts from shift_start', () => {
    expect(late('2026-10-09', '09:46')).toEqual({ is_late: true, minutes_late: 16 });
    expect(late('2026-10-09', '11:00')).toEqual({ is_late: true, minutes_late: 90 });
  });

  it('works at the minute: seconds inside the grace minute do not make a rep late', () => {
    expect(late('2026-10-09', '09:45', rules(), '59')).toEqual({ is_late: false, minutes_late: 0 });
    expect(late('2026-10-09', '09:46', rules(), '00')).toMatchObject({ is_late: true });
  });

  it('on time before the shift and at the shift start', () => {
    expect(late('2026-10-09', '09:30')).toEqual({ is_late: false, minutes_late: 0 });
    expect(late('2026-10-09', '06:00')).toEqual({ is_late: false, minutes_late: 0 });
    expect(late('2026-10-09', '00:00')).toEqual({ is_late: false, minutes_late: 0 });
  });

  it('honours custom start / grace, including grace 0 and the 120 bound', () => {
    expect(late('2026-10-09', '10:00', rules({ shift_start: '10:00', grace_minutes: 0 }))).toEqual({ is_late: false, minutes_late: 0 });
    expect(late('2026-10-09', '10:01', rules({ shift_start: '10:00', grace_minutes: 0 }))).toEqual({ is_late: true, minutes_late: 1 });
    expect(late('2026-10-09', '11:30', rules({ shift_start: '09:30', grace_minutes: 120 }))).toEqual({ is_late: false, minutes_late: 0 });
    expect(late('2026-10-09', '11:31', rules({ shift_start: '09:30', grace_minutes: 120 }))).toEqual({ is_late: true, minutes_late: 121 });
  });

  it('can never be late when start + grace runs past midnight', () => {
    expect(late('2026-10-09', '23:59', rules({ shift_start: '23:50', grace_minutes: 30 }))).toEqual({ is_late: false, minutes_late: 0 });
  });

  it('judges by IST wall-clock, not UTC', () => {
    // 04:16Z = 09:46 IST (late) while the UTC clock reads 04:16 (would look "early").
    expect(computeLate('2026-10-10T04:16:00Z', rules())).toEqual({ is_late: true, minutes_late: 16 });
    expect(computeLate('2026-10-10T04:15:00Z', rules())).toEqual({ is_late: false, minutes_late: 0 });
    // The offset in the stamp is irrelevant — only the instant matters.
    expect(computeLate('2026-10-10T09:46:00+05:30', rules())).toEqual({ is_late: true, minutes_late: 16 });
    expect(computeLate('2026-10-10T00:00:00-04:30', rules())).toEqual({ is_late: true, minutes_late: 30 });   // = 04:30Z = 10:00 IST
  });

  it('around IST midnight: 23:59 IST is the same IST day, 00:00 IST is a new day (minute 0, not late)', () => {
    expect(computeLate('2026-10-10T18:29:00Z', rules())).toMatchObject({ is_late: true });    // 23:59 IST
    expect(computeLate('2026-10-10T18:30:00Z', rules())).toEqual({ is_late: false, minutes_late: 0 });   // 00:00 IST next day
  });

  it('returns null when there is no usable check-in', () => {
    expect(computeLate(null, rules())).toBeNull();
    expect(computeLate(undefined, rules())).toBeNull();
    expect(computeLate('', rules())).toBeNull();
    expect(computeLate('garbage', rules())).toBeNull();
  });
});

describe('classifyPunctuality (ffm attendance-punctuality)', () => {
  const legacy = (iso: string) => (toIST(new Date(iso)).getHours() < 10 ? 'on_time' : 'late');

  it('an unconfigured client keeps the legacy rule: before 10:00 IST is on time', () => {
    expect(classifyPunctuality(ist('2026-10-09', '09:59'), unconfigured)).toBe('on_time');
    expect(classifyPunctuality(ist('2026-10-09', '10:00'), unconfigured)).toBe('late');
    expect(classifyPunctuality(ist('2026-10-09', '10:00'), null)).toBe('late');
    expect(classifyPunctuality(ist('2026-10-09', '10:00'), undefined)).toBe('late');
  });

  it('is identical to the old toIST().getHours() < 10 expression for every minute of the day', () => {
    for (let m = 0; m < 24 * 60; m += 7) {
      const iso = new Date(Date.parse('2026-10-09T00:00:00+05:30') + m * 60_000).toISOString();
      expect(classifyPunctuality(iso, unconfigured)).toBe(legacy(iso));
    }
    expect(classifyPunctuality('2026-10-09T04:29:59Z', unconfigured)).toBe(legacy('2026-10-09T04:29:59Z')); // 09:59:59 IST
    expect(classifyPunctuality('2026-10-09T04:30:00Z', unconfigured)).toBe(legacy('2026-10-09T04:30:00Z')); // 10:00:00 IST
  });

  it('a configured client uses shift_start + grace instead of 10:00', () => {
    const r = configured({ shift_start: '10:30', grace_minutes: 10 });
    expect(classifyPunctuality(ist('2026-10-09', '10:40'), r)).toBe('on_time');   // legacy would say late
    expect(classifyPunctuality(ist('2026-10-09', '10:41'), r)).toBe('late');
    const early = configured({ shift_start: '08:00', grace_minutes: 0 });
    expect(classifyPunctuality(ist('2026-10-09', '09:00'), early)).toBe('late');   // legacy would say on time
    expect(classifyPunctuality(ist('2026-10-09', '08:00'), early)).toBe('on_time');
  });

  it('the default configured rules treat exactly 09:45 as on time and 09:46 as late', () => {
    expect(classifyPunctuality(ist('2026-10-09', '09:45'), configured())).toBe('on_time');
    expect(classifyPunctuality(ist('2026-10-09', '09:46'), configured())).toBe('late');
  });
});

describe('applyLate (the `late` key on attendance records)', () => {
  it('adds late info only when the client is configured and the record has a check-in', () => {
    const rec: any = { id: 'a', checkin_at: ist('2026-10-09', '10:00') };
    expect(applyLate(rec, configured())).toBe(rec);
    expect(rec.late).toEqual({ is_late: true, minutes_late: 30 });
  });

  it('leaves legacy (unconfigured) records untouched — the key is omitted entirely', () => {
    const rec: any = { id: 'a', checkin_at: ist('2026-10-09', '10:00') };
    applyLate(rec, unconfigured);
    expect('late' in rec).toBe(false);
    applyLate(rec, null);
    applyLate(rec, undefined);
    expect('late' in rec).toBe(false);
  });

  it('skips records with no check-in, and tolerates null records', () => {
    const none: any = { id: 'a', checkin_at: null, status: 'on_leave' };
    applyLate(none, configured());
    expect('late' in none).toBe(false);
    expect(applyLate(null as any, configured())).toBeNull();
  });

  it('reports on-time arrivals as late:{is_late:false,minutes_late:0}', () => {
    const rec: any = { checkin_at: ist('2026-10-09', '09:00') };
    applyLate(rec, configured());
    expect(rec.late).toEqual({ is_late: false, minutes_late: 0 });
  });
});

describe('decideCapturedAt (offline check-in / check-out)', () => {
  const NOW = Date.parse('2026-10-10T08:00:00Z');                 // 13:30 IST on 2026-10-10
  const minus = (ms: number) => new Date(NOW - ms).toISOString();
  const base = {
    nowMs: NOW, allowOffline: true, hasIdempotencyKey: true, kind: 'checkin' as const, attendanceDate: '2026-10-10',
  };

  it('honours a valid captured_at for a check-in and returns that instant', () => {
    const d = decideCapturedAt({ ...base, capturedAt: minus(30 * 60_000) });
    expect(d).toMatchObject({ used: true, reason: 'ok' });
    expect(d.at!.toISOString()).toBe(minus(30 * 60_000));
  });

  it('honours it for a check-out too (no date rule), after the shift began', () => {
    const d = decideCapturedAt({ ...base, kind: 'checkout', attendanceDate: undefined, notBeforeMs: NOW - 5 * 3_600_000, capturedAt: minus(10 * 60_000) });
    expect(d).toMatchObject({ used: true, reason: 'ok' });
  });

  describe('acceptance / rejection matrix', () => {
    it.each([
      ['client has not allowed offline check-in', { allowOffline: false }, 'offline_not_allowed'],
      ['no Idempotency-Key header', { hasIdempotencyKey: false }, 'no_idempotency_key'],
      ['neither flag nor key', { allowOffline: false, hasIdempotencyKey: false }, 'offline_not_allowed'],
      ['unparseable timestamp', { capturedAt: 'yesterday' }, 'invalid_timestamp'],
      ['timestamp without a zone designator', { capturedAt: '2026-10-10T13:00:00' }, 'invalid_timestamp'],
      ['date-only', { capturedAt: '2026-10-10' }, 'invalid_timestamp'],
      ['epoch number', { capturedAt: NOW - 60_000 }, 'invalid_timestamp'],
      ['object', { capturedAt: {} }, 'invalid_timestamp'],
      ['an impossible calendar timestamp', { capturedAt: '2026-13-45T10:00:00Z' }, 'invalid_timestamp'],
    ])('ignores captured_at when %s', (_label, over, reason) => {
      const d = decideCapturedAt({ ...base, capturedAt: minus(60_000), ...over } as any);
      expect(d).toEqual({ used: false, at: null, reason });
    });

    it.each([[undefined], [null], ['']])('treats %p as "not provided" (server time)', (capturedAt) => {
      expect(decideCapturedAt({ ...base, capturedAt })).toEqual({ used: false, at: null, reason: 'not_provided' });
    });

    it('the "not provided" verdict wins even when the flag / key are missing', () => {
      expect(decideCapturedAt({ ...base, allowOffline: false, hasIdempotencyKey: false, capturedAt: undefined }).reason).toBe('not_provided');
    });
  });

  describe('future window (max 2 minutes ahead)', () => {
    it('allows exactly +2 min', () => {
      const at = new Date(NOW + CAPTURED_AT_MAX_FUTURE_MS).toISOString();
      expect(decideCapturedAt({ ...base, capturedAt: at, attendanceDate: '2026-10-10' })).toMatchObject({ used: true });
    });
    it('rejects +2 min 1 ms', () => {
      const at = new Date(NOW + CAPTURED_AT_MAX_FUTURE_MS + 1).toISOString();
      expect(decideCapturedAt({ ...base, capturedAt: at })).toMatchObject({ used: false, reason: 'in_future' });
    });
    it('rejects an hour ahead', () => {
      expect(decideCapturedAt({ ...base, capturedAt: new Date(NOW + 3_600_000).toISOString() })).toMatchObject({ used: false, reason: 'in_future' });
    });
  });

  describe('age window (max 36 hours back)', () => {
    // 36 h before 13:30 IST on 10 Oct is 01:30 IST on 9 Oct -> the attendance date is the 9th.
    it('allows exactly 36 h old', () => {
      const at = new Date(NOW - CAPTURED_AT_MAX_AGE_MS).toISOString();
      expect(decideCapturedAt({ ...base, capturedAt: at, attendanceDate: '2026-10-09' })).toMatchObject({ used: true });
    });
    it('rejects 36 h + 1 ms', () => {
      const at = new Date(NOW - CAPTURED_AT_MAX_AGE_MS - 1).toISOString();
      expect(decideCapturedAt({ ...base, capturedAt: at, attendanceDate: '2026-10-09' })).toMatchObject({ used: false, reason: 'too_old' });
    });
    it('rejects a week-old stamp', () => {
      const at = new Date(NOW - 7 * 86_400_000).toISOString();
      expect(decideCapturedAt({ ...base, capturedAt: at, attendanceDate: '2026-10-03' })).toMatchObject({ used: false, reason: 'too_old' });
    });
  });

  describe('check-in: IST date must equal the attendance date being written', () => {
    it('rejects a stamp from a different IST day than the date being written', () => {
      // 20:00Z on the 9th is 01:30 IST on the 10th -> the 10th; writing the 9th must fail
      const at = '2026-10-09T20:00:00Z';
      expect(decideCapturedAt({ ...base, capturedAt: at, attendanceDate: '2026-10-09' })).toMatchObject({ used: false, reason: 'date_mismatch' });
      expect(decideCapturedAt({ ...base, capturedAt: at, attendanceDate: '2026-10-10' })).toMatchObject({ used: true });
    });

    it('uses the IST day, not the UTC day, at both edges of midnight', () => {
      const late = '2026-10-09T18:29:00Z';    // 23:59 IST on the 9th
      const early = '2026-10-09T18:30:00Z';   // 00:00 IST on the 10th
      const now = Date.parse('2026-10-09T19:00:00Z');
      expect(decideCapturedAt({ ...base, nowMs: now, capturedAt: late, attendanceDate: '2026-10-09' })).toMatchObject({ used: true });
      expect(decideCapturedAt({ ...base, nowMs: now, capturedAt: late, attendanceDate: '2026-10-10' })).toMatchObject({ used: false, reason: 'date_mismatch' });
      expect(decideCapturedAt({ ...base, nowMs: now, capturedAt: early, attendanceDate: '2026-10-10' })).toMatchObject({ used: true });
      expect(decideCapturedAt({ ...base, nowMs: now, capturedAt: early, attendanceDate: '2026-10-09' })).toMatchObject({ used: false, reason: 'date_mismatch' });
    });

    it('a stamp with a non-UTC offset is judged by its instant', () => {
      // 2026-10-10T01:00:00+05:30 == 2026-10-09T19:30:00Z == 01:00 IST on the 10th
      const now = Date.parse('2026-10-09T20:00:00Z');
      expect(decideCapturedAt({ ...base, nowMs: now, capturedAt: '2026-10-10T01:00:00+05:30', attendanceDate: '2026-10-10' })).toMatchObject({ used: true });
    });

    it('rejects when the attendance date is unknown', () => {
      expect(decideCapturedAt({ ...base, attendanceDate: undefined, capturedAt: minus(60_000) })).toMatchObject({ used: false, reason: 'date_mismatch' });
    });

    it('a check-in synced after midnight needs the date it was captured on', () => {
      const now = Date.parse('2026-10-10T19:00:00Z');                       // 00:30 IST on the 11th
      const at = '2026-10-10T17:00:00Z';                                    // 22:30 IST on the 10th
      expect(decideCapturedAt({ ...base, nowMs: now, capturedAt: at, attendanceDate: '2026-10-11' })).toMatchObject({ used: false, reason: 'date_mismatch' });
      expect(decideCapturedAt({ ...base, nowMs: now, capturedAt: at, attendanceDate: '2026-10-10' })).toMatchObject({ used: true });
    });
  });

  describe('check-out', () => {
    const out = { ...base, kind: 'checkout' as const, attendanceDate: undefined };

    it('has no date rule (an overnight shift can end on a later IST day)', () => {
      expect(decideCapturedAt({ ...out, capturedAt: minus(60_000) })).toMatchObject({ used: true });
    });

    it('is ignored when it would precede the check-in', () => {
      expect(decideCapturedAt({ ...out, notBeforeMs: NOW - 60_000, capturedAt: minus(30 * 60_000) })).toMatchObject({ used: false, reason: 'before_checkin' });
    });

    it('is honoured at or after the check-in instant', () => {
      const checkin = NOW - 30 * 60_000;
      expect(decideCapturedAt({ ...out, notBeforeMs: checkin, capturedAt: new Date(checkin).toISOString() })).toMatchObject({ used: true });
    });

    it('still needs the flag, the key, and the time window', () => {
      expect(decideCapturedAt({ ...out, allowOffline: false, capturedAt: minus(60_000) }).used).toBe(false);
      expect(decideCapturedAt({ ...out, hasIdempotencyKey: false, capturedAt: minus(60_000) }).used).toBe(false);
      expect(decideCapturedAt({ ...out, capturedAt: new Date(NOW + 3 * 60_000).toISOString() }).reason).toBe('in_future');
      expect(decideCapturedAt({ ...out, capturedAt: new Date(NOW - 37 * 3_600_000).toISOString() }).reason).toBe('too_old');
    });
  });

  it('accepts the common ISO spellings the apps send', () => {
    const at = new Date(NOW - 5 * 60_000);
    const spellings = [at.toISOString(), at.toISOString().replace('.000Z', 'Z'), at.toISOString().slice(0, 16) + 'Z', `${at.toISOString().slice(0, 19)}+00:00`, `${at.toISOString().slice(0, 19)}+0000`];
    for (const s of spellings) {
      expect(decideCapturedAt({ ...base, capturedAt: s })).toMatchObject({ used: true });
    }
  });
});

describe('validateSummaryRange', () => {
  it('accepts a valid range', () => {
    expect(validateSummaryRange('2026-09-01', '2026-09-30')).toEqual({ ok: true, from: '2026-09-01', to: '2026-09-30' });
    expect(validateSummaryRange('2026-09-01', '2026-09-01')).toMatchObject({ ok: true });
  });

  it(`allows exactly ${SUMMARY_MAX_RANGE_DAYS} days and rejects ${SUMMARY_MAX_RANGE_DAYS + 1}`, () => {
    expect(validateSummaryRange('2026-07-01', '2026-08-31')).toMatchObject({ ok: true });     // 62 days
    expect(validateSummaryRange('2026-07-01', '2026-09-01')).toMatchObject({ ok: false });    // 63 days
    expect(validateSummaryRange('2026-01-01', '2026-12-31')).toMatchObject({ ok: false });
  });

  it.each([
    [undefined, '2026-09-30'], ['2026-09-01', undefined], [undefined, undefined], ['', ''],
    ['2026-9-1', '2026-09-30'], ['01-09-2026', '30-09-2026'], ['2026-02-30', '2026-03-05'], ['abc', 'def'],
    [['2026-09-01'], '2026-09-30'],
  ])('rejects malformed input %p .. %p', (from, to) => {
    expect(validateSummaryRange(from, to)).toMatchObject({ ok: false });
  });

  it('rejects to before from', () => {
    expect(validateSummaryRange('2026-09-10', '2026-09-09')).toMatchObject({ ok: false });
  });
});

describe('workingDaysInRange', () => {
  // 2026-09-01 is a Tuesday; Sundays in September 2026: 6, 13, 20, 27.
  it('excludes weekly_off weekdays (default Sunday off): 26 working days in September 2026', () => {
    const days = workingDaysInRange('2026-09-01', '2026-09-30', '2026-10-10', [0]);
    expect(days).toHaveLength(26);
    expect(days).not.toContain('2026-09-06');
    expect(days).toContain('2026-09-05');
  });

  it('supports several off days (Saturday + Sunday): 22', () => {
    expect(workingDaysInRange('2026-09-01', '2026-09-30', '2026-10-10', [0, 6])).toHaveLength(22);
  });

  it('with no weekly off every day counts', () => {
    expect(workingDaysInRange('2026-09-01', '2026-09-30', '2026-10-10', [])).toHaveLength(30);
  });

  it('never counts days after today (IST), but counts today itself', () => {
    const days = workingDaysInRange('2026-09-01', '2026-09-30', '2026-09-10', [0]);
    expect(days[days.length - 1]).toBe('2026-09-10');
    expect(days).toHaveLength(9);                           // 1-5, 7-10  (6th is a Sunday)
  });

  it('is empty when the whole range is in the future', () => {
    expect(workingDaysInRange('2026-10-20', '2026-10-31', '2026-10-10', [0])).toEqual([]);
  });

  it('a single weekly-off day yields nothing', () => {
    expect(workingDaysInRange('2026-09-06', '2026-09-06', '2026-10-10', [0])).toEqual([]);
  });
});

describe('buildAttendanceSummary', () => {
  const TODAY = '2026-10-10';
  // 2026-09-01..14, Sunday off -> working days 1,2,3,4,5,7,8,9,10,11,12,14 (12 days; the 6th and 13th are Sundays)
  const FROM = '2026-09-01';
  const TO = '2026-09-14';
  const att = (user_id: string, date: string, status: string, hhmm?: string) =>
    ({ user_id, date, status, checkin_at: hhmm ? ist(date, hhmm) : null });
  const build = (over: Record<string, unknown> = {}) => buildAttendanceSummary({
    from: FROM, to: TO, todayIst: TODAY, rules: rules(), users: [], attendance: [], leaves: [], ...over,
  } as any);

  const asha = { id: 'u-asha', name: 'Asha', created_at: '2026-01-01T00:00:00Z' };
  const ashaRows = [
    att('u-asha', '2026-09-01', 'checked_out', '09:30'),     // on time
    att('u-asha', '2026-09-02', 'checked_out', '09:45'),     // exactly shift_start+grace: on time
    att('u-asha', '2026-09-03', 'checked_out', '09:46'),     // late
    att('u-asha', '2026-09-04', 'checked_in', '11:00'),      // late
    att('u-asha', '2026-09-05', 'half_day'),                 // leave module's half-day placeholder
    att('u-asha', '2026-09-06', 'checked_out', '09:00'),     // a Sunday: not a working day, must not count
    att('u-asha', '2026-09-07', 'on_leave'),                 // leave module's placeholder
    att('u-asha', '2026-09-10', 'absent'),                   // explicit absent row
  ];
  const ashaLeave = { user_id: 'u-asha', from_date: '2026-09-08', to_date: '2026-09-09', half_day_start: false, half_day_end: false };

  it('counts present / late / half-day / on-leave / absent over the working days', () => {
    const s = build({ users: [asha], attendance: ashaRows, leaves: [ashaLeave] });
    expect(s.from).toBe(FROM);
    expect(s.to).toBe(TO);
    expect(s.working_days).toBe(12);
    expect(s.rows).toEqual([{
      user_id: 'u-asha', name: 'Asha',
      working_days: 12, present: 4, late: 2, half_day: 1, on_leave: 3, absent: 4,
    }]);
  });

  it('keeps present + half_day + on_leave + absent == working_days, and late <= present', () => {
    const s = build({ users: [asha], attendance: ashaRows, leaves: [ashaLeave] });
    const r = s.rows[0];
    expect(r.present + r.half_day + r.on_leave + r.absent).toBe(r.working_days);
    expect(r.late).toBeLessThanOrEqual(r.present);
  });

  it('a rep with no rows at all is absent for every working day', () => {
    const s = build({ users: [asha] });
    expect(s.rows[0]).toMatchObject({ working_days: 12, present: 0, late: 0, half_day: 0, on_leave: 0, absent: 12 });
  });

  it('approved leave with no attendance row counts as on_leave, not absent', () => {
    const s = build({ users: [asha], leaves: [{ user_id: 'u-asha', from_date: '2026-09-01', to_date: '2026-09-03', half_day_start: false, half_day_end: false }] });
    expect(s.rows[0]).toMatchObject({ on_leave: 3, absent: 9 });
  });

  it('leave falling on a weekly-off day is not counted', () => {
    // 5th (Sat, working) .. 7th (Mon); the 6th is a Sunday -> 2 leave days, not 3
    const s = build({ users: [asha], leaves: [{ user_id: 'u-asha', from_date: '2026-09-05', to_date: '2026-09-07', half_day_start: false, half_day_end: false }] });
    expect(s.rows[0].on_leave).toBe(2);
  });

  it('a half-day boundary of an approved leave is a half_day; the days between are on_leave', () => {
    const s = build({
      users: [asha],
      leaves: [{ user_id: 'u-asha', from_date: '2026-09-08', to_date: '2026-09-10', half_day_start: true, half_day_end: true }],
    });
    expect(s.rows[0]).toMatchObject({ half_day: 2, on_leave: 1 });   // 8th half, 9th full, 10th half
  });

  it('a one-day half-day leave is a single half_day', () => {
    const s = build({ users: [asha], leaves: [{ user_id: 'u-asha', from_date: '2026-09-08', to_date: '2026-09-08', half_day_start: true, half_day_end: false }] });
    expect(s.rows[0]).toMatchObject({ half_day: 1, on_leave: 0 });
  });

  it('a real check-in on an approved-leave day wins: the rep is present', () => {
    const s = build({
      users: [asha],
      attendance: [att('u-asha', '2026-09-08', 'checked_out', '09:00')],
      leaves: [{ user_id: 'u-asha', from_date: '2026-09-08', to_date: '2026-09-08', half_day_start: false, half_day_end: false }],
    });
    expect(s.rows[0]).toMatchObject({ present: 1, on_leave: 0 });
  });

  it('days before the joining date are not absences', () => {
    const bala = { id: 'u-bala', name: 'Bala', created_at: '2026-09-08T03:00:00Z' };    // joined 08:30 IST on the 8th
    const s = build({ users: [bala] });
    // 8,9,10,11,12,14 -> 6 working days; 1-5 and 7 are before he joined
    expect(s.rows[0]).toMatchObject({ working_days: 6, absent: 6 });
    expect(s.working_days).toBe(12);                         // the scope total is unaffected
  });

  it('joining is judged by the IST date (created 01:30 IST on the 8th == 20:00Z on the 7th)', () => {
    const chitra = { id: 'u-c', name: 'Chitra', created_at: '2026-09-07T20:00:00Z' };
    expect(build({ users: [chitra] }).rows[0].working_days).toBe(6);          // starts the 8th, not the 7th
    const dev = { id: 'u-d', name: 'Dev', created_at: '2026-09-07T18:29:00Z' };   // 23:59 IST on the 7th
    expect(build({ users: [dev] }).rows[0].working_days).toBe(7);             // 7th still counts
  });

  it('a row that exists before the joining date is still counted (real evidence of presence)', () => {
    const bala = { id: 'u-bala', name: 'Bala', created_at: '2026-09-08T03:00:00Z' };
    const s = build({ users: [bala], attendance: [att('u-bala', '2026-09-04', 'checked_out', '09:00')] });
    expect(s.rows[0]).toMatchObject({ working_days: 7, present: 1, absent: 6 });
  });

  it('a missing created_at means "no joining cut-off"', () => {
    const s = build({ users: [{ id: 'u-x', name: 'X' }] });
    expect(s.rows[0].working_days).toBe(12);
  });

  it('days after today are not counted even when the requested range extends into the future', () => {
    const s = build({ from: '2026-10-05', to: '2026-10-31', todayIst: '2026-10-10', users: [asha] });
    // 5,6,7,8,9,10 minus nothing (Sundays: the 4th and 11th are outside) = 6 days; Oct 10 = today
    expect(s.working_days).toBe(6);
    expect(s.rows[0].working_days).toBe(6);
    expect(s.rows[0].absent).toBe(6);
  });

  it('a range wholly in the future has zero working days and no absences', () => {
    const s = build({ from: '2026-10-20', to: '2026-10-25', todayIst: '2026-10-10', users: [asha] });
    expect(s.working_days).toBe(0);
    expect(s.rows[0]).toMatchObject({ working_days: 0, present: 0, absent: 0 });
  });

  it('honours the client weekly_off (Saturday + Sunday off)', () => {
    const s = build({ rules: rules({ weekly_off: [0, 6] }), users: [asha] });
    // minus Saturdays 5 and 12 -> 10 working days
    expect(s.working_days).toBe(10);
    expect(s.rows[0].working_days).toBe(10);
  });

  it('with weekly_off empty, Sundays are working days (and a Sunday punch counts)', () => {
    const s = build({ rules: rules({ weekly_off: [] }), users: [asha], attendance: [att('u-asha', '2026-09-06', 'checked_out', '09:00')] });
    expect(s.working_days).toBe(14);
    expect(s.rows[0].present).toBe(1);
  });

  it('applies each user\'s own client rules when rulesForUser is given (shift times and weekly off)', () => {
    const strict = rules({ shift_start: '09:00', grace_minutes: 0 });
    const satOff = rules({ weekly_off: [0, 6] });
    const s = build({
      users: [{ id: 'u-1', name: 'One', created_at: '2026-01-01T00:00:00Z' }, { id: 'u-2', name: 'Two', created_at: '2026-01-01T00:00:00Z' }],
      attendance: [att('u-1', '2026-09-01', 'checked_out', '09:05'), att('u-2', '2026-09-01', 'checked_out', '09:05')],
      rulesForUser: (id: string) => (id === 'u-1' ? strict : satOff),
    });
    expect(s.rows.find((r) => r.user_id === 'u-1')).toMatchObject({ late: 1, working_days: 12 });
    expect(s.rows.find((r) => r.user_id === 'u-2')).toMatchObject({ late: 0, working_days: 10 });
  });

  it('late uses the configured shift start and grace', () => {
    const s = build({
      rules: rules({ shift_start: '10:00', grace_minutes: 30 }),
      users: [asha],
      attendance: [att('u-asha', '2026-09-01', 'checked_out', '10:30'), att('u-asha', '2026-09-02', 'checked_out', '10:31')],
    });
    expect(s.rows[0]).toMatchObject({ present: 2, late: 1 });
  });

  it('a half_day row with a check-in is a half day (not also present / late)', () => {
    const s = build({ users: [asha], attendance: [att('u-asha', '2026-09-01', 'half_day', '12:00')] });
    expect(s.rows[0]).toMatchObject({ half_day: 1, present: 0, late: 0 });
  });

  it('a regularised "present" row without a stored check-in time is present but not late', () => {
    const s = build({ users: [asha], attendance: [att('u-asha', '2026-09-01', 'present')] });
    expect(s.rows[0]).toMatchObject({ present: 1, late: 0 });
  });

  it('a row with no presence evidence and an unknown status is not a present day', () => {
    const s = build({ users: [asha], attendance: [att('u-asha', '2026-09-01', 'mystery')] });
    expect(s.rows[0]).toMatchObject({ present: 0, absent: 12 });
  });

  it('prefers the duplicate that has a check-in', () => {
    const s = build({ users: [asha], attendance: [att('u-asha', '2026-09-01', 'absent'), att('u-asha', '2026-09-01', 'checked_out', '09:00')] });
    expect(s.rows[0]).toMatchObject({ present: 1, absent: 11 });
  });

  it('accepts timestamp-shaped dates from the database', () => {
    const s = build({
      users: [asha],
      attendance: [{ user_id: 'u-asha', date: '2026-09-01T00:00:00', status: 'checked_out', checkin_at: ist('2026-09-01', '09:00') }],
      leaves: [{ user_id: 'u-asha', from_date: '2026-09-02T00:00:00', to_date: '2026-09-02T00:00:00' }],
    });
    expect(s.rows[0]).toMatchObject({ present: 1, on_leave: 1 });
  });

  it('orders rows by name, case-insensitively, then by id', () => {
    const s = build({ users: [{ id: 'u-3', name: 'zoya' }, { id: 'u-2', name: 'Bala' }, { id: 'u-1', name: 'asha' }, { id: 'u-0', name: 'Asha' }] });
    expect(s.rows.map((r) => r.user_id)).toEqual(['u-0', 'u-1', 'u-2', 'u-3']);
  });

  it('returns an empty rows list for an empty roster', () => {
    expect(build()).toEqual({ from: FROM, to: TO, working_days: 12, rows: [] });
  });

  it('keeps users independent of one another', () => {
    const bala = { id: 'u-bala', name: 'Bala', created_at: '2026-01-01T00:00:00Z' };
    const s = build({
      users: [asha, bala],
      attendance: [...ashaRows, att('u-bala', '2026-09-01', 'checked_out', '09:00')],
      leaves: [ashaLeave],
    });
    expect(s.rows.find((r) => r.user_id === 'u-bala')).toMatchObject({ present: 1, on_leave: 0, absent: 11 });
    expect(s.rows.find((r) => r.user_id === 'u-asha')).toMatchObject({ present: 4, on_leave: 3 });
  });
});
