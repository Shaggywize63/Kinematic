import { Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { AuthRequest } from '../types';
import { ok, badRequest, serverError } from '../utils/response';
import { asyncHandler } from '../utils/asyncHandler';
import { v4 as uuidv4 } from 'uuid';

const BUCKET_MAP: Record<string, string> = {
  selfie: process.env.BUCKET_SELFIES || 'kinematic-selfies',
  form_photo: process.env.BUCKET_FORM_PHOTOS || 'kinematic-form-photos',
  material: process.env.BUCKET_MATERIALS || 'kinematic-materials',
  avatar: process.env.BUCKET_AVATARS || 'kinematic-avatars',
};

// POST /api/v1/upload/:type
export const uploadFile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const { type } = req.params;

  if (!BUCKET_MAP[type]) return badRequest(res, `Invalid upload type. Valid: ${Object.keys(BUCKET_MAP).join(', ')}`);
  if (!req.file) return badRequest(res, 'No file provided');

  const ext = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
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
