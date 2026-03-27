
import { supabaseAdmin } from './src/lib/supabase';

async function check() {
  const { data, error } = await supabaseAdmin
    .from('form_submissions')
    .select('*')
    .limit(1);
  
  if (error) {
    console.error('Error fetching submission:', error);
    return;
  }
  
  if (data && data[0]) {
    console.log('Columns in form_submissions:', Object.keys(data[0]));
    console.log('Last submission:', data[0]);
  } else {
    console.log('No submissions found');
  }
}

check();
