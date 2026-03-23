const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: acts, error } = await supabase.from('activities').select('id, name, type').limit(10);
  console.log("Activities:", acts, "Error:", error);
}
run();
run();
