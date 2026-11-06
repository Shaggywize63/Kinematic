/** Settings -> Industries: shape of crm_settings.config.industries (name + colour + sub-industries). */
import { industriesConfigSchema, settingsUpdateSchema } from '../src/validators/crm.validators';

describe('industriesConfigSchema', () => {
  it('accepts industries with a colour and sub-industries, defaulting the sub list', () => {
    const r = industriesConfigSchema.parse([
      { name: 'Manufacturing', color: '#2563EB', sub_industries: ['Steel', 'Cement'] },
      { name: 'Other', color: '#6b7280' },
    ]);
    expect(r[0].sub_industries).toEqual(['Steel', 'Cement']);
    expect(r[1].sub_industries).toEqual([]);
  });
  it('rejects a colour that is not #RRGGBB', () => {
    for (const bad of ['red', '#fff', '2563EB', '#2563EBFF', '']) {
      expect(industriesConfigSchema.safeParse([{ name: 'A', color: bad }]).success).toBe(false);
    }
  });
  it('rejects blank and duplicate names (case-insensitive), and duplicate sub-industries', () => {
    expect(industriesConfigSchema.safeParse([{ name: '  ', color: '#000000' }]).success).toBe(false);
    expect(industriesConfigSchema.safeParse([{ name: 'Pharma', color: '#000000' }, { name: 'pharma', color: '#111111' }]).success).toBe(false);
    expect(industriesConfigSchema.safeParse([{ name: 'A', color: '#000000', sub_industries: ['x', 'X'] }]).success).toBe(false);
  });
  it('is validated inside a settings update, and null clears it', () => {
    expect(settingsUpdateSchema.safeParse({ config: { industries: [{ name: 'A', color: 'nope' }] } }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ config: { industries: [{ name: 'A', color: '#123456' }] } }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ config: { industries: null } }).success).toBe(true);
  });
});
