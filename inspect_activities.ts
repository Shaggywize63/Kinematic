import { supabaseAdmin } from './src/lib/supabase';

async function listRecentActivities() {
  const { data, error } = await supabaseAdmin
    .from('work_activity')
    .select('*, users!user_id(name)')
    .order('captured_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Latest Work Activities:');
    data?.forEach(r => {
      console.log(`- Type: ${r.activity_type}, User: ${(r.users as any)?.name}, At: ${r.captured_at}, Lat: ${r.lat}, Lng: ${r.lng}`);
    });
  }
}

listRecentActivities();
