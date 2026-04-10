import { supabaseAdmin } from './src/lib/supabase';

async function inspect() {
  console.log('--- SCHEMA INSPECTION ---');
  
  // 1. Check form_submissions columns
  const { data: subCols } = await supabaseAdmin.from('form_submissions').select('*').limit(1);
  if (subCols && subCols.length > 0) {
    console.log('form_submissions keys:', Object.keys(subCols[0]));
    console.log('Sample row:', subCols[0]);
  } else {
    console.log('form_submissions is EMPTY');
  }

  // 2. Check builder_submissions columns
  const { data: buildCols } = await supabaseAdmin.from('builder_submissions').select('*').limit(1);
  if (buildCols && buildCols.length > 0) {
    console.log('builder_submissions keys:', Object.keys(buildCols[0]));
    console.log('Sample row:', buildCols[0]);
  } else {
    console.log('builder_submissions is EMPTY');
  }

  // 3. Count all submissions regardless of filters
  const { count: totalF } = await supabaseAdmin.from('form_submissions').select('*', { count: 'exact', head: true });
  const { count: totalB } = await supabaseAdmin.from('builder_submissions').select('*', { count: 'exact', head: true });
  console.log('TOTAL rows in DB - Traditional:', totalF, 'Builder:', totalB);

  // 4. Check for Sagar's org_id
  const { data: sagar } = await supabaseAdmin.from('users').select('id, org_id, role').eq('name', 'Sagar').maybeSingle();
  console.log('User Sagar:', sagar);
}

inspect();
