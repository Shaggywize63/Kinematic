import { supabaseAdmin } from './src/lib/supabase';
async function run() {
  const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
  const authEmails = authUsers.users.map(u => u.email?.toLowerCase());
  
  const { data: publicUsers } = await supabaseAdmin.from('users').select('email');
  const publicEmails = publicUsers?.map(u => u.email?.toLowerCase()) || [];
  
  const orphanedAuth = authUsers.users.filter(u => u.email && !publicEmails.includes(u.email.toLowerCase()));
  
  console.log('Orphaned Auth Users (Auth exists but no Profile):', JSON.stringify(orphanedAuth.map(u => ({ id: u.id, email: u.email })), null, 2));
  
  const { data: clientUsers } = await supabaseAdmin.from('users').select('*').eq('role', 'client');
  console.log('Users with role client:', JSON.stringify(clientUsers, null, 2));
  
  process.exit(0);
}
run();
