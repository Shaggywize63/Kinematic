import { supabaseAdmin } from './src/lib/supabase';

async function checkSubmissions() {
  const userId = '5a412530-5623-4691-adf6-b6f155059940';
  const { data, error } = await supabaseAdmin
    .from('form_submissions')
    .select('*, form_templates(title)')
    .eq('user_id', userId)
    .order('submitted_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('Error:', error);
  } else {
    console.log(`Submissions for Test FE:`);
    data?.forEach(r => {
      console.log(`- Form: ${(r.form_templates as any)?.title}, At: ${r.submitted_at}, Lat: ${r.latitude}, Lng: ${r.longitude}, Photo: ${!!r.photo_url}`);
    });
  }
}

checkSubmissions();
