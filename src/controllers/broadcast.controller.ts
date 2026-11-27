import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound, conflict, serverError, isDemo } from '../utils';
import { asyncHandler } from '../utils/asyncHandler';
import { DEMO_ORG_ID, getMockBroadcasts } from '../utils/demoData';

const questionSchema = z.object({
  question: z.string().min(5),
  options: z.array(z.object({
    label: z.string(),
    value: z.string(),
    is_correct: z.boolean().optional(),
  })).min(2),
  correct_option: z.number().int().optional(),
  is_urgent: z.boolean().default(false),
  deadline_at: z.string().datetime().optional().nullable(),
  target_roles: z.array(z.string()).default(['executive']),
  target_zone_ids: z.array(z.string().uuid()).default([]),
  target_cities: z.array(z.string()).default([]),
});

const answerSchema = z.object({
  selected: z.number().int().min(0),
});

// GET /api/v1/broadcast — active questions for current user (FE/supervisor)
export const getQuestions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockBroadcasts());

  let query = supabaseAdmin
    .from('broadcast_questions')
    .select(`
      id, question, options, correct_option, is_urgent, deadline_at,
      status, target_roles, target_zone_ids, target_cities, created_at,
      broadcast_answers!left(id, selected, is_correct, answered_at)
    `)
    .eq('org_id', user.org_id)
    .eq('status', 'active')
    .contains('target_roles', [user.role])
    .order('is_urgent', { ascending: false })
    .order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return badRequest(res, error.message);

  const sanitised = (data || []).map((q) => ({
    ...q,
    correct_option: ['admin', 'city_manager', 'super_admin'].includes(user.role)
      ? q.correct_option
      : undefined,
    already_answered:
      Array.isArray(q.broadcast_answers) && q.broadcast_answers.length > 0,
    my_answer:
      Array.isArray(q.broadcast_answers) && q.broadcast_answers.length > 0
        ? q.broadcast_answers[0]
        : null,
    broadcast_answers: undefined,
  }));

  return ok(res, sanitised);
});

// GET /api/v1/broadcast/admin — all questions for admin dashboard
export const getAdminQuestions = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockBroadcasts());

  const { data: questions, error } = await supabaseAdmin
    .from('broadcast_questions')
    .select(`
      id, question, options, correct_option, is_urgent, deadline_at,
      status, target_roles, target_zone_ids, target_cities, created_at, updated_at
    `)
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false });

  if (error) return serverError(res, error.message);

  // Fetch answers separately to avoid FK/join ambiguity issues
  const questionIds = (questions || []).map((q) => q.id);
  const { data: answers } = questionIds.length
    ? await supabaseAdmin
        .from('broadcast_answers')
        .select('question_id, user_id, selected, is_correct, answered_at')
        .in('question_id', questionIds)
        .order('answered_at', { ascending: true })
    : { data: [] };

  // Fetch user names for all respondents
  const userIds = [...new Set((answers || []).map((a) => a.user_id).filter(Boolean))];
  const { data: users } = userIds.length
    ? await supabaseAdmin
        .from('users')
        .select('id, name, employee_id')
        .in('id', userIds)
    : { data: [] };

  const userMap = (users || []).reduce<Record<string, { name: string; employee_id: string }>>(
    (acc, u) => { acc[u.id] = { name: u.name, employee_id: u.employee_id }; return acc; },
    {}
  );

  const answersByQuestion = (answers || []).reduce<
    Record<string, { user_id: string; user_name: string; employee_id: string; selected: number; is_correct: boolean | null; answered_at: string }[]>
  >(
    (acc, a) => {
      if (!acc[a.question_id]) acc[a.question_id] = [];
      const u = userMap[a.user_id] || { name: 'Unknown', employee_id: '' };
      acc[a.question_id].push({ ...a, user_name: u.name, employee_id: u.employee_id });
      return acc;
    },
    {}
  );

  // Enrich with response counts and per-responder list
  const enriched = (questions || []).map((q) => {
    const qAnswers = answersByQuestion[q.id] || [];
    const opts = q.options as { label: string }[];
    const tally = opts.map((opt, i) => ({
      ...opt,
      index: i,
      count: qAnswers.filter((a) => a.selected === i).length,
    }));
    const responses = qAnswers.map((a) => ({
      user_name: a.user_name,
      employee_id: a.employee_id,
      selected_label: opts[a.selected]?.label ?? `Option ${a.selected + 1}`,
      selected_index: a.selected,
      is_correct: a.is_correct,
      answered_at: a.answered_at,
    }));
    return {
      ...q,
      response_count: qAnswers.length,
      tally,
      responses,
    };
  });

  return ok(res, enriched);
});

// POST /api/v1/broadcast — create question (admin+)
export const createQuestion = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: 'demo-br-new' }, 'Question posted (Demo)');
  const body = questionSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('broadcast_questions')
    .insert({
      ...body.data,
      org_id: user.org_id,
      created_by: user.id,
      // A question posted here goes live immediately, so stamp the publish time
      // — the leaderboard measures each answer's speed from this moment.
      published_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Question posted');
});

// PATCH /api/v1/broadcast/:id — update question (admin+)
export const updateQuestion = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id }, 'Question updated (Demo)');
  const { id } = req.params;
  const body = questionSchema.partial().safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('broadcast_questions')
    .update({ ...body.data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', user.org_id)
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Question not found');
  return ok(res, data, 'Question updated');
});

// DELETE /api/v1/broadcast/:id — delete question (admin+)
export const deleteQuestion = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, null, 'Question deleted (Demo)');
  const { id } = req.params;

  // The answers go first, so confirm the question is this org's before touching them.
  const { data: owned } = await supabaseAdmin
    .from('broadcast_questions').select('id').eq('id', id).eq('org_id', user.org_id).maybeSingle();
  if (!owned) return notFound(res, 'Question not found');

  // Delete answers first
  await supabaseAdmin
    .from('broadcast_answers')
    .delete()
    .eq('question_id', id);

  const { error } = await supabaseAdmin
    .from('broadcast_questions')
    .delete()
    .eq('id', id)
    .eq('org_id', user.org_id);

  if (error) return badRequest(res, error.message);
  return ok(res, null, 'Question deleted');
});

// PATCH /api/v1/broadcast/:id/status — close/reopen (admin+)
export const updateStatus = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { id: req.params.id, status: req.body.status });
  const { id } = req.params;
  const { status } = req.body as { status: string };

  if (!['active', 'closed'].includes(status)) return badRequest(res, 'Status must be active or closed');

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  // Going live (incl. a staged question or a reopen) stamps the publish time the
  // leaderboard measures answer speed from.
  if (status === 'active') patch.published_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('broadcast_questions')
    .update(patch)
    .eq('id', id)
    .eq('org_id', user.org_id)
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  if (!data) return notFound(res, 'Question not found');
  return ok(res, data, `Question ${status}`);
});

// POST /api/v1/broadcast/:id/answer — submit answer (FE/supervisor)
export const submitAnswer = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { status: 'success' }, 'Answer submitted (Demo)');
  const { id } = req.params;
  const body = answerSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data: question } = await supabaseAdmin
    .from('broadcast_questions')
    .select('id, options, correct_option, status, deadline_at')
    .eq('id', id)
    .eq('org_id', user.org_id)
    .single();

  if (!question) return notFound(res, 'Question not found');
  if (question.status !== 'active') return badRequest(res, 'Question is no longer active');
  if (question.deadline_at && new Date(question.deadline_at) < new Date()) {
    return badRequest(res, 'Deadline has passed');
  }

  const { data: existing } = await supabaseAdmin
    .from('broadcast_answers')
    .select('id')
    .eq('question_id', id)
    .eq('user_id', user.id)
    .single();

  if (existing) return conflict(res, 'Already answered this question');

  const opts = question.options as unknown[];
  if (body.data.selected >= opts.length) return badRequest(res, 'Invalid option index');

  const is_correct =
    question.correct_option !== null
      ? body.data.selected === question.correct_option
      : null;

  const { data, error } = await supabaseAdmin
    .from('broadcast_answers')
    .insert({
      question_id: id,
      user_id: user.id,
      org_id: user.org_id,
      selected: body.data.selected,
      is_correct,
    })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, { ...data, correct_option: question.correct_option }, 'Answer submitted');
});

// GET /api/v1/broadcast/:id/results (admin+)
export const getResults = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, getMockBroadcasts()[0]);
  const { id } = req.params;

  const { data: question } = await supabaseAdmin
    .from('broadcast_questions')
    .select('*, broadcast_answers(*, users!user_id(name, employee_id))')
    .eq('id', id)
    .eq('org_id', user.org_id)
    .single();

  if (!question) return notFound(res, 'Question not found');

  const answers = (question.broadcast_answers || []) as { selected: number; is_correct: boolean }[];
  const tally = (question.options as { label: string; value: string }[]).map((opt, i) => ({
    ...opt,
    index: i,
    count: answers.filter((a) => a.selected === i).length,
  }));

  return ok(res, { ...question, tally, total_answers: answers.length });
});

// GET /api/v1/broadcast/leaderboard (admin+)
// Ranks responders across the org's broadcast questions by correctness and
// speed. Response speed for each answer = answered_at − the question's publish
// time (published_at, falling back to created_at for pre-existing rows).
// Optional ?role=executive|supervisor and ?question_ids=a,b,c narrow the scope.
export const getLeaderboard = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const empty = { leaderboard: [], fastest: [], question_count: 0, as_of: new Date().toISOString() };
  if (isDemo(user)) return ok(res, empty);

  const roleFilter = (req.query.role as string | undefined)?.trim().toLowerCase();
  const idsParam = (req.query.question_ids as string | undefined)?.trim();
  const questionIds = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : null;

  let qq = supabaseAdmin
    .from('broadcast_questions')
    .select('id, created_at, published_at, target_roles')
    .eq('org_id', user.org_id);
  if (questionIds && questionIds.length) qq = qq.in('id', questionIds);
  if (roleFilter) qq = qq.contains('target_roles', [roleFilter]);
  const { data: questions, error: qErr } = await qq;
  if (qErr) return badRequest(res, qErr.message);
  const qList = (questions || []) as Array<{ id: string; created_at: string | null; published_at: string | null }>;
  if (!qList.length) return ok(res, empty);

  const publishAt = new Map<string, number>();
  for (const q of qList) {
    const t = q.published_at || q.created_at;
    publishAt.set(q.id, t ? new Date(t).getTime() : NaN);
  }
  const qIds = qList.map((q) => q.id);

  const { data: answers, error: aErr } = await supabaseAdmin
    .from('broadcast_answers')
    .select('question_id, user_id, is_correct, answered_at')
    .eq('org_id', user.org_id)
    .in('question_id', qIds);
  if (aErr) return badRequest(res, aErr.message);
  const aList = (answers || []) as Array<{ question_id: string; user_id: string | null; is_correct: boolean | null; answered_at: string | null }>;

  const userIds = [...new Set(aList.map((a) => a.user_id).filter(Boolean))] as string[];
  const { data: users } = userIds.length
    ? await supabaseAdmin.from('users').select('id, name, employee_id, role').in('id', userIds)
    : { data: [] as Array<{ id: string; name: string; employee_id: string | null; role: string | null }> };
  const userMap = new Map<string, { name: string; employee_id: string | null; role: string | null }>();
  for (const u of (users || []) as Array<{ id: string; name: string; employee_id: string | null; role: string | null }>) {
    userMap.set(u.id, { name: u.name, employee_id: u.employee_id, role: u.role });
  }

  interface Agg {
    user_id: string; name: string; employee_id: string | null; role: string | null;
    answered: number; correct: number; times: number[]; correct_times: number[];
  }
  const byUser = new Map<string, Agg>();
  for (const a of aList) {
    if (!a.user_id) continue;
    let agg = byUser.get(a.user_id);
    if (!agg) {
      const u = userMap.get(a.user_id) || { name: 'Unknown', employee_id: null, role: null };
      agg = { user_id: a.user_id, name: u.name, employee_id: u.employee_id, role: u.role, answered: 0, correct: 0, times: [], correct_times: [] };
      byUser.set(a.user_id, agg);
    }
    agg.answered += 1;
    const pub = publishAt.get(a.question_id);
    const sec = (pub != null && !Number.isNaN(pub) && a.answered_at)
      ? Math.max(0, Math.round((new Date(a.answered_at).getTime() - pub) / 1000))
      : null;
    if (sec != null) agg.times.push(sec);
    if (a.is_correct === true) {
      agg.correct += 1;
      if (sec != null) agg.correct_times.push(sec);
    }
  }

  const rows = [...byUser.values()].map((a) => {
    const avg = a.times.length ? Math.round(a.times.reduce((x, y) => x + y, 0) / a.times.length) : null;
    const fastest = a.correct_times.length ? Math.min(...a.correct_times) : (a.times.length ? Math.min(...a.times) : null);
    return {
      user_id: a.user_id, name: a.name, employee_id: a.employee_id, role: a.role,
      answered: a.answered, correct: a.correct,
      accuracy: a.answered ? Math.round((a.correct / a.answered) * 100) : 0,
      avg_response_sec: avg, fastest_response_sec: fastest,
    };
  });

  const leaderboard = [...rows]
    .sort((x, y) =>
      (y.correct - x.correct) ||
      ((x.avg_response_sec ?? Infinity) - (y.avg_response_sec ?? Infinity)) ||
      (y.answered - x.answered))
    .map((r, i) => ({ rank: i + 1, ...r }));

  const fastest = [...rows]
    .filter((r) => r.fastest_response_sec != null)
    .sort((x, y) => (x.fastest_response_sec as number) - (y.fastest_response_sec as number))
    .slice(0, 10)
    .map((r, i) => ({ rank: i + 1, ...r }));

  return ok(res, { leaderboard, fastest, question_count: qList.length, as_of: new Date().toISOString() });
});
