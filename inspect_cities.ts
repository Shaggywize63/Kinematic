
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const { data, error } = await supabase.from('cities').select('*').limit(1);
  if (data?.[0]) console.log('Cities keys:', Object.keys(data[0]));
  else if (error) console.error('Error fetching cities:', error.message);
  else console.log('No cities found to inspect.');
}
check();
