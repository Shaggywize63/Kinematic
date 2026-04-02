
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const { error } = await supabase.from('cities').select('id, clients(*)').limit(1);
  if (error) {
     console.log('--- HINT ---');
     console.log((error as any).hint);
  } else {
     console.log('SUCCESS (only one relationship for cities->clients)');
  }
}
check();
