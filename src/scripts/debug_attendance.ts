import { supabaseAdmin } from '../lib/supabase';
import { todayDate } from '../utils';

async function debug() {
  const userId = '7d788549-6cb7-451d-832e-446c6cd63b72'; // Assume this is the user from logs
  const today = todayDate();
  console.log('Today:', today);
  
  const { data, error } = await supabaseAdmin.from('attendance').select('*').eq('date', today);
  console.log('Attendance Records for today:', JSON.stringify(data, null, 2));
}
debug();
