jest.mock('../src/lib/supabase', () => ({ supabaseAdmin: {} }));
import { isPlatformAdmin } from '../src/services/crm/messaging.service';

describe('isPlatformAdmin (messaging bypass)', () => {
  it('is an admin-tier test on the role', () => {
    for (const r of ['super_admin', 'admin', 'main_admin', 'sub_admin', 'master_admin', 'client_admin', 'Super-Admin']) {
      expect(isPlatformAdmin(r, 'Someone')).toBe(true);
    }
    for (const r of ['executive', 'field_executive', 'supervisor', 'hr', 'city_manager', undefined]) {
      expect(isPlatformAdmin(r as string | undefined, 'Someone')).toBe(false);
    }
  });

  it('is not granted by a display name', () => {
    expect(isPlatformAdmin('executive', 'Sagar')).toBe(false);
    expect(isPlatformAdmin('field_executive', ' sagar ')).toBe(false);
  });
});
