import { supabaseAdmin } from '../lib/supabase';

async function listTables() {
  console.log('🔍 Listing database tables...');
  try {
    const { data, error } = await supabaseAdmin.rpc('exec_sql', { 
      sql_query: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'" 
    });

    if (error) {
      console.error('❌ Failed to list tables:', error.message);
    } else {
      console.log('✅ Tables in public schema:');
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (err: any) {
    console.error('❌ Unexpected error:', err.message);
  }
}

listTables();
