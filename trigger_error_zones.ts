
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  console.log('--- Inducing Error for Users -> Zones ---');
  const { error } = await supabase.from('users').select('id, zones(*)').limit(1);
  if (error) {
     console.log('--- HINT ---');
     console.log((error as any).hint);
  } else {
     console.log('SUCCESS (only one relationship for users->zones)');
  }
}
check();
