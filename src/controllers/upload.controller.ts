import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest, serverError, isDemo } from '../utils';
import { asyncHandler } from '../utils/asyncHandler';
import { v4 as uuidv4 } from 'uuid';

const BUCKET_MAP: Record<string, string> = {
  selfie: process.env.BUCKET_SELFIES || 'kinematic-selfies',
  form_photo: process.env.BUCKET_FORM_PHOTOS || 'form-responses',
  photo: process.env.BUCKET_FORM_PHOTOS || 'form-responses',
  // iOS uploads form-field images to /upload/activity_form (the type
  // string KinematicRepository passes when posting from a form). The
  // type was missing from BUCKET_MAP, so every upload returned a 400
  // "Invalid upload type", uploadImage returned nil, and no photo URL
  // was sent in the submission — explaining why captured images never
  // showed up in the dashboard Submission Details modal.
  activity_form: process.env.BUCKET_FORM_PHOTOS || 'form-responses',
  signature: process.env.BUCKET_FORM_PHOTOS || 'form-responses',
  file: process.env.BUCKET_FORM_PHOTOS || 'form-responses',
  material: process.env.BUCKET_MATERIALS || 'kinematic-materials',
  avatar: process.env.BUCKET_AVATARS || 'kinematic-avatars',
  planogram: process.env.BUCKET_PLANOGRAMS || 'form-responses',
  // Per-SKU reference pack shots for planogram shelf-recognition. Must live in
  // a PUBLIC bucket — see PUBLIC_TYPES below.
  planogram_ref: process.env.BUCKET_PLANOGRAM_REFS || 'planogram-refs',
};

// Upload types whose bucket must be PUBLIC (a directly fetchable URL, not a
// signed one). Shelf-recognition fetches planogram reference images server-side
// with a plain GET (planogram.service.fetchImageAsBase64), so a private/signed
// URL would 401 and the reference would be silently skipped. The bucket is
// self-provisioned on first use so it works in every project without manual setup.
const PUBLIC_TYPES = new Set(['planogram_ref']);

async function ensurePublicBucket(bucket: string): Promise<void> {
  const { data } = await supabaseAdmin.storage.getBucket(bucket);
  if (data) {
    if (!data.public) await supabaseAdmin.storage.updateBucket(bucket, { public: true });
    return;
  }
  const { error } = await supabaseAdmin.storage.createBucket(bucket, {
    public: true,
    fileSizeLimit: 8 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  // Ignore a create race ("already exists") — another concurrent upload won.
  if (error && !/exist/i.test(error.message)) throw error;
}

// POST /api/v1/upload/:type
export const uploadFile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  if (isDemo(user)) return ok(res, { url: 'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?q=80&w=2070&auto=format&fit=crop', path: 'demo/demo.jpg', bucket: 'demo' });
  const { type } = req.params;

  if (!BUCKET_MAP[type]) return badRequest(res, `Invalid upload type. Valid: ${Object.keys(BUCKET_MAP).join(', ')}`);
  if (!req.file) return badRequest(res, 'No file provided');

  const MIME_TO_EXT: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
    'application/pdf': 'pdf',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/webm': 'webm',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  };
  const ext = MIME_TO_EXT[req.file.mimetype] ?? req.file.mimetype.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
  const path = `${user.org_id}/${user.id}/${uuidv4()}.${ext}`;
  const bucket = BUCKET_MAP[type];

  // Public-bucket types (planogram reference packs) must resolve to a directly
  // fetchable URL, so make sure the bucket exists and is public first.
  if (PUBLIC_TYPES.has(type)) await ensurePublicBucket(bucket);

  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(path, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (error) return serverError(res);

  // Most buckets are PRIVATE (public=false): this URL is a stable bucket+path
  // *reference*, NOT directly fetchable — display goes through GET
  // /api/v1/media/sign (media.controller.ts), which returns a short-lived signed
  // URL. For PUBLIC_TYPES (planogram_ref) the bucket is public, so getPublicUrl
  // returns a genuinely fetchable URL. Returning path+bucket lets callers sign
  // without re-parsing. (DPDP §8(5).)
  const { data: { publicUrl } } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);

  return ok(res, { url: publicUrl, path, bucket });
});
