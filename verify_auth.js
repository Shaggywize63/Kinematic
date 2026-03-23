const { createClient } = require('@supabase/supabase-js');
const readline = require('readline');
require('dotenv').config({ path: '.env' });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("❌ Error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not found in .env");
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function run() {
  console.log("--- Kinematic Auth Diagnostic ---");
  
  rl.question('Enter the 10-digit mobile number to check: ', async (mobile) => {
    mobile = mobile.trim();
    if (!/^\d{10}$/.test(mobile)) {
      console.log("❌ Invalid format. Please enter exactly 10 digits.");
      rl.close();
      return;
    }

    console.log(`\n🔍 Looking up user in database...`);
    const { data: userLookup, error: dbErr } = await supabaseAdmin
      .from('users')
      .select('id, name, email, mobile')
      .or(`mobile.eq.${mobile},mobile.eq.+91${mobile},mobile.eq.0${mobile}`)
      .single();

    if (dbErr || !userLookup) {
      console.log("❌ User not found in 'users' table.");
      rl.close();
      return;
    }

    const authEmail = userLookup.email || `${userLookup.mobile}@kinematic.app`;
    console.log(`✅ User found: ${userLookup.name}`);
    console.log(`📧 Expected Identity (Auth Email): ${authEmail}`);
    console.log(`🆔 Auth UserID: ${userLookup.id}`);

    console.log(`\n🔍 Checking Supabase Auth...`);
    const { data: { user: authUser }, error: authReadErr } = await supabaseAdmin.auth.admin.getUserById(userLookup.id);

    if (authReadErr || !authUser) {
      console.log("❌ User NOT found in Supabase Auth. They might have been deleted from Auth but not the DB.");
      rl.close();
      return;
    }

    console.log(`✅ User exists in Supabase Auth.`);
    console.log(`📅 Created At: ${authUser.created_at}`);

    rl.question('\nDo you want to RESET this user\'s password to "123123"? (y/n): ', async (answer) => {
      if (answer.toLowerCase() === 'y') {
        process.stdout.write("⏳ Resetting password...");
        const { error: resetErr } = await supabaseAdmin.auth.admin.updateUserById(userLookup.id, {
          password: '123123'
        });

        if (resetErr) {
          console.log(`\n❌ Failed to reset password: ${resetErr.message}`);
        } else {
          console.log(`\n✨ Password reset to "123123" successfully!`);
          console.log("Try logging in on the app now with this mobile and password.");
        }
      } else {
        console.log("Password reset skipped.");
      }
      rl.close();
    });
  });
}

run();
