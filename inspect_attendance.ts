
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const { data: cols } = await supabase.from('attendance').select('*').limit(1);
  console.log('Attendance keys:', Object.keys(cols?.[0] || {}));
}
check();
