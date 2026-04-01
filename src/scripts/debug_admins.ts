import { supabaseAdmin } from '../lib/supabase';

async function debugAdmins() {
  console.log('Fetching admin-level users...');
  const { data: users, error: userErr } = await supabaseAdmin
    .from('users')
    .select('id, email, name, role, client_id')
    .in('role', ['super_admin', 'admin', 'sub_admin']);
    
  if (userErr) {
    console.error('Fetch failed:', userErr.message);
    return;
  }
  
  console.log('--- ADMIN USERS ---');
  console.table(users);
  
  for (const user of users || []) {
    const { data: perms } = await supabaseAdmin
      .from('user_module_permissions')
      .select('module_id')
      .eq('user_id', user.id);
      
    console.log(`Permissions for ${user.email || user.name} (${user.role}):`, (perms || []).map(p => p.module_id));
  }
}

debugAdmins();
