import { supabaseAdmin } from '../lib/supabase';

async function seed() {
  console.log('🚀 Starting Database Seeding & Permission Sync...');

  try {
    // 1. Grant missing permissions (zones, inventory) to all admins/super_admins
    const { data: admins } = await supabaseAdmin
      .from('users')
      .select('id, name')
      .in('role', ['admin', 'super_admin', 'main_admin']);

    if (admins && admins.length > 0) {
      console.log(`🔑 Granting permissions to ${admins.length} admins...`);
      const modules = [
        'dashboard', 'analytics', 'users', 'attendance', 'zones', 'inventory', 
        'grievances', 'sos', 'orders', 'work_activities', 'hr', 'visit_logs', 
        'clients', 'form_builder', 'settings', 'cities', 'stores', 'skus', 
        'activities', 'assets'
      ];
      for (const admin of admins) {
        for (const mId of modules) {
          await supabaseAdmin
            .from('user_module_permissions')
            .upsert({ user_id: admin.id, module_id: mId, org_id: (admin as any).org_id }, { onConflict: 'user_id,module_id' });
        }
      }
    }

    // 2. Create Sample Cities
    const cities = [
      { name: 'Mumbai', state: 'Maharashtra' },
      { name: 'Delhi', state: 'Delhi' },
      { name: 'Bangalore', state: 'Karnataka' },
    ];
    console.log('🏙️ Seeding Cities...');
    const { data: cityData } = await supabaseAdmin.from('cities').upsert(cities, { onConflict: 'name' }).select();

    // 3. Create Sample Zones
    const cityMap = new Map(cityData?.map(c => [c.name, c.id]));
    const zones = [
      { name: 'Andheri West', city: 'Mumbai', city_id: cityMap.get('Mumbai'), geofence_radius: 500, is_active: true },
      { name: 'Dwarka Sector 10', city: 'Delhi', city_id: cityMap.get('Delhi'), geofence_radius: 500, is_active: true },
      { name: 'Indiranagar', city: 'Bangalore', city_id: cityMap.get('Bangalore'), geofence_radius: 500, is_active: true },
    ];
    console.log('📍 Seeding Zones...');
    const { data: zoneData } = await supabaseAdmin.from('zones').upsert(zones, { onConflict: 'name' }).select();

    // 4. Create Sample Field Executives
    const zoneMap = new Map(zoneData?.map(z => [z.name, z.id]));
    const firstOrg = (admins && admins[0] as any)?.org_id;
    
    if (firstOrg) {
      const fes = [
        { name: 'Rahul Sharma', email: 'rahul.s@kinematic.demo', role: 'executive', city: 'Mumbai', zone_id: zoneMap.get('Andheri West'), org_id: firstOrg, is_active: true, employee_id: 'FE-001' },
        { name: 'Amit Kumar', email: 'amit.k@kinematic.demo', role: 'executive', city: 'Delhi', zone_id: zoneMap.get('Dwarka Sector 10'), org_id: firstOrg, is_active: true, employee_id: 'FE-002' },
        { name: 'Priya Singh', email: 'priya.s@kinematic.demo', role: 'executive', city: 'Bangalore', zone_id: zoneMap.get('Indiranagar'), org_id: firstOrg, is_active: true, employee_id: 'FE-003' },
        { name: 'Vikram Das', email: 'vikram.d@kinematic.demo', role: 'executive', city: 'Mumbai', zone_id: zoneMap.get('Andheri West'), org_id: firstOrg, is_active: true, employee_id: 'FE-004' },
        { name: 'Anjali Rao', email: 'anjali.r@kinematic.demo', role: 'executive', city: 'Delhi', zone_id: zoneMap.get('Dwarka Sector 10'), org_id: firstOrg, is_active: true, employee_id: 'FE-005' },
      ];
      console.log('👷 Seeding Field Executives...');
      await supabaseAdmin.from('users').upsert(fes, { onConflict: 'email' });
    }

    console.log('✅ Seeding & Permission Sync complete!');
  } catch (error) {
    console.error('❌ Seeding failed:', error);
  }
}

seed();
