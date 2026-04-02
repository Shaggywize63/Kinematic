import { supabaseAdmin } from './src/lib/supabase';

async function listUsers() {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, name, mobile, role')
    .limit(10);

  if (error) {
    console.error('Error:', error);
  } else {
    console.log('User List:', JSON.stringify(data, null, 2));
  }
}

listUsers();
