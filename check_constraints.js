const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data, error } = await supabase.rpc('get_table_constraints', { table_name: 'visit_logs' });
  if (error) {
    // If RPC doesn't exist, try query to direct table if permissions allow
    const { data: cols, error: err2 } = await supabase.from('visit_logs').select('*').limit(1);
    console.log("VisitLogs Columns:", Object.keys(cols?.[0] || {}), "Error:", err2);
  } else {
    console.log("Constraints:", data);
  }
}
run();
