/**
 * The agrisynx lead-form setup is data the real API will validate — so check it against the
 * real validators here, and check the planner is idempotent.
 */
import * as v from '../src/validators/crm.validators';
import * as setup from '../src/tools/agrisynx-lead-forms';
import { OPTION_SEARCHABLE, OPTION_SOURCE_PRODUCTS, isProductSourceOptions, isReservedOption, isSearchableOptions, visibleOptions } from '../src/lib/customFieldOptions';

describe('agrisynx custom fields', () => {
  it('are accepted by the custom field API validator', () => {
    for (const f of setup.CUSTOM_FIELDS) {
      const r = v.customFieldSchema.safeParse(f);
      expect({ key: f.field_key, ok: r.success }).toEqual({ key: f.field_key, ok: true });
    }
  });
  it('split cleanly between the two lead types', () => {
    const keys = (scope: string) => setup.CUSTOM_FIELDS.filter((f) => f.applies_to === scope).map((f) => f.field_key);
    expect(keys('b2b')).toEqual(['visit_description', 'shop_image']);
    expect(keys('b2c')).toEqual(['crop', 'suggested_product', 'farmer_photo']);
  });
  it('give the dealer description exactly the four choices asked for', () => {
    const d = setup.CUSTOM_FIELDS.find((f) => f.field_key === 'visit_description')!;
    expect(d.options).toEqual(['Dealer Visit', 'First Time Visit', 'Dealer Appoint', 'Order/Collection']);
    expect(d.required).toBe(true);
  });
  it('make crop a searchable list and suggested product a product-sourced one (no price)', () => {
    const crop = setup.CUSTOM_FIELDS.find((f) => f.field_key === 'crop')!;
    expect(isSearchableOptions(crop.options)).toBe(true);
    expect(isProductSourceOptions(crop.options)).toBe(false);
    expect(visibleOptions(crop.options)).toEqual(setup.CROPS);
    const prod = setup.CUSTOM_FIELDS.find((f) => f.field_key === 'suggested_product')!;
    expect(isProductSourceOptions(prod.options)).toBe(true);
    expect(visibleOptions(prod.options)).toEqual([]);
    expect(prod.required).toBe(false);
  });
});

describe('the crop list', () => {
  it('is large, unique, sorted, with "Other" last', () => {
    expect(setup.CROPS.length).toBeGreaterThan(120);
    expect(new Set(setup.CROPS.map((c) => c.toLowerCase())).size).toBe(setup.CROPS.length);
    expect(setup.CROPS[setup.CROPS.length - 1]).toBe('Other');
    const rest = setup.CROPS.slice(0, -1);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });
  it('has the staples', () => {
    for (const c of ['Wheat', 'Rice (Paddy)', 'Cotton', 'Sugarcane', 'Tomato', 'Mango', 'Soybean', 'Turmeric']) expect(setup.CROPS).toContain(c);
  });
  it('never contains a reserved token', () => {
    expect(setup.CROPS.some(isReservedOption)).toBe(false);
  });
});

describe('reserved option tokens', () => {
  it('are recognised and hidden', () => {
    expect(isReservedOption(OPTION_SEARCHABLE)).toBe(true);
    expect(isReservedOption(OPTION_SOURCE_PRODUCTS)).toBe(true);
    expect(isReservedOption('camera_only')).toBe(false);          // the image field's existing tokens are untouched
    expect(isReservedOption('__')).toBe(false);
    expect(visibleOptions([OPTION_SEARCHABLE, 'A', 'B'])).toEqual(['A', 'B']);
    expect(visibleOptions(null)).toEqual([]);
  });
});

describe('agrisynx settings', () => {
  const settings = setup.planSettings({ field_overrides: { 'lead.phone': { label: 'Phone' }, 'lead.city': { required: true } }, other: 1 });
  it('are accepted by the settings API validator', () => {
    expect(v.settingsUpdateSchema.safeParse(settings).success).toBe(true);
  });
  it('keep the admin\'s existing overrides, and let ours win for the same key', () => {
    const fo = settings.config.field_overrides as Record<string, unknown>;
    expect(fo['lead.city']).toEqual({ required: true });
    expect(fo['lead.phone']).toEqual({ label: 'Phone' });       // universal key untouched
    expect(fo['lead.phone@b2b']).toEqual({ label: 'Mobile Number', required: true });
  });
  it('rename the form fields the way the brief says', () => {
    const fo = setup.FIELD_OVERRIDES;
    expect(fo['lead.company@b2b']).toMatchObject({ label: 'Shop Name', required: true });
    expect(fo['lead.first_name@b2b']).toMatchObject({ label: 'Dealer Name' });
    expect(fo['lead.first_name@b2c']).toMatchObject({ label: 'Farmer Name' });
    expect(fo['lead.address_line1@b2b']).toMatchObject({ label: 'Location' });
    expect(fo['lead.last_name@b2b']).toMatchObject({ hidden: true, required: false });
  });
  it('call the lead types Dealer and Farmers, put an address on dealers and schedule visits for dealers only', () => {
    expect(setup.LEAD_FORM).toEqual({
      segment_labels: { b2b: 'Dealer', b2c: 'Farmers' }, address_on_b2b: true, schedule_visit: { segments: ['b2b'] },
    });
  });
  it('only ever hide things on the lead entity, scoped to a segment', () => {
    for (const k of Object.keys(setup.FIELD_OVERRIDES)) expect(k).toMatch(/^lead\.[a-z0-9_]+@(b2b|b2c)$/);
  });
  it('hide the consent block on both lead types, and the dealer marketing / WhatsApp boxes for symmetry', () => {
    for (const k of ['lead.data_consent@b2b', 'lead.data_consent@b2c', 'lead.marketing_consent@b2b', 'lead.whatsapp_consent@b2b',
      'lead.marketing_consent@b2c', 'lead.whatsapp_consent@b2c']) {
      expect({ k, o: setup.FIELD_OVERRIDES[k] }).toEqual({ k, o: { hidden: true, required: false } });
    }
  });
  it('are laid over an admin\'s own override of the same key, and re-planning changes nothing', () => {
    const once = setup.planSettings({ field_overrides: { 'lead.data_consent@b2b': { label: 'Consent', required: true } } });
    expect((once.config.field_overrides as Record<string, unknown>)['lead.data_consent@b2b']).toEqual({ hidden: true, required: false });
    expect(setup.planSettings(once.config)).toEqual(once);
    expect(v.settingsUpdateSchema.safeParse(once).success).toBe(true);
  });
});

describe('planning is idempotent', () => {
  it('creates everything on a fresh client', () => {
    expect(setup.planFields([]).map((s) => s.op)).toEqual(Array(setup.CUSTOM_FIELDS.length).fill('create'));
  });
  it('updates in place when run again, and never duplicates', () => {
    const existing = setup.CUSTOM_FIELDS.map((f, i) => ({ id: `id-${i}`, field_key: f.field_key, entity_type: 'lead' }));
    const steps = setup.planFields(existing);
    expect(steps.every((s) => s.op === 'update')).toBe(true);
    expect(steps.map((s) => (s as any).id)).toEqual(existing.map((e) => e.id));
  });
  it('mixes create and update, and ignores same-named keys on other entities', () => {
    const steps = setup.planFields([{ id: 'x', field_key: 'crop', entity_type: 'lead' }, { id: 'y', field_key: 'shop_image', entity_type: 'contact' }]);
    expect(steps.find((s) => s.field.field_key === 'crop')!.op).toBe('update');
    expect(steps.find((s) => s.field.field_key === 'shop_image')!.op).toBe('create');
  });
});
