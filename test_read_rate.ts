import { supabaseAdmin } from './src/lib/supabase';

async function testReadRate() {
  // 1. Send dummy notif
  const { data: bData } = await supabaseAdmin.from('notification_broadcasts').insert({
    org_id: '8114f65c-6192-497c-9b7e-001099e235e1', // use a real org_id if possible
    title: 'Test Read Rate',
    body: 'Test',
    recipients_count: 1
  }).select().single();

  if (!bData) { console.log('Failed to create broadcast'); return; }
  console.log('Created Broadcast:', bData.id);

  // 2. Add notification
  const { data: nData } = await supabaseAdmin.from('notifications').insert({
    user_id: '8cb38501-c88c-486a-810f-21f8263595b2', // use real user_id
    org_id: bData.org_id,
    title: 'Test Notif',
    broadcast_id: bData.id
  }).select().single();
  
  console.log('Created Notification:', nData.id);

  // 3. Increment
  const { error: rpcErr } = await supabaseAdmin.rpc('increment_broadcast_read_count', { b_id: bData.id });
  if (rpcErr) {
    console.log('RPC ERROR:', rpcErr.message);
  } else {
    const { data: updated } = await supabaseAdmin.from('notification_broadcasts').select('read_count').eq('id', bData.id).single();
    console.log('Read Count after RPC:', updated.read_count);
  }
}

testReadRate();
