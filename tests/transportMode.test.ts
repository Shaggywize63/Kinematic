/**
 * Mode of transport (services/transportMode.service.ts) — the PURE rules: which ids a rep may pick, how a
 * requested id is validated, how it is labelled. The HTTP behaviour (check-in, PATCH, the rules response,
 * the "never written when off" guarantee) is tests/attendanceTransportApi.test.ts.
 */
import {
  buildTransportModes, validateTransportMode, labelForTransportMode, humanizeTransportMode, isFixedTransportMode,
  hasTransportModeValue, trackTransportModeOn, TRANSPORT_MODE_ID_RE, FIXED_TRANSPORT_MODES, DEFAULT_VEHICLE_TRANSPORT_MODES,
  extraTransportModesFromSettings,
} from '../src/services/transportMode.service';

const POLICY_VEHICLES = [
  { id: 'own_bike', label: 'Own Bike', rate_per_km: 4 },
  { id: 'own_car', label: 'Own Car', rate_per_km: 9 },
];

describe('buildTransportModes', () => {
  it('lists the policy vehicles first (id/label as in the policy, vehicle:true), then public transport and other', () => {
    expect(buildTransportModes(POLICY_VEHICLES)).toEqual([
      { id: 'own_bike', label: 'Own Bike', vehicle: true },
      { id: 'own_car', label: 'Own Car', vehicle: true },
      { id: 'public_transport', label: 'Public transport', vehicle: false },
      { id: 'other', label: 'Other', vehicle: false },
    ]);
  });

  it.each([[undefined], [null], [[]]])('a policy with no vehicle rates (%p) offers two_wheeler and car instead', (rates) => {
    expect(buildTransportModes(rates as any)).toEqual([
      { id: 'two_wheeler', label: 'Two-wheeler', vehicle: true },
      { id: 'car', label: 'Car', vehicle: true },
      { id: 'public_transport', label: 'Public transport', vehicle: false },
      { id: 'other', label: 'Other', vehicle: false },
    ]);
  });

  it('a policy vehicle that reuses a fixed id wins and the fixed entry is not listed twice', () => {
    const modes = buildTransportModes([{ id: 'other', label: 'Other (own)', rate_per_km: 3 }, { id: 'auto', label: 'Auto', rate_per_km: 6 }]);
    expect(modes.map((m) => m.id)).toEqual(['other', 'auto', 'public_transport']);
    expect(modes[0]).toEqual({ id: 'other', label: 'Other (own)', vehicle: true });
  });

  it('ignores malformed entries and returns fresh objects (the shared constants cannot be corrupted)', () => {
    const modes = buildTransportModes([null as any, { id: '', label: 'x' } as any, { id: 'ok_1', label: 'Fine' }]);
    expect(modes.map((m) => m.id)).toEqual(['ok_1', 'public_transport', 'other']);
    modes[1].label = 'tampered';
    expect(FIXED_TRANSPORT_MODES[0].label).toBe('Public transport');
    expect(DEFAULT_VEHICLE_TRANSPORT_MODES.map((m) => m.id)).toEqual(['two_wheeler', 'car']);
  });

  it('inserts the client\'s extra modes (Train, Walk) after the vehicles, as non-vehicle, before public transport / other', () => {
    const extra = [{ id: 'train', label: 'Train' }, { id: 'walk', label: 'Walk' }];
    expect(buildTransportModes(POLICY_VEHICLES, extra)).toEqual([
      { id: 'own_bike', label: 'Own Bike', vehicle: true },
      { id: 'own_car', label: 'Own Car', vehicle: true },
      { id: 'train', label: 'Train', vehicle: false },
      { id: 'walk', label: 'Walk', vehicle: false },
      { id: 'public_transport', label: 'Public transport', vehicle: false },
      { id: 'other', label: 'Other', vehicle: false },
    ]);
  });

  it('extra modes also apply on the default-vehicle path and ignore malformed / duplicate entries', () => {
    const extra = [
      { id: 'train', label: 'Train' },
      { id: 'BAD ID', label: 'x' } as any,   // id fails the regex → dropped
      { id: 'walk', label: '  ' } as any,     // blank label → dropped
      { id: 'other', label: 'My Other' },      // dupes a fixed id → first-wins keeps the extra's label
    ];
    const modes = buildTransportModes(null, extra);
    expect(modes.map((m) => m.id)).toEqual(['two_wheeler', 'car', 'train', 'other', 'public_transport']);
    expect(modes.find((m) => m.id === 'train')).toEqual({ id: 'train', label: 'Train', vehicle: false });
    expect(modes.find((m) => m.id === 'other')).toEqual({ id: 'other', label: 'My Other', vehicle: false });
  });
});

describe('extraTransportModesFromSettings', () => {
  it('reads attendance_rules.extra_transport_modes, keeping only well-formed {id,label} and trimming labels', () => {
    const settings = { attendance_rules: { extra_transport_modes: [
      { id: 'train', label: ' Train ' },
      { id: 'walk', label: 'Walk' },
      { id: 'Bad', label: 'nope' },  // uppercase id fails the regex
      { id: 'x', label: 42 },         // non-string label
      'garbage',
    ] } };
    expect(extraTransportModesFromSettings(settings)).toEqual([
      { id: 'train', label: 'Train' },
      { id: 'walk', label: 'Walk' },
    ]);
  });

  it.each([[null], [undefined], [{}], [{ attendance_rules: {} }], [{ attendance_rules: { extra_transport_modes: 'no' } }]])(
    'returns [] for missing / malformed config (%p) so existing clients are unchanged', (s) => {
      expect(extraTransportModesFromSettings(s as any)).toEqual([]);
    });
});

describe('validateTransportMode', () => {
  const allowed = buildTransportModes(POLICY_VEHICLES);

  it('accepts an allowed id', () => {
    expect(validateTransportMode('own_bike', allowed)).toEqual({ ok: true, mode: 'own_bike' });
    expect(validateTransportMode('public_transport', allowed)).toEqual({ ok: true, mode: 'public_transport' });
    expect(validateTransportMode('other', allowed)).toEqual({ ok: true, mode: 'other' });
  });

  it('rejects an unknown id and names the allowed ones', () => {
    const r = validateTransportMode('helicopter', allowed);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/Unknown transport_mode "helicopter"/);
    expect((r as { error: string }).error).toContain('own_bike, own_car, public_transport, other');
    // the defaults are not allowed when the policy has its own vehicles
    expect(validateTransportMode('two_wheeler', allowed)).toMatchObject({ ok: false });
  });

  it.each([
    ['upper case', 'Own_Bike'], ['a space', 'own bike'], ['a dash', 'own-bike'], ['empty', ''], ['41 characters', 'a'.repeat(41)],
    ['punctuation', 'own_bike;drop'], ['unicode', 'bîke'],
  ])('rejects a malformed id: %s', (_l, v) => {
    expect(validateTransportMode(v, allowed)).toMatchObject({ ok: false });
    expect(validateTransportMode(v, null)).toMatchObject({ ok: false });
  });

  it('accepts exactly 40 characters of [a-z0-9_] when the allow-list is unavailable', () => {
    const id = 'a1_'.repeat(13) + 'z';
    expect(id).toHaveLength(40);
    expect(TRANSPORT_MODE_ID_RE.test(id)).toBe(true);
    expect(validateTransportMode(id, null)).toEqual({ ok: true, mode: id });
  });

  it.each([[5], [true], [{}], [['own_bike']], [null], [undefined]])('rejects a non-string: %p', (v) => {
    expect(validateTransportMode(v, allowed)).toMatchObject({ ok: false, error: 'transport_mode must be a string' });
  });

  it('with no allow-list (policy could not be read) only the format is checked: a well-formed id passes', () => {
    expect(validateTransportMode('whatever_1', null)).toEqual({ ok: true, mode: 'whatever_1' });
  });
});

describe('labels', () => {
  it('uses the list, then the fixed and default labels, then makes the id readable', () => {
    const modes = buildTransportModes(POLICY_VEHICLES);
    expect(labelForTransportMode('own_bike', modes)).toBe('Own Bike');
    expect(labelForTransportMode('public_transport')).toBe('Public transport');
    expect(labelForTransportMode('other', modes)).toBe('Other');
    expect(labelForTransportMode('two_wheeler')).toBe('Two-wheeler');
    expect(labelForTransportMode('company_van')).toBe('Company Van');
    expect(humanizeTransportMode('own_bike_2')).toBe('Own Bike 2');
  });

  it('null / empty / non-string has no label', () => {
    expect(labelForTransportMode(null)).toBeNull();
    expect(labelForTransportMode(undefined)).toBeNull();
    expect(labelForTransportMode('')).toBeNull();
  });

  it('knows the always-available ids', () => {
    expect(isFixedTransportMode('other')).toBe(true);
    expect(isFixedTransportMode('public_transport')).toBe(true);
    expect(isFixedTransportMode('car')).toBe(false);
  });
});

describe('small predicates', () => {
  it('trackTransportModeOn is true only for an explicit true', () => {
    expect(trackTransportModeOn({ track_transport_mode: true })).toBe(true);
    for (const v of [false, undefined, null, 'true', 1, {}]) expect(trackTransportModeOn({ track_transport_mode: v })).toBe(false);
    expect(trackTransportModeOn(null)).toBe(false);
    expect(trackTransportModeOn(undefined)).toBe(false);
    expect(trackTransportModeOn({})).toBe(false);
  });

  it('hasTransportModeValue: null, undefined and the empty string mean "not sent"', () => {
    expect(hasTransportModeValue(undefined)).toBe(false);
    expect(hasTransportModeValue(null)).toBe(false);
    expect(hasTransportModeValue('')).toBe(false);
    expect(hasTransportModeValue('car')).toBe(true);
    expect(hasTransportModeValue(0)).toBe(true);       // a wrong type is "sent" - and then rejected by validateTransportMode
  });
});
