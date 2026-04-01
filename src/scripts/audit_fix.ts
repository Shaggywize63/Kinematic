import { supabaseAdmin } from '../lib/supabase';
import dotenv from 'dotenv';
dotenv.config();

async function audit() {
  try {
    console.log('--- START AUDIT ---');
    const { data: user, error: userErr } = await supabaseAdmin
      .from('users')
      .select('id, name, email, role, client_id, org_id')
      .eq('email', 'gaurav@livpure.com')
      .single();

    if (userErr) {
      console.error('User Error:', userErr.message);
    } else {
      console.log('User Profile:', JSON.stringify(user, null, 2));
    }

    if (user) {
      const { data: perms } = await supabaseAdmin
        .from('user_module_permissions')
        .select('module_id')
        .eq('user_id', user.id);
      console.log('User Permissions:', (perms || []).map(p => p.module_id));
    }

    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('id, name, org_id')
      .eq('name', 'LivPure')
      .maybeSingle();
    console.log('LivPure Client ID Reference:', client?.id || 'NOT FOUND');

    console.log('--- END AUDIT ---');
  } catch (e) {
    console.error('Fatal Audit Error:', e);
  }
}

audit();
