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
  signature: process.env.BUCKET_FORM_PHOTOS || 'form-responses',
  file: process.env.BUCKET_FORM_PHOTOS || 'form-responses',
  material: process.env.BUCKET_MATERIALS || 'kinematic-materials',
  avatar: process.env.BUCKET_AVATARS || 'kinematic-avatars',
  planogram: process.env.BUCKET_PLANOGRAMS || 'form-responses',
};

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

  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(path, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (error) return serverError(res);

  const { data: { publicUrl } } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);

  return ok(res, { url: publicUrl, path, bucket });
});
