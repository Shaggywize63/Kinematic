import { supabaseAdmin } from './src/lib/supabase';
async function run() {
  const { data: clients, error } = await supabaseAdmin.from('clients').select('*');
  if (error) { console.error(error); return; }
  
  console.log('Registered Clients in DB:');
  clients.forEach(c => {
    console.log(`Name: ${c.name}, Contact: ${c.contact_person}, Email: ${c.email}`);
  });
  process.exit(0);
}
run();
