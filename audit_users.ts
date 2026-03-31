import { supabaseAdmin } from './src/lib/supabase';
async function run() {
  const { data: users } = await supabaseAdmin.from('users').select('*').limit(10).order('created_at', { ascending: false });
  console.log('Recent Public Users:', JSON.stringify(users, null, 2));
  
  const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
  console.log('Recent Auth Users:', JSON.stringify(authUsers.users.slice(0, 10).map(u => ({ id: u.id, email: u.email })), null, 2));
  process.exit(0);
}
run();
