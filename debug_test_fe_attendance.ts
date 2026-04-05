import { supabaseAdmin } from './src/lib/supabase';
import { todayDate } from './src/utils';

async function debug() {
  const today = todayDate();
  console.log('Today (IST):', today);

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, name')
    .ilike('name', '%Test FE%');

  console.log('Matching Users:', users);

  if (users && users.length > 0) {
    for (const user of users) {
      const { data: att } = await supabaseAdmin
        .from('attendance')
        .select('*')
        .eq('user_id', user.id)
        .eq('date', today);
      
      console.log(`Attendance for ${user.id} (${user.name}) on ${today}:`, att);
      
      // Also check ALL attendance for this user to see if date is different
      const { data: allAtt } = await supabaseAdmin
        .from('attendance')
        .select('*')
        .eq('user_id', user.id)
        .order('date', { ascending: false })
        .limit(5);
      console.log(`Last 5 records for ${user.name}:`, allAtt);
    }
  }
}

debug();
