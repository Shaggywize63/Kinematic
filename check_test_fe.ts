import { supabaseAdmin } from './src/lib/supabase';

async function checkIndividual() {
  const userId = '5a412530-5623-4691-adf6-b6f155059940';
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error:', error);
  } else {
    console.log(`Attendance records for 5a412530...:`);
    data?.forEach(r => {
      console.log(`- ID: ${r.id}, Date: ${r.date}, Status: ${r.status}, At: ${r.created_at}`);
    });
  }
}

checkIndividual();
