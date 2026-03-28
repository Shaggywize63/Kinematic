const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  // Check for ANY views that might include visit_logs
  const { data: views, error: errV } = await supabase.rpc('get_views_using_table', { t_name: 'visit_logs' });
  console.log("Views using visit_logs:", views, "Error:", errV);

  // Check for any foreign keys that might be problematic
  const { data: fks, error: errF } = await supabase.rpc('get_fks', { t_name: 'visit_logs' });
  console.log("FKs of visit_logs:", fks, "Error:", errF);
}
run();
