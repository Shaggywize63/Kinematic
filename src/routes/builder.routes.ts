import { Router, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncHandler, sendSuccess, AppError } from "../utils";
import { supabaseAdmin } from "../lib/supabase";
import { AuthRequest } from "../types";
const router = Router();

/* ── Forms ───────────────────────────────────────── */

// GET /api/v1/builder/forms
router.get(
  "/forms",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user?.org_id;
    if (!orgId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");

    const { data, error } = await supabaseAdmin
      .from("builder_forms")
      .select("*")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false });

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data);
  })
);

// POST /api/v1/builder/forms
router.post(
  "/forms",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user?.org_id;
    if (!orgId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");

    const { title, description, icon, cover_color, activity_id } = req.body;

    if (!title?.trim())
      throw new AppError(400, "title is required", "VALIDATION_ERROR");

    const { data, error } = await supabaseAdmin
      .from("builder_forms")
      .insert({
        org_id: orgId,
        title: title.trim(),
        description,
        icon: icon || "📋",
        cover_color: cover_color || "#E01E2C",
        activity_id: activity_id || null,
        status: "draft",
        version: 1,
      })
      .select()
      .single();

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data, "Created", 201);
  })
);

// PATCH /api/v1/builder/forms/:id
router.patch(
  "/forms/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user?.org_id;
    if (!orgId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");

    const allowed = ["title", "description", "status", "icon", "cover_color"];

    const updates: any = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from("builder_forms")
      .update(updates)
      .eq("id", req.params.id)
      .eq("org_id", orgId)
      .select()
      .single();

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data);
  })
);

// DELETE /api/v1/builder/forms/:id
router.delete(
  "/forms/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user?.org_id;
    if (!orgId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");

    // Manual cascade delete due to lack of FK ON DELETE CASCADE
    const { error: e1 } = await supabaseAdmin.from("builder_submissions").delete().eq("form_id", req.params.id);
    if (e1) throw new AppError(500, e1.message, "DB_ERROR");

    const { error: e2 } = await supabaseAdmin.from("builder_questions").delete().eq("form_id", req.params.id);
    if (e2) throw new AppError(500, e2.message, "DB_ERROR");

    const { error: e3 } = await supabaseAdmin.from("builder_pages").delete().eq("form_id", req.params.id);
    if (e3) throw new AppError(500, e3.message, "DB_ERROR");
    
    const { error: e4 } = await supabaseAdmin
      .from("builder_forms")
      .delete()
      .eq("id", req.params.id)
      .eq("org_id", orgId);
    
    if (e4) throw new AppError(500, e4.message, "DB_ERROR");

    return sendSuccess(res, { deleted: true });
  })
);

/* ── Pages ───────────────────────────────────────── */

router.get(
  "/forms/:id/pages",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { data, error } = await supabaseAdmin
      .from("builder_pages")
      .select("*")
      .eq("form_id", req.params.id)
      .order("page_order");

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data);
  })
);

router.post(
  "/forms/:id/pages",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { title, description, page_order } = req.body;

    const { data, error } = await supabaseAdmin
      .from("builder_pages")
      .insert({
        form_id: req.params.id,
        title: title || "Page",
        description,
        page_order: page_order || 0,
      })
      .select()
      .single();

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data, "Created", 201);
  })
);

router.patch(
  "/pages/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { title, description, page_order } = req.body;

    const { data, error } = await supabaseAdmin
      .from("builder_pages")
      .update({ title, description, page_order })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data);
  })
);

router.delete(
  "/pages/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await supabaseAdmin.from("builder_pages").delete().eq("id", req.params.id);

    return sendSuccess(res, { deleted: true });
  })
);

/* ── Questions ───────────────────────────────────── */

router.get(
  "/forms/:id/questions",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { data, error } = await supabaseAdmin
      .from("builder_questions")
      .select("*")
      .eq("form_id", req.params.id)
      .order("q_order");

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data);
  })
);

router.post(
  "/forms/:id/questions",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const {
      page_id,
      qtype,
      label,
      placeholder,
      helper_text,
      is_required,
      q_order,
      options,
      validation,
      logic,
      prefill_key,
      media_config,
    } = req.body;

    if (!qtype)
      throw new AppError(400, "qtype is required", "VALIDATION_ERROR");

    const { data, error } = await supabaseAdmin
      .from("builder_questions")
      .insert({
        form_id: req.params.id,
        page_id,
        qtype,
        label: label || "Question",
        placeholder,
        helper_text,
        is_required: is_required || false,
        q_order: q_order || 0,
        options: options || [],
        validation: validation || {},
        logic: logic || [],
        prefill_key,
        media_config: media_config || {},
      })
      .select()
      .single();

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data, "Created", 201);
  })
);

router.patch(
  "/questions/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const allowed = [
      "label",
      "placeholder",
      "helper_text",
      "is_required",
      "q_order",
      "options",
      "validation",
      "logic",
      "prefill_key",
      "media_config",
      "page_id",
    ];

    const updates: any = {};
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });

    const { data, error } = await supabaseAdmin
      .from("builder_questions")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data);
  })
);

router.delete(
  "/questions/:id",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await supabaseAdmin
      .from("builder_questions")
      .delete()
      .eq("id", req.params.id);

    return sendSuccess(res, { deleted: true });
  })
);

/* ── Submissions ─────────────────────────────────── */

router.get(
  "/forms/:id/submissions",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { data, error } = await supabaseAdmin
      .from("builder_submissions")
      .select("*, users(name, employee_id)")
      .eq("form_id", req.params.id)
      .order("submitted_at", { ascending: false });

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data);
  })
);

router.post(
  "/forms/:id/submissions",
  requireAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { answers, location_lat, location_lng, is_offline } = req.body;

    const user = req.user;

    const { data, error } = await supabaseAdmin
      .from("builder_submissions")
      .insert({
        form_id: req.params.id,
        submitted_by: user?.id,
        answers: answers || {},
        location_lat,
        location_lng,
        is_offline: is_offline || false,
        status: "submitted",
      })
      .select()
      .single();

    if (error) throw new AppError(500, error.message, "DB_ERROR");

    return sendSuccess(res, data, "Created", 201);
  })
);

export default router;
