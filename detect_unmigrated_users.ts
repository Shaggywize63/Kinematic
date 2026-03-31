import { supabaseAdmin } from './src/lib/supabase';
async function detect() {
  console.log('Detecting unmigrated users (Profile exists but NO Auth account)...');
  
  // 1. Get all Public users with an email
  const { data: publicUsers } = await supabaseAdmin.from('users').select('id, email, name, role, password_hash').not('email', 'is', null);
  if (!publicUsers) { console.log('No public users found with emails.'); return; }
  
  // 2. Get all Auth users
  const { data: { users: authUsers } } = await supabaseAdmin.auth.admin.listUsers();
  const authEmails = authUsers.map(u => u.email?.toLowerCase());
  
  // 3. Find missing ones
  const missing = publicUsers.filter(u => u.email && !authEmails.includes(u.email.toLowerCase()));
  
  console.log(`Found ${missing.length} unmigrated users in public.users:`);
  missing.forEach(u => {
    console.log(`- ${u.name} (${u.email}) [Role: ${u.role}] (Password present: ${!!u.password_hash})`);
  });
  
  process.exit(0);
}
detect();
