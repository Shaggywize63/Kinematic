
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const { error } = await supabase.from('attendance').select('checkin_address').limit(1);
  if (error) {
    console.log('checkin_address DOES NOT EXIST:', error.message);
  } else {
    console.log('checkin_address EXISTS');
  }
}
check();
