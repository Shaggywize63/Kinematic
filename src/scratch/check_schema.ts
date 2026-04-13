
import { supabaseAdmin } from "./src/lib/supabase";

async function checkSchema() {
  const { data, error } = await supabaseAdmin.rpc('get_table_info', { table_name: 'builder_questions' });
  if (error) {
    console.error("Error fetching schema:", error);
    // Fallback: Try a simple select to see what fails
    const { data: d2, error: e2 } = await supabaseAdmin.from('builder_questions').select('*').limit(1);
    if (e2) {
        console.error("Select error:", e2.message);
    } else {
        console.log("Columns present:", Object.keys(d2[0] || {}));
    }
  } else {
    console.log("Schema info:", data);
  }
}

checkSchema();
