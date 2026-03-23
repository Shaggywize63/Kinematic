import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, AppError } from '../utils';

const router = Router();

router.post('/chat', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new AppError(400, 'messages array is required', 'VALIDATION_ERROR');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AppError(500, 'AI service not configured. Set ANTHROPIC_API_KEY on Railway.', 'CONFIG_ERROR');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     system || 'You are Kinematic AI, an operations assistant for a field force management platform.',
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = (err as any)?.error?.message || `Anthropic API error: ${response.status}`;
    throw new AppError(response.status, msg, 'AI_ERROR');
  }

  const data: any = await response.json();
  const text = data?.content?.[0]?.text || '';

  res.json({ success: true, data: { text } });
}));

export default router;
