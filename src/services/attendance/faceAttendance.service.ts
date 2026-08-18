/**
 * Face-recognition attendance — reference enrolment store + roster status.
 *
 * On-device model: the app captures a front-camera selfie, computes a face
 * embedding locally, and (a) enrols it once as the reference, then (b) on each
 * check-in re-embeds, fetches this reference, and cosine-compares ON-DEVICE,
 * sending {face_score, face_verified, face_model_id} with the check-in.
 *
 * The backend is deliberately model-agnostic: it stores the raw embedding plus
 * the `model_id` that produced it and never compares embeddings itself — the
 * app only ever matches vectors sharing the same `model_id` (a rep who switches
 * platform/model re-enrols). Nothing here decrypts or reconstructs a face; the
 * embedding is an opaque float vector.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { AppError } from '../../utils';

export interface FaceEnrollmentInput {
  embedding: number[];
  model_id: string;
  selfie_url?: string | null;
  quality_score?: number | null;
}

export interface FaceEnrollment {
  id: string;
  org_id: string;
  client_id: string | null;
  user_id: string;
  embedding: number[];
  embedding_dim: number;
  model_id: string;
  selfie_url: string | null;
  quality_score: number | null;
  is_active: boolean;
  enrolled_at: string;
  updated_at: string;
}

/** Guard an incoming embedding: a non-empty float array of a sane dimension. */
function assertEmbedding(embedding: unknown): asserts embedding is number[] {
  if (!Array.isArray(embedding) || embedding.length < 32 || embedding.length > 2048) {
    throw new AppError(400, 'A valid face embedding (32–2048 floats) is required', 'BAD_EMBEDDING');
  }
  if (!embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new AppError(400, 'Face embedding must contain only finite numbers', 'BAD_EMBEDDING');
  }
}

/**
 * Upsert the user's reference face. Re-enrolment DEACTIVATES the prior active
 * reference and inserts a fresh one, so history is retained for audit rather
 * than hard-deleted. The partial unique index (user_id WHERE is_active) is the
 * backstop against two concurrent active references.
 */
export async function upsertEnrollment(
  user: { id: string; org_id: string; client_id?: string | null },
  input: FaceEnrollmentInput,
): Promise<FaceEnrollment> {
  assertEmbedding(input.embedding);
  if (!input.model_id || typeof input.model_id !== 'string') {
    throw new AppError(400, 'model_id is required', 'BAD_MODEL_ID');
  }

  await supabaseAdmin
    .from('user_face_enrollments')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('is_active', true);

  const { data, error } = await supabaseAdmin
    .from('user_face_enrollments')
    .insert({
      org_id: user.org_id,
      client_id: user.client_id ?? null,
      user_id: user.id,
      embedding: input.embedding,
      embedding_dim: input.embedding.length,
      model_id: input.model_id,
      selfie_url: input.selfie_url ?? null,
      quality_score: input.quality_score ?? null,
      is_active: true,
    })
    .select('*')
    .single();

  if (error) throw new AppError(500, error.message, 'DB_ERROR');
  return data as FaceEnrollment;
}

/** The user's active reference embedding, for on-device match at check-in. */
export async function getActiveEnrollment(userId: string): Promise<FaceEnrollment | null> {
  const { data } = await supabaseAdmin
    .from('user_face_enrollments')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  return (data as FaceEnrollment) ?? null;
}

/** Remove the user's enrolment (soft — deactivate the active row). */
export async function clearEnrollment(userId: string): Promise<void> {
  await supabaseAdmin
    .from('user_face_enrollments')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('is_active', true);
}

/** Which of these user ids have an active enrolment — for the admin roster
 *  "enrolled" badge. Returns a Set for O(1) lookup by the caller. */
export async function enrolledUserIds(orgId: string, userIds: string[]): Promise<Set<string>> {
  const ids = userIds.filter(Boolean);
  if (ids.length === 0) return new Set();
  const { data } = await supabaseAdmin
    .from('user_face_enrollments')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .in('user_id', ids);
  return new Set((data ?? []).map((r: { user_id: string }) => r.user_id));
}

/** Metadata only (no embedding) — for a lightweight "am I enrolled?" check
 *  and the enrolment-status screen. */
export async function enrollmentStatus(
  userId: string,
): Promise<{ enrolled: boolean; model_id?: string; enrolled_at?: string; selfie_url?: string | null }> {
  const { data } = await supabaseAdmin
    .from('user_face_enrollments')
    .select('model_id, enrolled_at, selfie_url')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (!data) return { enrolled: false };
  return {
    enrolled: true,
    model_id: (data as { model_id: string }).model_id,
    enrolled_at: (data as { enrolled_at: string }).enrolled_at,
    selfie_url: (data as { selfie_url: string | null }).selfie_url,
  };
}
