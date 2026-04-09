import { supabaseAdmin } from '../lib/supabase';
import { dbToday } from '../utils';

async function cleanup() {
  console.log('--- Attendance Lockdown Diagnostic ---');
  const today = dbToday();
  console.log(`Checking records for date: ${today}`);

  // 1. Find all attendance for today
  const { data: records, error } = await supabaseAdmin
    .from('attendance')
    .select('id, user_id, org_id, status, checkin_at, checkout_at, date')
    .eq('date', today);

  if (error) {
    console.error('Error fetching records:', error);
    return;
  }

  console.log(`Found ${records?.length || 0} total records for date ${today}`);

  if (!records || records.length === 0) {
    console.log('No records found for today. Checking for active shifts across all dates...');
    const { data: activeShifts } = await supabaseAdmin
      .from('attendance')
      .select('id, user_id, date, status')
      .in('status', ['checked_in', 'on_break']);
    
    console.log('Active shifts:', activeShifts);
    return;
  }

  // 2. Group by user to find duplicates
  const userGroups: Record<string, any[]> = {};
  records.forEach(r => {
    if (!userGroups[r.user_id]) userGroups[r.user_id] = [];
    userGroups[r.user_id].push(r);
  });

  for (const userId in userGroups) {
    const userRecords = userGroups[userId];
    if (userRecords.length > 1) {
      console.log(`User ${userId} has ${userRecords.length} duplicates for today. Cleaning up...`);
      
      // Keep the one with a checkin_at or the most recent one
      const sorted = userRecords.sort((a, b) => {
        if (a.checkin_at && !b.checkin_at) return -1;
        if (!a.checkin_at && b.checkin_at) return 1;
        return b.id.localeCompare(a.id);
      });

      const toKeep = sorted[0];
      const toDelete = sorted.slice(1).map(r => r.id);

      console.log(`Keeping record: ${toKeep.id}, Deleting: ${toDelete.join(', ')}`);
      
      const { error: delError } = await supabaseAdmin
        .from('attendance')
        .delete()
        .in('id', toDelete);
      
      if (delError) console.error('Delete error:', delError);
      else console.log('Cleanup successful for user', userId);
    } else {
      console.log(`User ${userId} has a clean record: ${userRecords[0].id} (${userRecords[0].status})`);
    }
  }

  console.log('--- Cleanup Complete ---');
}

cleanup();
