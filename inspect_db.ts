import { supabaseAdmin } from './src/lib/supabase';

async function checkData() {
  console.log('--- Checking form_submissions data ---');
  const { data, error } = await supabaseAdmin
    .from('form_submissions')
    .select('id, submitted_at, org_id')
    .limit(10);

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('Sample rows:', data);

  const { count, error: countErr } = await supabaseAdmin
    .from('form_submissions')
    .select('*', { count: 'exact', head: true });

  console.log('Total count:', count);
}

checkData();
