
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  console.log('--- Testing Attendance API Query with Filter ---');
  const orgId = '346b9a9d-5969-42b7-a367-5f11550974b2';
  const date = '2026-04-02';

  // Base query that works
  const { error: e1 } = await supabase
    .from('attendance')
    .select('id, users!user_id(name)')
    .eq('org_id', orgId)
    .eq('date', date)
    .limit(1);
  console.log('Base query:', e1 ? 'FAILED: ' + e1.message : 'SUCCESS');

  // Query with users filter
  const { error: e2 } = await supabase
    .from('attendance')
    .select('id, users!user_id(name)')
    .eq('org_id', orgId)
    .eq('date', date)
    .eq('users.city', 'Mumbai') // Like in the controller
    .limit(1);
  console.log('Query with users.city filter:', e2 ? 'FAILED: ' + e2.message : 'SUCCESS');

  // Query with inner join hint
  const { error: e3 } = await supabase
    .from('attendance')
    .select('id, users!user_id!inner(name)')
    .eq('org_id', orgId)
    .eq('date', date)
    .eq('users.city', 'Mumbai')
    .limit(1);
  console.log('Query with users!inner and users.city:', e3 ? 'FAILED: ' + e3.message : 'SUCCESS');
}
check();
