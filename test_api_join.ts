
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  console.log('--- Testing Attendance API Query ---');
  const orgId = '346b9a9d-5969-42b7-a367-5f11550974b2'; // Sample org
  const date = '2026-04-02';

  const { data, error } = await supabase
    .from('attendance')
    .select(`
      id, user_id, 
      users!user_id(name, zones!zone_id(name))
    `)
    .eq('org_id', orgId)
    .eq('date', date)
    .limit(1);

  if (error) {
    console.error('Query Error with !user_id:', error.message);
    
    // Try with constraint name
    const { data: d2, error: e2 } = await supabase
      .from('attendance')
      .select(`
        id, user_id, 
        users!attendance_user_id_fkey(name, zones!zone_id(name))
      `)
      .eq('org_id', orgId)
      .eq('date', date)
      .limit(1);
      
    if (e2) {
      console.error('Query Error with !attendance_user_id_fkey:', e2.message);
    } else {
      console.log('SUCCESS with !attendance_user_id_fkey');
    }
  } else {
    console.log('SUCCESS with !user_id');
  }
}
check();
