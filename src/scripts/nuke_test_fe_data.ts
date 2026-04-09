import { supabaseAdmin } from '../lib/supabase';

async function nuke() {
  console.log('--- 🛡️ DATA NUKE INITIATED FOR "Test FE" ---');

  // 1. Find User
  const { data: user, error: userErr } = await supabaseAdmin
    .from('users')
    .select('id, name')
    .ilike('name', '%Test FE%')
    .maybeSingle();

  if (userErr || !user) {
    console.error('❌ Could not find user matching "Test FE"');
    return;
  }

  const userId = user.id;
  console.log(`📍 Found User: ${user.name} (${userId})`);

  try {
    // 2. Cascade Deletion (order matters for FKs)
    
    // --- FORMS ---
    console.log('📝 Cleaning Forms...');
    const { data: subs } = await supabaseAdmin.from('form_submissions').select('id').eq('user_id', userId);
    const subIds = (subs || []).map(s => s.id);
    
    if (subIds.length > 0) {
      await supabaseAdmin.from('form_responses').delete().in('submission_id', subIds);
      await supabaseAdmin.from('form_submissions').delete().eq('user_id', userId);
    }

    // --- ATTENDANCE ---
    console.log('⏰ Cleaning Attendance...');
    await supabaseAdmin.from('attendance').delete().eq('user_id', userId);

    // --- ROUTE PLANS ---
    console.log('🗺️ Cleaning Route Plans...');
    const { data: routes } = await supabaseAdmin.from('route_plans').select('id').eq('user_id', userId);
    const routeIds = (routes || []).map(r => r.id);
    
    if (routeIds.length > 0) {
      await supabaseAdmin.from('route_activities').delete().in('plan_id', routeIds);
      await supabaseAdmin.from('route_outlets').delete().in('plan_id', routeIds);
      await supabaseAdmin.from('route_plans').delete().eq('user_id', userId);
    }

    // --- VISIT LOGS ---
    console.log('👁️ Cleaning Visit Logs...');
    await supabaseAdmin.from('visit_logs').delete().or(`user_id.eq.${userId},executive_id.eq.${userId}`);

    // --- FEEDBACK & ALERTS ---
    console.log('🆘 Cleaning SOS & Grievances...');
    await supabaseAdmin.from('sos_alerts').delete().eq('user_id', userId);
    await supabaseAdmin.from('grievances').delete().eq('user_id', userId);
    await supabaseAdmin.from('broadcast_answers').delete().eq('user_id', userId);

    // --- TRACKING & LOGS ---
    console.log('📈 Cleaning History & Logs...');
    await supabaseAdmin.from('user_activity_logs').delete().eq('user_id', userId);
    await supabaseAdmin.from('user_status_history').delete().eq('user_id', userId);
    await supabaseAdmin.from('notifications').delete().eq('user_id', userId);

    console.log('✅ --- 🏁 DATA NUKE COMPLETE. USER IS NOW FRESH. ---');
  } catch (err: any) {
    console.error('💥 Nuke failed:', err.message);
  }
}

nuke();
