
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const tables = ['attendance', 'users', 'form_submissions', 'sos_alerts', 'visit_logs'];
  console.log('Checking Foreign Keys for Tables:', tables.join(', '));
  
  for (const table of tables) {
    const { data, error } = await supabase.rpc('get_table_constraints', { table_name: table });
    if (error) {
      console.log(`Table ${table}: RPC error - ${error.message}. Checking columns instead...`);
      const { data: cols } = await supabase.from(table).select('*').limit(1);
      console.log(`Table ${table} columns:`, Object.keys(cols?.[0] || {}));
    } else {
      console.log(`Table ${table} Constraints:`, data);
    }
  }
}
check();
