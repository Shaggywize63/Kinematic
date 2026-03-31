import { supabaseAdmin } from '../lib/supabase';

async function checkEnum() {
  console.log('🔍 Checking user_role enum values...');
  try {
    const { data, error } = await supabaseAdmin.rpc('exec_sql', { 
      sql_query: "SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE pg_type.typname = 'user_role'" 
    });

    if (error) {
      console.error('❌ Failed to retrieve enum values:', error.message);
    } else {
      console.log('✅ Valid roles found:');
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (err: any) {
    console.error('❌ Unexpected error:', err.message);
  }
}

checkEnum();
