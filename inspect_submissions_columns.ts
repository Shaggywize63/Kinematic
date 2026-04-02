import { supabaseAdmin } from './src/lib/supabase';

async function inspectColumns() {
  const { data, error } = await supabaseAdmin
    .from('form_submissions')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error:', error);
  } else if (data && data.length > 0) {
    console.log('Form Submission Columns:', Object.keys(data[0]));
  } else {
    console.log('No form submissions found.');
  }
}

inspectColumns();
