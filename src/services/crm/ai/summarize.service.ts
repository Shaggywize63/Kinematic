/**
 * Account / Deal AI summarizer.
 */
import { supabaseAdmin } from '../../../lib/supabase';
import { complete as aiComplete } from './aiClient';

export async function summarizeAccount(org_id: string, account_id: string): Promise<string> {
  const { data: account } = await supabaseAdmin.from('crm_accounts').select('*')
    .eq('org_id', org_id).eq('id', account_id).maybeSingle();
  if (!account) return 'Account not found.';
  const { data: contacts } = await supabaseAdmin.from('crm_contacts').select('first_name,last_name,title,email')
    .eq('org_id', org_id).eq('account_id', account_id).limit(10);
  const { data: deals } = await supabaseAdmin.from('crm_deals').select('name, amount, currency, stage_id, created_at')
    .eq('org_id', org_id).eq('account_id', account_id).limit(10);

  const summary = await aiComplete({
    org_id,
    model: process.env.CRM_NBA_MODEL || 'claude-haiku-4-5',
    system: 'Summarize this CRM account in 3-4 sentences. Cover: company, key contacts, open opportunity value, last activity. Plain text.',
    messages: [{ role: 'user', content: JSON.stringify({ account, contacts, deals }) }],
    max_tokens: 250,
  });

  await supabaseAdmin.from('crm_accounts').update({
    ai_summary: summary, ai_summary_updated_at: new Date().toISOString(),
  }).eq('id', account_id).eq('org_id', org_id);

  return summary;
}

export async function summarizeDeal(org_id: string, deal_id: string): Promise<string> {
  const { data: deal } = await supabaseAdmin.from('crm_deals').select('*')
    .eq('org_id', org_id).eq('id', deal_id).maybeSingle();
  if (!deal) return 'Deal not found.';
  const { data: activities } = await supabaseAdmin.from('crm_activities')
    .select('type, subject, body, completed_at, status')
    .eq('org_id', org_id).eq('deal_id', deal_id).order('completed_at', { ascending: false }).limit(10);
  return aiComplete({
    org_id,
    model: process.env.CRM_NBA_MODEL || 'claude-haiku-4-5',
    system: 'Summarize this CRM deal in 3-4 sentences. Cover: opportunity, current stage, key activities, risks/next-step. Plain text.',
    messages: [{ role: 'user', content: JSON.stringify({ deal, activities }) }],
    max_tokens: 250,
  });
}
