import { supabaseAdmin } from './src/lib/supabase';

async function checkNotifications() {
  const { data, error } = await supabaseAdmin.from('notifications').select('*').limit(1);
  if (error) {
    console.error('Notifications table error:', error.message);
  } else {
    console.log('Sample Notification:', data?.[0]);
  }
}

checkNotifications();
