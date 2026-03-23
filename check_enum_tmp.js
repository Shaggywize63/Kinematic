const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkSchema() {
    // Check work_activity table
    const { data, error } = await supabase.rpc('get_enum_values', { enum_name: 'activity_type' });
    if (error) {
        console.error("Error fetching enum via RPC:", error.message);
        // Fallback: try to insert a dummy and see error
        const { error: insertError } = await supabase.from('work_activity').insert({ activity_type: 'INVALID_ENUM' }).limit(1);
        console.log("Insert Error (to see valid values):", insertError.message);
    } else {
        console.log("Valid activity_type values:", data);
    }
}

checkSchema();
