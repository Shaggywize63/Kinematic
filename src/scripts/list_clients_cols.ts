import { supabaseAdmin } from '../lib/supabase';

async function listColumns() {
  console.log('Fetching 1 row from clients to see columns...');
  const { data, error } = await supabaseAdmin.from('clients').select('*').limit(1);
  if (error) {
    console.error('Error fetching from clients:', error.message);
  } else {
    if (data && data.length > 0) {
      console.log('Columns found:', Object.keys(data[0]));
      console.log('Sample row:', data[0]);
    } else {
      console.log('No rows found in clients, but we can try to guess or use another table.');
    }
  }
}

listColumns();
