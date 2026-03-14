import { Request, Response } from 'express';
import { supabase } from '../config/supabase';

/* ── GET /api/v1/candidates ─────────────────────────── */
export const getCandidates = async (req: Request, res: Response) => {
  try {
    const { stage, search } = req.query;
    let query = supabase
      .from('candidates')
      .select('*')
      .order('created_at', { ascending: false });

    if (stage) query = query.eq('stage', stage as string);
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,mobile.ilike.%${search}%,email.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/* ── POST /api/v1/candidates ────────────────────────── */
export const createCandidate = async (req: Request, res: Response) => {
  try {
    const {
      name, mobile, email, applied_role = 'executive', city,
      applied_zone, source, notes, resume_url,
    } = req.body;

    if (!name || !mobile) {
      return res.status(400).json({ success: false, error: 'name and mobile are required' });
    }

    const { data, error } = await supabase
      .from('candidates')
      .insert({
        name, mobile, email, applied_role, city,
        applied_zone: applied_zone || null,
        source, notes, resume_url,
        stage: 'applied',
        org_id: '00000000-0000-0000-0000-000000000001',
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/* ── GET /api/v1/candidates/:id ─────────────────────── */
export const getCandidateById = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/* ── PATCH /api/v1/candidates/:id ───────────────────── */
export const updateCandidate = async (req: Request, res: Response) => {
  try {
    const updates = { ...req.body, updated_at: new Date().toISOString() };

    // Auto-set timestamp fields based on stage
    if (req.body.stage === 'selected' && !req.body.selected_at) {
      updates.selected_at = new Date().toISOString();
    }
    if (req.body.stage === 'onboarded' && !req.body.onboarded_at) {
      updates.onboarded_at = new Date().toISOString();
    }
    if (req.body.stage === 'rejected' && !req.body.rejected_at) {
      updates.rejected_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('candidates')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/* ── GET /api/v1/candidates/:id/documents ───────────── */
export const getCandidateDocuments = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('candidate_documents')
      .select('*')
      .eq('candidate_id', req.params.id)
      .order('uploaded_at', { ascending: true });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/* ── POST /api/v1/candidates/:id/documents ──────────── */
export const addCandidateDocument = async (req: Request, res: Response) => {
  try {
    const { doc_type, doc_label, file_url, file_name } = req.body;

    if (!doc_type || !doc_label) {
      return res.status(400).json({ success: false, error: 'doc_type and doc_label are required' });
    }

    const { data, error } = await supabase
      .from('candidate_documents')
      .insert({
        candidate_id: req.params.id,
        doc_type, doc_label,
        file_url: file_url || null,
        file_name: file_name || null,
        uploaded_by: (req as any).user?.id || null,
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
