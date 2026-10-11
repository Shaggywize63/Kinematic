import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, isDemo } from '../../utils';
import { signUpload, UploadKind } from '../../utils/upload-signer';

// The Android app has always asked for "distribution/cheque" / "distribution/return" (its own bucket-prefix
// wording), which the strict enum refused with a 400 - so a cheque payment's photo could never be uploaded.
// Accept that prefix too; the stored path is unchanged (`org/<id>/distribution/<kind>/...`).
const signSchema = z.object({
  kind: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/^distribution\//, '') : v),
    z.enum(['cheque', 'pod', 'return', 'signature', 'kyc']),
  ),
  ext: z.string().regex(/^[a-z0-9]{1,8}$/i).optional(),
});

export const sign = asyncHandler(async (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const parsed = signSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'Validation failed', parsed.error.errors);
  if (isDemo(user)) {
    return ok(res, {
      upload_url: 'https://example.com/demo-upload',
      token: 'demo',
      bucket: 'distribution',
      path: `org/demo/distribution/${parsed.data.kind}/demo.jpg`,
      public_url: 'https://example.com/demo-uploaded.jpg',
      expires_in: 300,
    });
  }
  const out = await signUpload(user.org_id, parsed.data.kind as UploadKind, parsed.data.ext);
  ok(res, out);
});
