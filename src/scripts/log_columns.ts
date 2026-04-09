import { supabaseAdmin } from '../lib/supabase';

async function log() {
  const { data, error } = await supabaseAdmin.from('attendance').select('*').limit(1);
  if (data && data.length > 0) {
    console.log('Attendance Columns:', Object.keys(data[0]));
  }
}
log();
