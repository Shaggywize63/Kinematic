import { supabaseAdmin } from './src/lib/supabase';
import { todayDate } from './src/utils';

async function checkTestFE() {
  const today = todayDate();
  console.log('Today (IST):', today);

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, name, org_id')
    .ilike('name', '%Test FE%');

  console.log('Test FE Users:', users);

  if (users && users.length > 0) {
    for (const user of users) {
      console.log(`--- Checking for ${user.name} (${user.id}) ---`);
      
      const { data: att } = await supabaseAdmin
        .from('attendance')
        .select('*')
        .eq('user_id', user.id)
        .eq('date', today);
      console.log(`Today Attendance:`, att);

      const { count: formCount } = await supabaseAdmin
        .from('form_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('is_converted', true)
        .gte('submitted_at', `${today}T00:00:00+05:30`)
        .lte('submitted_at', `${today}T23:59:59+05:30`);
      
      console.log(`Today Converted Forms (with IST offset):`, formCount);

      const { count: formCountNoOffset } = await supabaseAdmin
        .from('form_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('is_converted', true)
        .gte('submitted_at', `${today}T00:00:00Z`)
        .lte('submitted_at', `${today}T23:59:59Z`);
      
      console.log(`Today Converted Forms (with UTC range):`, formCountNoOffset);
      
      const { data: recentForms } = await supabaseAdmin
        .from('form_submissions')
        .select('id, submitted_at, is_converted')
        .eq('user_id', user.id)
        .order('submitted_at', { ascending: false })
        .limit(5);
      console.log(`Recent 5 Forms:`, recentForms);
    }
  }
}

checkTestFE();
