
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const { data: users } = await supabase.from('users').select('id, org_id').limit(1);
  if (users?.[0]) {
    const { data, error } = await supabase.from('attendance').select('id').eq('user_id', users[0].id).limit(1);
    if (data?.[0]) {
      console.log('Attendance keys for user:', Object.keys(data[0]));
    } else {
      console.log('No attendance for user.');
    }
  }
}
check();
