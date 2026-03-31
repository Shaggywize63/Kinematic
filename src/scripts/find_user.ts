import { supabaseAdmin } from '../lib/supabase';

async function findUser() {
  const mobile = '3456789012';
  console.log(`🔍 Searching for mobile number: ${mobile}...`);

  try {
    // 1. Search in profiles/users table
    const { data: userRecords, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('mobile', mobile);

    if (userError) {
      console.error('❌ User table query failed:', userError.message);
    } else if (!userRecords || userRecords.length === 0) {
      console.log('⚠️ No record found in "users" table.');
    } else {
      console.log('✅ Record found in "users" table:');
      console.log(JSON.stringify(userRecords, null, 2));
    }

    // 2. Search in Supabase Auth (using service role key)
    const { data: authUsers, error: authError } = await supabaseAdmin.auth.admin.listUsers();
    if (authError) {
      console.error('❌ Auth query failed:', authError.message);
    } else {
      const match = (authUsers.users as any[]).find(u => 
        u.phone === mobile || u.user_metadata?.mobile === mobile
      );
      if (match) {
        console.log('✅ Match found in Supabase Auth:');
        console.log(JSON.stringify({ 
          id: match.id, 
          email: match.email, 
          phone: match.phone,
          metadata: match.user_metadata,
          last_sign_in: match.last_sign_in_at
        }, null, 2));
      } else {
        console.log('⚠️ No match found in Supabase Auth list.');
      }
    }

  } catch (err: any) {
    console.error('❌ Unexpected error:', err.message);
  }
}

findUser();
