import { supabaseAdmin } from './src/lib/supabase';

async function check() {
  const { data, error } = await supabaseAdmin.rpc('get_table_columns', { table_name: 'form_responses' });
  if (error) {
    // If RPC doesn't exist, try a direct query to information_schema
    const { data: cols, error: err2 } = await supabaseAdmin
      .from('form_responses')
      .select('*')
      .limit(1);
    
    if (err2) {
       console.log('Error fetching columns:', err2.message);
    } else {
       console.log('Columns in form_responses:', Object.keys(cols[0] || {}));
    }
  } else {
    console.log('Columns:', data);
  }
}

check();
