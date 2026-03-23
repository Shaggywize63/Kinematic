import 'dotenv/config';
import { supabaseAdmin } from './src/lib/supabase';

async function checkUsers() {
  const { count, error } = await supabaseAdmin
    .from('users')
    .select('*', { count: 'exact', head: true });

  if (error) {
    console.error('Error fetching users:', error);
    return;
  }

  console.log(`Total users in 'users' table: ${count}`);

  const { data: samples, error: sampleErr } = await supabaseAdmin
    .from('users')
    .select('id, name, role, email')
    .limit(5);

  if (sampleErr) {
     console.error('Error fetching sample users:', sampleErr);
  } else {
     console.log('Sample users:', samples);
  }

  const { count: authCount, error: authErr } = await supabaseAdmin.auth.admin.listUsers();
  if (authErr) {
    console.error('Error fetching auth users:', authErr);
  } else {
    console.log(`Total users in Auth: ${authCount?.length || (authCount as any)?.users?.length}`);
  }
}

checkUsers();
