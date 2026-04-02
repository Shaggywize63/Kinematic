import { supabaseAdmin } from './src/lib/supabase';

async function listRecentAttendance() {
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*, users!user_id(name, role)')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Latest Attendance Records:');
    data?.forEach(r => {
      console.log(`- ID: ${r.id}, Date: ${r.date}, User: ${(r.users as any)?.name} (${(r.users as any)?.role}), Status: ${r.status}, CreatedAt: ${r.created_at}`);
    });
  }
}

listRecentAttendance();
