import { supabaseAdmin } from '../lib/supabase';
import dotenv from 'dotenv';
dotenv.config();

const GAURAV_EMAIL = 'gaurav@livpure.com';

async function listPerms() {
  console.log('--- Gaurav Permissions Diagnostic ---');
  const { data: user } = await supabaseAdmin.from('users').select('id').eq('email', GAURAV_EMAIL).single();
  if (user) {
    const { data: perms } = await supabaseAdmin.from('user_module_permissions').select('module_id').eq('user_id', user.id);
    console.log('User ID:', user.id);
    console.log('Permissions:', perms?.map(p => p.module_id));
  } else {
    console.log('Gaurav not found.');
  }
}

listPerms();
