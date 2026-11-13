/**
 * Custom fields can be defined on a custom object, not just the built-in entities.
 * A custom object's fields live in crm_custom_field_defs with entity_type = <object.key>
 * (see customObjects.service.ts), so the field-def validator must accept a custom-object
 * key as entity_type — a hard enum of the five built-ins rejected it, which is the bug
 * behind "Invalid enum value ... received 'requirement'". The route separately verifies a
 * non-built-in key names a real custom object.
 */
import * as v from '../src/validators/crm.validators';

const base = { field_key: 'need_by', label: 'Needed by', field_type: 'date' as const };

describe('customFieldSchema entity_type', () => {
  it('accepts every built-in entity', () => {
    for (const et of ['lead', 'contact', 'account', 'deal', 'activity']) {
      const r = v.customFieldSchema.safeParse({ ...base, entity_type: et });
      expect({ et, ok: r.success }).toEqual({ et, ok: true });
    }
  });

  it("accepts a custom object's key (e.g. 'requirement') — the reported bug", () => {
    for (const et of ['requirement', 'discussion', 'site_visit', 'warranty_claim']) {
      const r = v.customFieldSchema.safeParse({ ...base, entity_type: et });
      expect({ et, ok: r.success }).toEqual({ et, ok: true });
    }
  });

  it('still rejects malformed entity_type values', () => {
    for (const et of ['', 'Requirement', 'has space', 'has-hyphen', '1leading', 'UPPER']) {
      const r = v.customFieldSchema.safeParse({ ...base, entity_type: et });
      expect({ et, ok: r.success }).toEqual({ et, ok: false });
    }
  });

  it('exposes the built-in list used by the route to decide when to check for a custom object', () => {
    expect([...v.CUSTOM_FIELD_BUILTIN_ENTITIES]).toEqual(['lead', 'contact', 'account', 'deal', 'activity']);
  });
});
