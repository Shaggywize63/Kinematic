
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function checkGauravPerms() {
  console.log('--- GAURAV JAIN PERMISSION AUDIT ---');
  
  // 1. Find Gaurav Jain's User ID
  const { data: user, error: uErr } = await supabaseAdmin
    .from('users')
    .select('id, role, name')
    .ilike('name', '%Gaurav%')
    .single();

  if (uErr || !user) {
    console.error('Error finding Gaurav:', uErr?.message);
    return;
  }

  console.log(`User Found: ID=${user.id} | Name=${user.name} | Role=${user.role}`);

  // 2. Fetch all module permissions for this user
  const { data: perms, error: pErr } = await supabaseAdmin
    .from('user_module_permissions')
    .select('*, modules(*)')
    .eq('user_id', user.id);

  if (pErr) {
    console.error('Error fetching permissions:', pErr.message);
    return;
  }

  console.log('--- ASSIGNED MODULES ---');
  if (!perms || perms.length === 0) {
    console.log('NO MODULES ASSIGNED.');
  } else {
    perms.forEach((p: any) => {
      console.log(`- ${p.modules?.name || 'Unknown'} (id=${p.module_id}) | Active=${p.is_active}`);
    });
  }

  // 3. Search for a module named "reports" specifically
  const { data: reportModule } = await supabaseAdmin
    .from('modules')
    .select('*')
    .ilike('name', '%reports%')
    .single();

  if (reportModule) {
    console.log(`Targeting Module Found: ID=${reportModule.id} | Name=${reportModule.name}`);
    const hasIt = perms?.find(p => p.module_id === reportModule.id);
    if (hasIt) {
       console.log('Gaurav HAS the reports module assigned.');
       if (!hasIt.is_active) console.warn('BUT IT IS INACTIVE!');
    } else {
       console.log('Gaurav is MISSING the reports module.');
    }
  } else {
    console.warn('CRITICAL: No module named "reports" found in the "modules" table.');
    console.log('Available Modules:');
    const { data: allModules } = await supabaseAdmin.from('modules').select('name');
    allModules?.forEach(m => console.log(`  * ${m.name}`));
  }
}

checkGauravPerms();
