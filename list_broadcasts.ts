import { supabaseAdmin } from './src/lib/supabase';

async function list() {
  const { data, error } = await supabaseAdmin.from('notification_broadcasts').select('*').order('created_at', { ascending: false }).limit(5);
  console.log(JSON.stringify(data, null, 2));
}
list();
