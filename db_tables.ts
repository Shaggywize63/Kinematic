import { supabaseAdmin } from './src/lib/supabase';

async function listTables() {
  const { data, error } = await supabaseAdmin.rpc('get_tables'); // If a custom RPC exists
  if (error) {
    // Fallback: query a known table and check metadata
    const { data: users, error: uErr } = await supabaseAdmin.from('users').select('*').limit(1);
    console.log('Users table exists:', !uErr);
    
    // Try to find if 'organizations' or 'orgs' exists
    const { error: oErr } = await supabaseAdmin.from('organizations').select('id').limit(1);
    console.log('organizations table exists:', !oErr);
    
    const { error: orErr } = await supabaseAdmin.from('orgs').select('id').limit(1);
    console.log('orgs table exists:', !orErr);

    const { error: cErr } = await supabaseAdmin.from('companies').select('id').limit(1);
    console.log('companies table exists:', !cErr);
  } else {
    console.log('Tables:', data);
  }
}

listTables();
