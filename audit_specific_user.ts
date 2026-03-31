import { supabaseAdmin } from './src/lib/supabase';
async function run() {
  const email = 'gaurav@livpure.com';
  console.log(`Checking Auth for: ${email}`);
  
  const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers();
  if (error) { console.error(error); return; }
  
  const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
  if (user) {
    console.log('Found Auth User:', JSON.stringify({ id: user.id, email: user.email, metadata: user.user_metadata }, null, 2));
    
    // Check if profile exists
    const { data: profile } = await supabaseAdmin.from('users').select('*').eq('id', user.id).single();
    if (profile) {
      console.log('Found Public Profile:', JSON.stringify(profile, null, 2));
    } else {
      console.log('MISSING Public Profile!');
    }
  } else {
    console.log('User NOT found in Auth system.');
  }
  process.exit(0);
}
run();
