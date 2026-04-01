import { supabaseAdmin } from '../lib/supabase';

async function listAll() {
  console.log('Listing all Supabase Auth users...');
  const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers();
  
  if (error) {
    console.error('Auth fetch failed:', error.message);
    return;
  }

  for (const u of users) {
    console.log(`- AUTH: ${u.email} (${u.id})`);
    
    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('id, email, name, role')
      .eq('id', u.id)
      .single();
      
    if (profile) {
      console.log(`  PROFILE FOUND: ${profile.email || profile.name} [Role: ${profile.role}]`);
    } else {
      console.log(`  !!! PROFILE MISSING in public.users table !!!`);
    }
  }
}

listAll();
