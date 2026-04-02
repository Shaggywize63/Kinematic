
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  // Query a specific row we know exists or just get any row from attendance
  const { data, error } = await supabase.from('attendance').select('*').limit(1);
  if (data && data.length > 0) {
    console.log('Attendance keys:', Object.keys(data[0]));
  } else {
    console.log('No rows in attendance table. Checking columns via RPC...');
    const { data: cols, error: err2 } = await supabase.rpc('get_table_columns', { table_name: 'attendance' });
    if (err2) {
       console.log('RPC get_table_columns failing. Trying to find any table with data to check connection.');
       const { data: users } = await supabase.from('users').select('*').limit(1);
       if (users) console.log('Users keys:', Object.keys(users[0]));
    } else {
       console.log('Columns:', cols);
    }
  }
}
check();
