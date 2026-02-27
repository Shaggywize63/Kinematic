import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound, conflict } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';

const questionSchema = z.object({
  question: z.string().min(5),
  options: z.array(z.object({
    label: z.string(),
    value: z.string(),
    is_correct: z.boolean().optional(),
  })).min(2),
  correct_option: z.number().int().optional(),
  is_urgent: z.boolean().default(false),
  deadline_at: z.string().datetime().optional(),
  target_roles: z.array(z.string()).default(['executive']),
  target_zone_ids: z.array(z.string().uuid()).default([]),
});

const answerSchema = z.object({
  selected: z.number().int().min(0),
});

// GET /api/v1/broadcast  — get active questions for current user
export const getQuestions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;

  const { data, error } = await supabaseAdmin
    .from('broadcast_questions')
    .select(`
      id, question, options, correct_option, is_urgent, deadline_at, status, created_at,
      broadcast_answers!left(id, selected, is_correct, answered_at)
    `)
    .eq('org_id', user.org_id)
    .eq('status', 'active')
    .contains('target_roles', [user.role])
    .order('is_urgent', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return badRequest(res, error.message);

  // Mask correct_option from executives
  const sanitised = (data || []).map((q) => ({
    ...q,
    correct_option: ['admin', 'city_manager', 'super_admin'].includes(user.role)
      ? q.correct_option
      : undefined,
    already_answered: Array.isArray(q.broadcast_answers) && q.broadcast_answers.length > 0,
    my_answer: Array.isArray(q.broadcast_answers) && q.broadcast_answers.length > 0
      ? q.broadcast_answers[0]
      : null,
    broadcast_answers: undefined,
  }));

  return ok(res, sanitised);
});

// POST /api/v1/broadcast  (admin+)
export const createQuestion = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const body = questionSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('broadcast_questions')
    .insert({ ...body.data, org_id: user.org_id, created_by: user.id })
    .select()
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Question posted');
});

// POST /api/v1/broadcast/:id/answer
export const submitAnswer = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;
  const body = answerSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  // Check question exists and is active
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

  // Check not already answered
  const { data: existing } = await supabaseAdmin
    .from('broadcast_answers')
    .select('id')
    .eq('question_id', id)
    .eq('user_id', user.id)
    .single();

  if (existing) return conflict(res, 'Already answered this question');

  const opts = question.options as unknown[];
  if (body.data.selected >= opts.length) return badRequest(res, 'Invalid option index');

  const is_correct = question.correct_option !== null
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

// GET /api/v1/broadcast/:id/results  (admin+)
export const getResults = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { id } = req.params;

  const { data: question } = await supabaseAdmin
    .from('broadcast_questions')
    .select('*, broadcast_answers(*, users(name, employee_id))')
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
