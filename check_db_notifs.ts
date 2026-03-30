import { supabaseAdmin } from './src/lib/supabase';

async function check() {
  const { data, error } = await supabaseAdmin.from('notifications').select('*').order('created_at', { ascending: false }).limit(2);
  console.log('Error:', error);
  console.log('Data:', data);
}

check();
