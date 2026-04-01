import { supabaseAdmin } from '../lib/supabase';

async function debugSchema() {
  console.log('Inspecting users table schema...');
  
  // Method 1: Try to fetch a single row with *
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .limit(1);
    
  if (error) {
    console.error('Fetch failed:', error.message);
    return;
  }
  
  if (data && data.length > 0) {
    const columns = Object.keys(data[0]);
    console.log('--- USERS TABLE COLUMNS ---');
    console.log(columns.join(', '));
    
    const suspicious = ['org_id', 'organisation_id', 'client_id'];
    suspicious.forEach(col => {
      console.log(`${col} exists: ${columns.includes(col)}`);
    });
  } else {
    console.log('No users found to inspect.');
  }
}

debugSchema();
