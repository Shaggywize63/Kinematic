import { supabaseAdmin } from '../lib/supabase';

async function testInsert() {
  console.log('Testing insertion into client_module_access...');
  
  // Try to insert 'cities' module for a dummy client ID if possible, 
  // or just use a known client ID from the debug_client_access output.
  // From previous output: '2088af44-a4e5-48e6-8cfb-a71649dd3c3b' exists.
  
  const clientId = '2088af44-a4e5-48e6-8cfb-a71649dd3c3b';
  const testModuleId = 'cities'; // One of the new ones
  
  console.log(`Inserting module '${testModuleId}' for client '${clientId}'...`);
  
  const { error } = await supabaseAdmin
    .from('client_module_access')
    .insert({ client_id: clientId, module_id: testModuleId });
    
  if (error) {
    console.error('INSERT FAILED:', error.message);
    console.error('Error details:', JSON.stringify(error, null, 2));
  } else {
    console.log('INSERT SUCCESSFUL!');
    // Cleanup
    await supabaseAdmin
      .from('client_module_access')
      .delete()
      .eq('client_id', clientId)
      .eq('module_id', testModuleId);
    console.log('Cleanup complete.');
  }
}

testInsert();
