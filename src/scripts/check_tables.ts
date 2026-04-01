import { supabaseAdmin } from '../lib/supabase';

async function checkTables() {
  const tables = ['cities', 'stores', 'skus', 'activities'];
  
  for (const table of tables) {
    console.log(`Checking table: ${table}...`);
    // Sample one row to see columns, or use rpc/query if possible
    const { data, error } = await supabaseAdmin.from(table).select('*').limit(1);
    
    if (error) {
      console.error(`Error checking ${table}:`, error.message);
      continue;
    }
    
    if (data && data.length > 0) {
      console.log(`Columns in ${table}:`, Object.keys(data[0]));
    } else {
       // If no data, try to get column names from information_schema
       const { data: cols, error: colErr } = await supabaseAdmin.rpc('get_table_columns', { table_name: table });
       if (colErr) {
         console.log(`No data in ${table} and RPC failed. Trying raw query...`);
         // Raw query fallback via REST
       } else {
         console.log(`Columns in ${table} (via RPC):`, cols);
       }
    }
  }
}

checkTables();
