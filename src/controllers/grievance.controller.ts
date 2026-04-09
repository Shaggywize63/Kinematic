import { Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, created, badRequest, notFound } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { DEMO_ORG_ID, getMockGrievances } from '../utils/demoData';

const submitSchema = z.object({
  category: z.enum(['harassment_misconduct','unfair_treatment','payment_salary','stock_supply','work_environment','supervisor_conduct','other']),
  against_role: z.enum(['super_admin','admin','city_manager','supervisor','executive']).optional(),
  incident_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().min(20),
  evidence_urls: z.array(z.string().url()).default([]),
  is_anonymous: z.boolean().default(false),
});

const updateStatusSchema = z.object({
  status: z.enum(['under_review','resolved','dismissed']),
  resolution: z.string().optional(),
});

// POST /api/v1/grievances
export const submit = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const body = submitSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('grievances')
    .insert({ ...body.data, org_id: user.org_id, submitted_by: user.id })
    .select('id, reference_no, status, created_at')
    .single();

  if (error) return badRequest(res, error.message);
  return created(res, data, 'Grievance submitted. HR will review within 48 hours.');
});

// GET /api/v1/grievances/mine
export const getMine = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { data, error } = await supabaseAdmin
    .from('grievances')
    .select('id, reference_no, category, status, incident_date, created_at, resolution')
    .eq('submitted_by', user.id)
    .order('created_at', { ascending: false });
  if (error) return badRequest(res, error.message);
  return ok(res, data);
});

// GET /api/v1/admin/grievances  (admin+)
export const getAll = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  
  const status = req.query.status as string | undefined;

  let query = supabaseAdmin
    .from('grievances')
    .select('*, users!submitted_by(name, employee_id, role, zone_id)')
    .eq('org_id', user.org_id)
    .order('created_at', { ascending: false });

  if (isUUID(user.client_id)) {
    query = query.eq('client_id', user.client_id);
  } else if (isUUID(req.query.client_id as string)) {
    query = query.eq('client_id', req.query.client_id as string);
  }

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return badRequest(res, error.message);

  // Mask identity for anonymous submissions
  const sanitised = (data || []).map((g) => ({
    ...g,
    users: g.is_anonymous ? null : g.users,
    submitted_by: g.is_anonymous ? null : g.submitted_by,
  }));

  return ok(res, sanitised);
});

// PATCH /api/v1/admin/grievances/:id  (admin+)
export const updateStatus = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { id } = req.params;
  const body = updateStatusSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);

  const { data, error } = await supabaseAdmin
    .from('grievances')
    .update({ ...body.data, reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq('id', id).eq('org_id', user.org_id)
    .select().single();

  if (error || !data) return notFound(res, 'Grievance not found');
  return ok(res, data, 'Status updated');
});
