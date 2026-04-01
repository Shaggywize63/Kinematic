import { supabaseAdmin } from '../lib/supabase';

async function debugSchema() {
  console.log('Fetching schema info for client_module_access...');
  
  const sql = `
    SELECT
        tc.table_schema, 
        tc.constraint_name, 
        tc.table_name, 
        kcu.column_name, 
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name 
    FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name='client_module_access';
  `;

  const { data, error } = await supabaseAdmin.rpc('exec_sql_query', { sql_query: sql });
  
  if (error) {
    // If exec_sql_query doesn't exist, try raw or different approach
    console.error('Schema fetch failed:', error.message);
    return;
  }
  
  console.log('--- FOREIGN KEY CONSTRAINTS ---');
  console.table(data);
}

debugSchema();
