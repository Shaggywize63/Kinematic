
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const gauravId = '93e17afa-8f8c-49b2-8075-375e1f1ec02a';

async function grantReports() {
  console.log('--- GRANTING REPORTS MODULE ---');
  
  // 1. Find the module named "reports"
  const { data: module, error: mErr } = await s
    .from('modules')
    .select('id, name')
    .ilike('name', '%reports%')
    .single();

  if (mErr || !module) {
    console.error('CRITICAL: Module "reports" not found:', mErr?.message);
    const { data: all } = await s.from('modules').select('name');
    console.log('Available Modules:', all?.map(m => m.name).join(', '));
    return;
  }

  console.log(`Module identified: ${module.name} (ID: ${module.id})`);

  // 2. Upsert permission for Gaurav
  const { error: pErr } = await s
    .from('user_module_permissions')
    .upsert({
      user_id: gauravId,
      module_id: module.id,
      is_active: true
    }, { onConflict: 'user_id,module_id' });

  if (pErr) {
    console.error('Error granting permission:', pErr.message);
    return;
  }

  console.log('SUCCESS: Reports module permission granted and active for Gaurav Jain.');
}

grantReports();
