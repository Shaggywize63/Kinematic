import { supabaseAdmin } from '../lib/supabase';

async function log() {
  const { data, error } = await supabaseAdmin.rpc('get_column_details', { table_name: 'attendance' });
  console.log('Column details:', data || error);
}
log();
