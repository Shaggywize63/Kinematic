import { supabaseAdmin } from '../lib/supabase';

async function repair() {
  console.log('Starting administrative permission repair...');
  
  const modules = [
    'analytics', 'live_tracking', 'broadcast', 'attendance', 'orders',
    'work_activities', 'users', 'hr', 'visit_logs', 'inventory',
    'skus', 'assets', 'grievances', 'form_builder', 'cities',
    'zones', 'stores', 'activities', 'clients', 'settings'
  ];

  // Identifies administrative accounts
  const { data: users, error: userErr } = await supabaseAdmin
    .from('users')
    .select('id, email, name, role')
    .in('role', ['admin', 'sub_admin']);
    
  if (userErr) {
    console.error('Fetch admins failed:', userErr.message);
    return;
  }
  
  if (!users || users.length === 0) {
    console.log('No admin accounts to repair.');
    return;
  }

  for (const user of users) {
    console.log(`Repairing permissions for ${user.email || user.name} (${user.role})...`);
    
    // Clear old permissions
    await supabaseAdmin
      .from('user_module_permissions')
      .delete()
      .eq('user_id', user.id);
      
    // Insert all 20 modules
    const payload = modules.map(m => ({ user_id: user.id, module_id: m }));
    const { error: permErr } = await supabaseAdmin
      .from('user_module_permissions')
      .insert(payload);
      
    if (permErr) {
      console.error(`Failed for ${user.email}:`, permErr.message);
    } else {
      console.log(`Successfully granted 20 modules to ${user.email}.`);
    }
  }
  
  console.log('Repair complete.');
}

repair();
