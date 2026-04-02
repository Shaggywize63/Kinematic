
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const { data, error } = await supabase.from('attendance').select('id, user_id, checkin_address').limit(1);
  if (error) {
    console.error('Attendance select FAILED:', error.message);
  } else {
    console.log('Attendance select SUCCESS');
  }
}
check();
