import { todayDate } from './src/utils';
import { supabaseAdmin } from './src/lib/supabase';

async function simulate() {
  const userId = '5a412530-5623-4691-adf6-b6f155059940'; // Test FE
  const today = todayDate();
  console.log('Today:', today);

  const { data: attRecord, error } = await supabaseAdmin.from('attendance').select('*, breaks(*)').eq('user_id', userId).eq('date', today).maybeSingle();
  console.log('Attendance Record:', !!attRecord, attRecord?.status);
  if (error) console.error('Error:', error);
}
simulate();
