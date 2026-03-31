import { supabaseAdmin } from './src/lib/supabase';
async function repair() {
  console.log('Starting Client User Repair...');
  
  // 1. Get all Auth users
  const { data: { users: authUsers }, error: authErr } = await supabaseAdmin.auth.admin.listUsers();
  if (authErr) { console.error('Auth List Error:', authErr); return; }
  
  // 2. Get all Public users
  const { data: publicUsers } = await supabaseAdmin.from('users').select('id');
  const publicIds = publicUsers?.map(u => u.id) || [];
  
  // 3. Find client auth users missing a profile
  const toRepair = authUsers.filter(u => 
    (u.user_metadata?.role === 'client' || u.email?.includes('client')) && 
    !publicIds.includes(u.id)
  );
  
  console.log(`Found ${toRepair.length} orphaned client auth users.`);
  
  for (const u of toRepair) {
    console.log(`Repairing user: ${u.email} (${u.id})`);
    
    // We need an org_id. We'll use the default or try to find one.
    // Based on previous audits, org_id is '00000000-0000-0000-0000-000000000001'
    const org_id = '00000000-0000-0000-0000-000000000001';
    
    const { error: insErr } = await supabaseAdmin.from('users').upsert({
      id: u.id,
      org_id,
      name: u.user_metadata?.name || u.email?.split('@')[0],
      email: u.email,
      role: 'client',
      is_active: true
    });
    
    if (insErr) console.error(`Failed to repair ${u.email}:`, insErr.message);
    else console.log(`Successfully repaired ${u.email}`);
  }
  
  console.log('Repair Complete.');
  process.exit(0);
}
repair();
