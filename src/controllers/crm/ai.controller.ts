import { Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, notFound } from '../../utils';
import { AIService } from '../../services/ai.service';

function computeLeadScore(lead: Record<string, unknown>): { score: number; grade: string; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};
  let score = 0;
  const add = (key: string, val: number) => { breakdown[key] = val; score += val; };
  if (lead.company) add('has_company', 8);
  if (lead.title) add('has_title', 5);
  if (lead.industry) add('has_industry', 4);
  if (lead.phone) add('has_phone', 4);
  if (lead.email) add('has_email', 4);
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 75 ? 'A' : score >= 55 ? 'B' : score >= 35 ? 'C' : 'D';
  return { score, grade, breakdown };
}

export const scoreLead = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data: lead, error: le } = await supabaseAdmin.from('crm_leads').select('*')
    .eq('id', req.params.id).eq('org_id', org_id).single();
  if (le || !lead) return notFound(res, 'Lead not found');

  const heuristic = computeLeadScore(lead);
  let finalScore = heuristic.score;
  let model = 'heuristic';
  let reasons: string[] = [];

  try {
    const aiText = await AIService.callKiniAI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'You are a B2B/B2C lead scoring expert. Reply ONLY with valid JSON: {"adjustment":number,"reasons":["string"],"confidence":"low"|"medium"|"high"}. adjustment must be between -15 and 15.',
      messages: [{
        role: 'user',
        content: `Lead profile: ${JSON.stringify({ name: `${lead.first_name} ${lead.last_name}`, company: lead.company, title: lead.title, industry: lead.industry, status: lead.status, source: lead.source_id, is_b2c: lead.is_b2c })}. Heuristic score: ${heuristic.score}. Provide adjustment.`,
      }],
    });
    const parsed = JSON.parse(aiText.trim());
    finalScore = Math.max(0, Math.min(100, heuristic.score + (parsed.adjustment || 0)));
    model = 'heuristic+ai';
    reasons = parsed.reasons || [];
  } catch (_) { /* fallback to heuristic only */ }

  const grade = finalScore >= 75 ? 'A' : finalScore >= 55 ? 'B' : finalScore >= 35 ? 'C' : 'D';

  await supabaseAdmin.from('crm_leads').update({
    score: finalScore, score_grade: grade,
    score_breakdown: { ...heuristic.breakdown, ai_reasons: reasons },
    score_updated_at: new Date().toISOString(),
  }).eq('id', lead.id);

  await supabaseAdmin.from('crm_lead_scores').insert({
    org_id, lead_id: lead.id, score: finalScore, grade,
    breakdown: { ...heuristic.breakdown, ai_reasons: reasons }, model,
  });

  return ok(res, { id: lead.id, score: finalScore, grade, breakdown: heuristic.breakdown, reasons, model });
});

export const draftReply = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { lead_id, deal_id, thread = '', tone = 'friendly', goal = 'follow-up' } = req.body;

  let context = '';
  if (lead_id) {
    const { data: lead } = await supabaseAdmin.from('crm_leads').select('*')
      .eq('id', lead_id).eq('org_id', org_id).single();
    if (lead) context = `Lead: ${lead.first_name} ${lead.last_name}, ${lead.company || ''}, ${lead.status}`;
  }
  if (deal_id) {
    const { data: deal } = await supabaseAdmin.from('crm_deals').select('name,amount,status')
      .eq('id', deal_id).eq('org_id', org_id).single();
    if (deal) context += ` Deal: ${deal.name}, ₹${deal.amount || 0}`;
  }

  try {
    const aiText = await AIService.callKiniAI({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: 'You are a professional sales rep. Reply ONLY with JSON: {"subject":"string","body_text":"string","body_html":"string"}',
      messages: [{
        role: 'user',
        content: `Context: ${context || 'General follow-up'}. Thread: ${thread || 'None'}. Tone: ${tone}. Goal: ${goal}. Write a professional email reply.`,
      }],
    });
    const parsed = JSON.parse(aiText.trim());
    return ok(res, parsed);
  } catch (e: any) {
    return ok(res, {
      subject: 'Following up with you',
      body_text: 'Hi,\n\nI wanted to follow up on our recent conversation. Please let me know if you have any questions.\n\nBest regards',
      body_html: '<p>Hi,</p><p>I wanted to follow up on our recent conversation. Please let me know if you have any questions.</p><p>Best regards</p>',
    });
  }
});

export const nextBestAction = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data: deal } = await supabaseAdmin.from('crm_deals')
    .select('*, stage:crm_deal_stages(name,stage_type)')
    .eq('id', req.params.dealId).eq('org_id', org_id).single();
  if (!deal) return notFound(res, 'Deal not found');

  try {
    const aiText = await AIService.callKiniAI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'You are a sales coach. Reply ONLY with JSON: {"action":"string","priority":"high"|"medium"|"low","reason":"string","suggested_when":"string"}',
      messages: [{
        role: 'user',
        content: `Deal: ${deal.name}, Stage: ${(deal.stage as any)?.name}, Amount: ₹${deal.amount || 0}, Status: ${deal.status}. What is the next best action?`,
      }],
    });
    const parsed = JSON.parse(aiText.trim());
    await supabaseAdmin.from('crm_deals').update({ next_action_ai: parsed }).eq('id', deal.id);
    return ok(res, parsed);
  } catch (_) {
    const fallback = { action: 'Follow up with prospect', priority: 'medium', reason: 'Keep deal momentum', suggested_when: 'Within 2 business days' };
    return ok(res, fallback);
  }
});

export const winProbability = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data: deal } = await supabaseAdmin.from('crm_deals')
    .select('*, stage:crm_deal_stages(probability,stage_type)')
    .eq('id', req.params.dealId).eq('org_id', org_id).single();
  if (!deal) return notFound(res, 'Deal not found');

  const stageProbability = (deal.stage as any)?.probability || 50;

  try {
    const aiText = await AIService.callKiniAI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'You are a sales analyst. Reply ONLY with JSON: {"probability":number,"reasoning":"string"}. probability is 0-100.',
      messages: [{
        role: 'user',
        content: `Deal: ${deal.name}, Stage: ${(deal.stage as any)?.name}, Base probability: ${stageProbability}%, Amount: ₹${deal.amount || 0}, Status: ${deal.status}. Estimate win probability.`,
      }],
    });
    const parsed = JSON.parse(aiText.trim());
    await supabaseAdmin.from('crm_deals').update({ win_probability_ai: parsed.probability }).eq('id', deal.id);
    return ok(res, { probability: parsed.probability, reasoning: parsed.reasoning, stage_probability: stageProbability });
  } catch (_) {
    return ok(res, { probability: stageProbability, reasoning: 'Based on stage probability', stage_probability: stageProbability });
  }
});

export const summarizeAccount = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data: account } = await supabaseAdmin.from('crm_accounts').select('*')
    .eq('id', req.params.id).eq('org_id', org_id).single();
  if (!account) return notFound(res, 'Account not found');

  const [contacts, deals] = await Promise.all([
    supabaseAdmin.from('crm_contacts').select('first_name,last_name,title').eq('account_id', account.id).limit(5),
    supabaseAdmin.from('crm_deals').select('name,amount,status').eq('account_id', account.id).limit(5),
  ]);

  try {
    const aiText = await AIService.callKiniAI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: 'You are a CRM analyst. Reply ONLY with JSON: {"summary":"string","highlights":["string"]}',
      messages: [{
        role: 'user',
        content: `Summarize account: ${account.name}, Industry: ${account.industry || 'unknown'}, Contacts: ${JSON.stringify(contacts.data || [])}, Deals: ${JSON.stringify(deals.data || [])}`,
      }],
    });
    const parsed = JSON.parse(aiText.trim());
    return ok(res, parsed);
  } catch (_) {
    return ok(res, { summary: `${account.name} is a ${account.industry || 'company'} with ${contacts.data?.length || 0} contacts and ${deals.data?.length || 0} deals.`, highlights: [] });
  }
});

export const summarizeDeal = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { data: deal } = await supabaseAdmin.from('crm_deals')
    .select('*, stage:crm_deal_stages(name)').eq('id', req.params.id).eq('org_id', org_id).single();
  if (!deal) return notFound(res, 'Deal not found');

  try {
    const aiText = await AIService.callKiniAI({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: 'Reply ONLY with JSON: {"summary":"string","highlights":["string"]}',
      messages: [{
        role: 'user',
        content: `Summarize deal: ${deal.name}, Stage: ${(deal.stage as any)?.name}, Amount: ₹${deal.amount || 0}, Status: ${deal.status}, Expected close: ${deal.expected_close_date || 'not set'}`,
      }],
    });
    return ok(res, JSON.parse(aiText.trim()));
  } catch (_) {
    return ok(res, { summary: `${deal.name} is a ₹${deal.amount || 0} deal currently ${deal.status}.`, highlights: [] });
  }
});

export const chat = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { org_id } = req.user!;
  const { messages, system, context } = req.body;
  if (!messages?.length) return badRequest(res, 'messages is required');

  const systemPrompt = [
    system || '',
    'You are KINI, Kinematic\'s AI assistant for the CRM module.',
    context?.module === 'crm' ? 'The user is working in the CRM. Help them with leads, deals, accounts, contacts, activities, and pipeline management.' : '',
  ].filter(Boolean).join(' ');

  try {
    const text = await AIService.callKiniAI({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    });
    return ok(res, { text, cards: [] });
  } catch (e: any) {
    if (e.code === 'CONFIG_ERROR') {
      return ok(res, { text: 'AI features require an Anthropic API key. Please set ANTHROPIC_API_KEY in your environment and restart the server.', cards: [] });
    }
    return ok(res, { text: 'I encountered an error processing your request. Please try again.', cards: [] });
  }
});
