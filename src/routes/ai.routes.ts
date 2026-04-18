import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, AppError } from '../utils';
import { AIService } from '../services/ai.service';

const router = Router();

// --- AI CHATBOT / ASSISTANT ---
router.post('/chat', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new AppError(400, 'messages array is required', 'VALIDATION_ERROR');
  }

  const text = await AIService.callKiniAI({
    system: system || 'You are Kini AI, an operations assistant for a field force management platform.',
    messages,
    max_tokens: 1000
  });

  res.json({ success: true, data: { text } });
}));

// --- AI FORM GENERATION ---
router.post('/generate-form', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { problemStatement } = req.body;

  if (!problemStatement) {
    throw new AppError(400, 'problemStatement is required', 'VALIDATION_ERROR');
  }

  const systemPrompt = `
You are a senior Operations Designer for "Kinematic", a field force management platform.
Your task is to take a "Problem Statement" and generate a structured data collection form.

### FORMAT REQUIREMENTS
You MUST return ONLY a valid JSON object. No preamble. No explanation.

### SUPPORTED FIELD TYPES (qtype)
- "short_text", "long_text", "number", "email", "phone"
- "radio", "checkbox", "dropdown", "yes_no", "rating"
- "date", "time", "datetime"
- "image", "file", "signature", "location" (GPS)
- "section_header" (Used to group fields)
- "consent" (I agree to terms...)

### DATA STRUCTURE
Return an object with:
1. "form": { "title": string, "description": string, "icon": string (emoji), "cover_color": string (hex) }
2. "questions": Array of { "qtype": string, "label": string, "placeholder": string, "is_required": boolean, "options": Array<{label:string, value:string}>, "helper_text": string }
`;

  const text = await AIService.callKiniAI({
    system: systemPrompt,
    messages: [{ role: 'user', content: `Problem Statement: ${problemStatement}` }],
    max_tokens: 2000
  });
  
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const jsonStr = text.substring(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    res.json({ success: true, data: parsed });
  } catch (e) {
    throw new AppError(500, 'AI failed to generate a valid form structure.', 'AI_ERROR');
  }
}));

// --- AI FORM METADATA RECOMMENDATIONS ---
router.post('/recommend-form-details', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { prompt, activities } = req.body;

  if (!prompt) {
    throw new AppError(400, 'prompt is required', 'VALIDATION_ERROR');
  }

  const systemPrompt = `
You are an expert operations consultant. Your task is to suggest form metadata based on a user's "Description Prompt".
You must also pick the most appropriate "Linked Activity" from a provided list of activities.

### OUTPUT FORMAT
You MUST return ONLY a valid JSON object. No preamble.
{
  "title": string (professional, concise form name),
  "description": string (clear summary of purpose),
  "activity_id": string (the EXACT ID of the most relevant activity from the provided list, or null if no close match),
  "icon": string (emoji),
  "cover_color": string (hex code of a professional color)
}

### AVILABLE ACTIVITIES
${JSON.stringify(activities || [])}
`;

  const text = await AIService.callKiniAI({
    system: systemPrompt,
    messages: [{ role: 'user', content: `Description Prompt: ${prompt}` }],
    max_tokens: 500
  });
  
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const jsonStr = text.substring(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    res.json({ success: true, data: parsed });
  } catch (e) {
    throw new AppError(500, 'AI failed to recommend form details.', 'AI_ERROR');
  }
}));

export default router;
