
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  console.log('--- Checking Foreign Keys via SQL Query ---');
  const { data, error } = await supabase.rpc('query_api', { query: `
    SELECT
      tc.table_name, 
      kcu.column_name, 
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      tc.constraint_name
    FROM 
      information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' 
    AND tc.table_name IN ('attendance', 'users', 'form_submissions')
  `});

  if (error) {
    console.error('RPC Error (query_api might not exist):', error.message);
    // Fallback: Just dump table structure for clues
    const { data: cols } = await supabase.from('attendance').select('*').limit(1);
    console.log('Attendance keys:', Object.keys(cols?.[0] || {}));
  } else {
    console.table(data);
  }
}
check();
