import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../types';
import { asyncHandler, ok, badRequest, isDemo } from '../../utils';
import { verifyGstin } from '../../services/gstin-verify';
import { INDIA_STATES } from '../../utils/gstin';

// GET /api/v1/distribution/gstin/states — used by dropdowns
export const states = asyncHandler(async (_req: AuthRequest, res: Response) => {
  ok(res, INDIA_STATES);
});

const schema = z.object({ gstin: z.string().min(1).max(32) });

// POST /api/v1/distribution/gstin/verify
//   body: { gstin: "27AAACA1234A1Z5" }
//   returns: { valid, state_code, state_name, source, business_name?, ... }
export const verify = asyncHandler(async (req: AuthRequest, res: Response) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, 'gstin is required');

  if (isDemo(req.user!)) {
    return ok(res, {
      valid: true,
      gstin: parsed.data.gstin.toUpperCase(),
      state_code: '27',
      state_name: 'Maharashtra',
      pan: 'AAACA1234A',
      business_name: 'Aurora Foods Pvt Ltd (Demo)',
      legal_name: 'Aurora Foods Pvt Ltd',
      status: 'ACTIVE',
      address: 'Plot 12, MIDC Andheri, Mumbai 400093, Maharashtra',
      source: 'derived',
    });
  }

  const result = await verifyGstin(parsed.data.gstin);
  ok(res, result);
});
