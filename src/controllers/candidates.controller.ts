import { Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { asyncHandler, sendSuccess, AppError } from '../utils';

const ORG_ID = '00000000-0000-0000-0000-000000000001';

/* ── GET /api/v1/candidates ─────────────────────────── */
export const getCandidates = asyncHandler(async (req: Request, res: Response) => {
  const { stage, search } = req.query;
  let query = supabaseAdmin
    .from('candidates')
    .select('*')
    .eq('org_id', ORG_ID)
    .order('created_at', { ascending: false });

  if (stage) query = query.eq('stage', stage as string);
  if (search) {
    query = query.or(
      `name.ilike.%${search}%,mobile.ilike.%${search}%,email.ilike.%${search}%`
    );
  }

  const { data, error } = await query;
  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, data);
});

/* ── POST /api/v1/candidates ────────────────────────── */
export const createCandidate = asyncHandler(async (req: Request, res: Response) => {
  const {
    name, mobile, email, applied_role = 'executive', city,
    applied_zone, source, notes, resume_url,
  } = req.body;

  if (!name || !mobile) {
    throw new AppError(400, 'name and mobile are required', 'VALIDATION_ERROR');
  }

  const { data, error } = await supabaseAdmin
    .from('candidates')
    .insert({
      org_id: ORG_ID,
      name, mobile, email: email || null,
      applied_role, city: city || null,
      applied_zone: applied_zone || null,
      source: source || null,
      notes: notes || null,
      resume_url: resume_url || null,
      stage: 'applied',
    })
    .select()
    .single();

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, data, 'Candidate added', 201);
});

/* ── GET /api/v1/candidates/:id ─────────────────────── */
export const getCandidateById = asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('candidates')
    .select('*')
    .eq('id', req.params.id)
    .eq('org_id', ORG_ID)
    .single();

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  if (!data) throw new AppError(404, 'Candidate not found', 'NOT_FOUND');
  sendSuccess(res, data);
});

/* ── PATCH /api/v1/candidates/:id ───────────────────── */
export const updateCandidate = asyncHandler(async (req: Request, res: Response) => {
  const updates: any = { ...req.body, updated_at: new Date().toISOString() };

  if (req.body.stage === 'selected'  && !req.body.selected_at)  updates.selected_at  = new Date().toISOString();
  if (req.body.stage === 'onboarded' && !req.body.onboarded_at) updates.onboarded_at = new Date().toISOString();
  if (req.body.stage === 'rejected'  && !req.body.rejected_at)  updates.rejected_at  = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('candidates')
    .update(updates)
    .eq('id', req.params.id)
    .eq('org_id', ORG_ID)
    .select()
    .single();

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, data, 'Candidate updated');
});

/* ── GET /api/v1/candidates/:id/documents ───────────── */
export const getCandidateDocuments = asyncHandler(async (req: Request, res: Response) => {
  const { data, error } = await supabaseAdmin
    .from('candidate_documents')
    .select('*')
    .eq('candidate_id', req.params.id)
    .order('uploaded_at', { ascending: true });

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, data);
});

/* ── POST /api/v1/candidates/:id/documents ──────────── */
export const addCandidateDocument = asyncHandler(async (req: Request, res: Response) => {
  const { doc_type, doc_label, file_url, file_name } = req.body;

  if (!doc_type || !doc_label) {
    throw new AppError(400, 'doc_type and doc_label are required', 'VALIDATION_ERROR');
  }

  const { data, error } = await supabaseAdmin
    .from('candidate_documents')
    .insert({
      candidate_id: req.params.id,
      doc_type,
      doc_label,
      file_url:  file_url  || null,
      file_name: file_name || null,
      uploaded_by: (req as any).user?.id || null,
    })
    .select()
    .single();

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, data, 'Document added', 201);
});

/* ── PATCH /api/v1/candidates/:id/documents/:docId ── */
export const updateCandidateDocument = asyncHandler(async (req: Request, res: Response) => {
  const { doc_value, file_url, file_name } = req.body;
  const updates: any = {};
  if (doc_value  !== undefined) updates.doc_value  = doc_value;
  if (file_url   !== undefined) updates.file_url   = file_url;
  if (file_name  !== undefined) updates.file_name  = file_name;

  const { data, error } = await supabaseAdmin
    .from('candidate_documents')
    .update(updates)
    .eq('id', req.params.docId)
    .eq('candidate_id', req.params.id)
    .select()
    .single();

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, data, 'Document updated');
});

/* ── DELETE /api/v1/candidates/:id/documents/:docId ── */
export const deleteCandidateDocument = asyncHandler(async (req: Request, res: Response) => {
  const { error } = await supabaseAdmin
    .from('candidate_documents')
    .delete()
    .eq('id', req.params.docId)
    .eq('candidate_id', req.params.id);

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  sendSuccess(res, null, 'Document deleted');
});
