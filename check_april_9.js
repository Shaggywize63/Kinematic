const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  const { data, count } = await supabase
    .from('form_submissions')
    .select('*', { count: 'exact' })
    .gte('submitted_at', '2026-04-08T18:30:00Z')
    .lte('submitted_at', '2026-04-09T18:29:59Z');
  
  console.log('April 9 Traditional Submissions:', count);

  const { count: bCount } = await supabase
    .from('builder_submissions')
    .select('*', { count: 'exact' })
    .gte('submitted_at', '2026-04-08T18:30:00Z')
    .lte('submitted_at', '2026-04-09T18:29:59Z');

  console.log('April 9 Builder Submissions:', bCount);
}
check();
