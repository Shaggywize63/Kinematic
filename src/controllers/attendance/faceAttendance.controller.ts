import { z } from 'zod';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, created, badRequest } from '../../utils';
import { isDemo } from '../../utils/demoData';
import { supabaseAdmin } from '../../lib/supabase';
import * as faceSvc from '../../services/attendance/faceAttendance.service';

/**
 * Face-recognition attendance endpoints (gated by requireModule('face_attendance')).
 *
 * The device does the biometric work (embed + 1:1 cosine match); these routes
 * only store/serve the reference embedding and expose enrolment status. The
 * per-check-in match RESULT is carried on the normal /attendance/checkin body
 * (see attendance.controller) — this controller is enrolment + status only.
 */

const enrollSchema = z.object({
  embedding: z.array(z.number()).min(32).max(2048),
  model_id: z.string().min(1).max(128),
  selfie_url: z.string().url().optional(),
  quality_score: z.number().min(0).max(1).optional(),
});

// POST /api/v1/attendance/face/enroll — set/replace the caller's reference face.
export const enrollFace = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return created(res, { enrolled: true, model_id: 'demo' }, 'Face enrolled (Demo)');
  const body = enrollSchema.safeParse(req.body);
  if (!body.success) return badRequest(res, 'Validation failed', body.error.errors);
  // zod already guaranteed embedding (≥32 floats) + model_id are present.
  const rec = await faceSvc.upsertEnrollment(user, {
    embedding: body.data.embedding as number[],
    model_id: body.data.model_id as string,
    selfie_url: body.data.selfie_url,
    quality_score: body.data.quality_score,
  });
  return created(res, { enrolled: true, model_id: rec.model_id, enrolled_at: rec.enrolled_at }, 'Face enrolled');
});

// GET /api/v1/attendance/face/enrollment — the caller's reference embedding,
// for the app's on-device 1:1 match at check-in.
export const getFaceEnrollment = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const rec = await faceSvc.getActiveEnrollment(user.id);
  if (!rec) return ok(res, { enrolled: false });
  return ok(res, {
    enrolled: true,
    embedding: rec.embedding,
    embedding_dim: rec.embedding_dim,
    model_id: rec.model_id,
    enrolled_at: rec.enrolled_at,
  });
});

// GET /api/v1/attendance/face/status — lightweight "am I enrolled?" (no embedding).
export const getFaceStatus = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { enrolled: false });
  return ok(res, await faceSvc.enrollmentStatus(user.id));
});

// DELETE /api/v1/attendance/face/enrollment — clear the caller's enrolment.
export const clearFaceEnrollment = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  await faceSvc.clearEnrollment(user.id);
  return ok(res, { enrolled: false }, 'Face enrolment cleared');
});

// GET /api/v1/attendance/face/team-status — supervisor+; which reps in the org
// are enrolled, for the admin roster "verified" badge. Org-scoped.
export const getTeamFaceStatus = asyncHandler<AuthRequest>(async (req, res) => {
  const user = req.user!;
  const { data } = await supabaseAdmin
    .from('user_face_enrollments')
    .select('user_id, model_id, enrolled_at')
    .eq('org_id', user.org_id)
    .eq('is_active', true);
  return ok(res, { enrolled: data ?? [] });
});
