import { supabaseAdmin } from './src/lib/supabase';

async function auditData() {
  const clientId = '9a409db5-ec4a-4a24-9894-72f59d380464'; // LivPure
  
  console.log(`Auditing data for LivPure (${clientId})...`);

  const { count: submissionCount } = await supabaseAdmin
    .from('form_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);

  const { count: attendanceCount } = await supabaseAdmin
    .from('attendance')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);

  console.log('LivPure Submissions:', submissionCount);
  console.log('LivPure Attendance:', attendanceCount);

  // Check for assigned modules in organizations
  const { data: orgModules } = await supabaseAdmin
    .from('client_module_access')
    .select('module_id')
    .eq('client_id', clientId);
  
  console.log('Organization Modules:', (orgModules || []).map(m => m.module_id));

  // Check for assigned modules in users
  const { data: userRecord } = await supabaseAdmin
    .from('users')
    .select('id, email, role')
    .eq('email', 'gaurav@livpure.com')
    .single();

  if (userRecord) {
    const { data: userModules } = await supabaseAdmin
      .from('user_module_permissions')
      .select('module_id')
      .eq('user_id', userRecord.id);
    console.log('User-level Modules:', (userModules || []).map(m => m.module_id));
  }
}

auditData().catch(console.error);
