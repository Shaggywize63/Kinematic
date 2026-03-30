import { supabaseAdmin } from './src/lib/supabase';

async function checkRecentNotifs() {
  const { data, error } = await supabaseAdmin.from('notifications').select('*').order('created_at', { ascending: false }).limit(5);
  if (error) {
    console.error('Check failed:', error.message);
  } else {
    console.log('Recent Notifications in DB:', JSON.stringify(data, null, 2));
  }
}

checkRecentNotifs();
