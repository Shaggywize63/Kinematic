import { supabaseAdmin } from '../lib/supabase';

async function debugAccess() {
  console.log('Fetching all client module access...');
  const { data, error } = await supabaseAdmin
    .from('client_module_access')
    .select('*');
    
  if (error) {
    console.error('Fetch failed:', error.message);
    return;
  }
  
  console.log('--- CURRENT MODULE ACCESS ---');
  console.table(data);
  
  const distinctModules = [...new Set(data?.map(m => m.module_id))];
  console.log('Distinct modules used:', JSON.stringify(distinctModules, null, 2));
}

debugAccess();
