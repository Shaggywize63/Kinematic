
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  console.log('--- Dumping Attendance Relationships via metadata ---');
  // We can't query information_schema directly via PostgREST easy select,
  // but we can try to find documentation in the codebase or just try hints.
  
  // I'll try to get ANY row from attendance with its relationships.
  const { data, error } = await supabase.from('attendance').select('id, user_id, users(*)').limit(1);
  if (error) {
     console.log('Direct users(*) join failed as expected:', error.message);
  }
}
check();
