import { supabaseAdmin } from './src/lib/supabase';
async function run() {
  const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers();
  if (error) { console.error(error); return; }
  
  console.log('All Auth Emails:');
  users.forEach(u => {
    console.log(`- ${u.email} (${u.id})`);
  });
  process.exit(0);
}
run();
