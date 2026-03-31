import { supabaseAdmin } from './src/lib/supabase';
async function debug() {
  const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers();
  if (error) { console.error(error); return; }
  
  console.log('User Metadata Samples:');
  users.slice(0, 20).forEach(u => {
    console.log(`Email: ${u.email}, ID: ${u.id}, Metadata:`, JSON.stringify(u.user_metadata, null, 2));
  });
  process.exit(0);
}
debug();
