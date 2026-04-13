
import { supabaseAdmin } from './src/lib/supabase';

async function diagnose() {
  console.log('--- DIAGNOSING MEDIA PATHS ---');
  
  // 1. Check Submissions
  const { data: subs, error: subError } = await supabaseAdmin
    .from('form_submissions')
    .select('id, form_responses(value_text, value_json)')
    .order('created_at', { ascending: false })
    .limit(5);

  if (subError) {
    console.error('Submission Fetch Error:', subError);
  } else {
    console.log('Recent Submissions Data:');
    subs.forEach(s => {
      console.log(`\nSubmission ID: ${s.id}`);
      s.form_responses.forEach((r: any, i: number) => {
        if (r.value_text || r.value_json) {
            console.log(`  Response ${i}: text=${r.value_text}, json=${JSON.stringify(r.value_json)}`);
        }
      });
    });
  }

  // 2. Check Storage Buckets
  const { data: buckets, error: bucketError } = await (supabaseAdmin as any).storage.listBuckets();
  if (bucketError) {
      console.error('Bucket List Error:', bucketError);
  } else {
      console.log('\nAvailable Buckets:', buckets.map((b: any) => b.name));
  }
}

diagnose();
