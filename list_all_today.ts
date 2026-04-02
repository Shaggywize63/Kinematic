import { supabaseAdmin } from './src/lib/supabase';

async function listAllToday() {
  const today = new Date(new Date().getTime() + 5.5 * 3600000).toISOString().split('T')[0];
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*, users!user_id(name)')
    .eq('date', today);

  if (error) {
    console.error('Error:', error);
  } else {
    console.log(`All Attendance Records for ${today}:`);
    data?.forEach(r => {
      console.log(`- User: ${(r.users as any)?.name}, ID: ${r.id}, At: ${r.created_at}`);
    });
  }
}

listAllToday();
