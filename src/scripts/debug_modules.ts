import { supabaseAdmin } from '../lib/supabase';

async function debug() {
  console.log('Fetching modules from DB...');
  const { data, error } = await supabaseAdmin
    .from('modules')
    .select('*')
    .order('id');
    
  if (error) {
    console.error('Fetch failed:', error.message);
    return;
  }
  
  if (data) {
    const ids = data.map(m => m.id);
    console.log('--- DATABASE MODULE IDs ---');
    console.log(JSON.stringify(ids, null, 2));
    console.log('Total count:', ids.length);
  }
}

debug();
