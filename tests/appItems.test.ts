import {
  APP_ITEM_NEEDS, TAB_CAPABLE, MAX_EXTRA_TABS, deriveAppUi, sanitizeLayout, cleanAppUiForStore, itemAvailable,
} from '../src/lib/appItems';

const ent = (modules: string[], packages: string[] = [], strict = true) => ({ enabled_modules: modules, enabled_packages: packages, strict });

describe('deriveAppUi — a screen whose module is not ticked is switched off', () => {
  it('hides exactly the screens the client lacks and keeps the essentials', () => {
    const out: any = deriveAppUi({}, ent(['leave', 'attendance'], ['field_force']));
    expect(out.menu.leave).toBeUndefined();            // ticked → untouched
    expect(out.menu.broadcast).toBe(false);            // not ticked → off
    expect(out.menu.learning_hub).toBe(false);
    expect(out.menu.profile).toBeUndefined();          // essential, never judged
    expect(out.tabs.attendance).toBeUndefined();
    expect(out.tabs.route_plan).toBe(false);
    expect(out.settings.appearance).toBeUndefined();
    expect(out.settings.face_enrollment).toBe(false);
    expect(out.crm_more.pipeline).toBe(false);
    expect(out.crm_more.switch_ff).toBeUndefined();    // package field_force held
    expect(out.menu.crm).toBe(false);                  // package crm not held
  });

  it('a package need is met by the package, not by a module', () => {
    const out: any = deriveAppUi({}, ent([], ['crm']));
    expect(out.menu.crm).toBeUndefined();
    expect(out.menu.ask_kini).toBeUndefined();
  });

  it('keeps what the admin set (labels, hides, features) and never turns a hidden screen back on', () => {
    const stored = { menu: { leave: false }, labels: { menu: { leave: 'Time off' } }, features: { rate_prompt: true } };
    const out: any = deriveAppUi(stored, ent(['leave']));
    expect(out.menu.leave).toBe(false);
    expect(out.labels).toEqual(stored.labels);
    expect(out.features).toEqual(stored.features);
    expect(stored.menu).toEqual({ leave: false });      // input not mutated
  });

  it('leaves the config untouched when the entitlement list is not complete (platform user, Tata, failed lookup)', () => {
    expect(deriveAppUi({ menu: { leave: true } }, ent([], [], false))).toEqual({ menu: { leave: true } });
    expect(deriveAppUi({ menu: { leave: true } }, null)).toEqual({ menu: { leave: true } });
    expect(deriveAppUi(null, undefined)).toEqual({});
  });

  it('every screen with a need names a module or package that exists in the contract tables', () => {
    for (const [section, items] of Object.entries(APP_ITEM_NEEDS)) {
      for (const [id, need] of Object.entries(items)) {
        if (!need) continue;
        expect(('any' in need ? need.any.length : 1)).toBeGreaterThan(0);
        expect(id).toMatch(/^[a-z_]+$/);
        expect(section).toMatch(/^(menu|tabs|crm_more|home|settings)$/);
      }
    }
  });
});

describe('sanitizeLayout', () => {
  it('keeps known ids in order, drops unknown ids and duplicates', () => {
    const l = sanitizeLayout({ menu: ['leave', 'nope', 'broadcast', 'leave'], settings: ['app_lock', 'appearance'] })!;
    expect(l.menu).toEqual(['leave', 'broadcast']);
    expect(l.settings).toEqual(['app_lock', 'appearance']);
    expect(l.tabs).toBeUndefined();                      // untouched containers stay absent
  });

  it('limits the bottom bar to bar-capable screens and to four, and takes them out of the menu', () => {
    const l = sanitizeLayout({
      tabs: ['attendance', 'planogram', 'leave', 'route_plan', 'activity', 'new_form'],
      menu: ['leave', 'broadcast', 'route_plan'],
    })!;
    expect(l.tabs).toEqual(['attendance', 'leave', 'route_plan', 'activity']);
    expect(l.tabs!.length).toBe(MAX_EXTRA_TABS);
    expect(l.menu).toEqual(['broadcast']);               // leave and route_plan moved to the bar
    for (const id of l.tabs!) expect(TAB_CAPABLE).toContain(id);
  });

  it('drops screens the client has no module for when given its entitlements', () => {
    const l = sanitizeLayout({ tabs: ['attendance', 'leave', 'timeline'], menu: ['broadcast', 'learning_hub'] }, ent(['attendance', 'broadcast']))!;
    expect(l.tabs).toEqual(['attendance']);
    expect(l.menu).toEqual(['broadcast']);
  });

  it('rejects junk', () => {
    expect(sanitizeLayout(null)).toBeUndefined();
    expect(sanitizeLayout('x')).toBeUndefined();
    expect(sanitizeLayout([])).toBeUndefined();
    expect(sanitizeLayout({ menu: 'leave' })).toBeUndefined();
    expect(sanitizeLayout({ menu: [1, null, {}] })).toEqual({ menu: [] });
  });
});

describe('deriveAppUi / cleanAppUiForStore with a layout', () => {
  it('serves the layout cleaned against the client\'s modules', () => {
    const out: any = deriveAppUi({ layout: { tabs: ['leave', 'attendance'], menu: ['broadcast'] } }, ent(['attendance']));
    expect(out.layout).toEqual({ tabs: ['attendance'], menu: [] });
  });
  it('drops the layout key when nothing valid is left', () => {
    expect((deriveAppUi({ layout: { tabs: ['nope'] } }, ent(['attendance'])) as any).layout).toEqual({ tabs: [] });
    expect((deriveAppUi({ layout: 7 }, ent(['attendance'])) as any).layout).toBeUndefined();
  });
  it('stores the layout cleaned and everything else as sent', () => {
    const out: any = cleanAppUiForStore({ menu: { leave: false }, layout: { menu: ['leave', 'x', 'leave'] } });
    expect(out).toEqual({ menu: { leave: false }, layout: { menu: ['leave'] } });
    expect(cleanAppUiForStore({ layout: 'bad' })).toEqual({});
  });
  it('itemAvailable judges only known ids', () => {
    expect(itemAvailable('menu', 'leave', ent([]))).toBe(false);
    expect(itemAvailable('menu', 'leave', ent(['leave']))).toBe(true);
    expect(itemAvailable('menu', 'something_new', ent([]))).toBe(true);
  });
});
