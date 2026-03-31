import { supabaseAdmin } from '../lib/supabase';

async function auditSystem() {
  console.log('🔍 Starting System Audit...');

  // 1. Audit Clients Schema
  const { data: clientCols, error: clientErr } = await supabaseAdmin.rpc('exec_sql', { 
    sql_query: "SELECT column_name FROM information_schema.columns WHERE table_name = 'clients'" 
  });
  
  if (clientErr) console.error('❌ Clients Schema Error:', clientErr.message);
  else console.log('✅ Clients Columns:', JSON.stringify(clientCols, null, 2));

  // 2. Audit Permissions Schema
  const { data: permCols, error: permColErr } = await supabaseAdmin.rpc('exec_sql', { 
    sql_query: "SELECT column_name FROM information_schema.columns WHERE table_name = 'user_module_permissions'" 
  });
  if (permColErr) console.error('❌ Permissions Schema Error:', permColErr.message);
  else console.log('✅ Permissions Columns:', JSON.stringify(permCols, null, 2));

  // 3. Audit Permissions for user 3456789012
  const targetId = '06a5e354-c2fb-4f18-8c11-1bf0e05a21b9';
  const { data: permRecords, error: permErr } = await supabaseAdmin
    .from('user_module_permissions')
    .select('*')
    .eq('user_id', targetId);

  if (permErr) console.error('❌ Permissions Query Error:', permErr.message);
  else console.log('✅ User Permissions:', JSON.stringify(permRecords, null, 2));

  // 4. Audit Foreign Keys for user_module_permissions
  const { data: fkData, error: fkErr } = await supabaseAdmin.rpc('exec_sql', { 
    sql_query: "SELECT confrelid::regclass AS referenced_table FROM pg_constraint WHERE conrelid = 'user_module_permissions'::regclass AND contype = 'f'" 
  });
  if (fkErr) console.error('❌ FK Lookup Error:', fkErr.message);
  else {
    const refTable = fkData?.[0]?.referenced_table || 'modules';
    console.log(`✅ Referencing Table: ${refTable}`);
    
    // 5. List valid IDs from the referenced table
    const { data: moduleData, error: moduleErr } = await supabaseAdmin.rpc('exec_sql', { 
      sql_query: `SELECT id FROM ${refTable}` 
    });
    if (moduleErr) console.error(`❌ ${refTable} Data Error:`, moduleErr.message);
    else console.log('✅ Valid Module IDs:', JSON.stringify(moduleData.map((m: any) => m.id), null, 2));
  }
}

auditSystem();
