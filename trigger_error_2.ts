
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  console.log('--- Dumping Users Relationships via metadata ---');
  const { data, error } = await supabase.from('users').select('id, zones(*)').limit(1);
  if (error) {
     console.log('Error join zones:', error.message);
  }
}
check();
