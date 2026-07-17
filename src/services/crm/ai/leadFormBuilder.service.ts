/**
 * KINI AI — lead-form (custom-field) builder.
 *
 * Two-step flow used by CRM Settings → Custom Fields:
 *   1. suggestQuestions(): the admin writes a plain-English problem statement
 *      ("I run a solar-panel installer and want to capture rooftop leads").
 *      KINI infers the industry and returns a short list of clarifying
 *      questions — a mix of generic (B2B/B2C, consent, how you'll segment)
 *      and industry-specific ones — so the generated form is tailored.
 *   2. generateFields(): given the problem statement + the admin's answers,
 *      KINI proposes a comprehensive set of custom fields for the entity.
 *      The dashboard previews them (editable), and on accept each field is
 *      created through the normal /custom-fields path.
 *
 * We deliberately reuse the existing hardened `AIService.callKiniAI` (raw
 * Messages API + dynamic org-key resolution + opaque-error mapping) instead
 * of pulling in a new SDK — every other KINI feature in this repo goes
 * through that path. The model returns JSON as text; we extract + sanitise
 * it here so a malformed field_key / unknown type / missing option list can
 * never reach the DB.
 */
import { AIService } from '../../ai.service';
import { AppError } from '../../../utils';

// The directly-inputtable subset of crm_custom_field_defs.field_type that
// KINI is allowed to propose. We exclude `lookup` (needs a target table),
// `formula` (needs an expression referencing other fields) and image/file
// (rarely useful for intake) — the admin can still switch a previewed field
// to any of those by hand in the editor before accepting.
const AI_FIELD_TYPES = [
  'text', 'longtext', 'number', 'currency', 'boolean',
  'date', 'datetime', 'select', 'multiselect', 'radio',
  'url', 'email', 'phone',
] as const;
type AiFieldType = (typeof AI_FIELD_TYPES)[number];
const OPTION_TYPES = new Set<AiFieldType>(['select', 'multiselect', 'radio']);
const AI_FIELD_TYPE_SET = new Set<string>(AI_FIELD_TYPES);

// Primary model for form design. Overridable so ops can downgrade without a
// code change; falls back to the repo-wide default if the primary errors
// (e.g. an org key without Opus access) so the feature degrades gracefully.
const BUILDER_MODEL = process.env.KINI_FORM_BUILDER_MODEL || 'claude-opus-4-8';
const FALLBACK_MODEL = 'claude-haiku-4-5';

const ENTITY_LABELS: Record<string, string> = {
  lead: 'lead', contact: 'contact', account: 'account',
  deal: 'deal / opportunity', activity: 'field activity',
};

export interface ClarifyingQuestion {
  id: string;
  kind: 'generic' | 'industry';
  question: string;
  help?: string;
  suggestions?: string[];
}

export interface ProposedField {
  field_key: string;
  label: string;
  field_type: AiFieldType;
  required: boolean;
  options?: string[];
  help?: string;
}

/** Pull the first JSON object out of a model reply, tolerating ```json
 *  fences or a sentence of preamble the model slipped in despite the
 *  "JSON only" instruction. Throws a clean AI_ERROR if nothing parses. */
function extractJson<T>(text: string): T {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new AppError(502, 'KINI returned an unexpected response — please try again.', 'AI_ERROR');
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    throw new AppError(502, 'KINI returned an invalid form — please try again.', 'AI_ERROR');
  }
}

/** Run a builder prompt against the primary model, falling back to the
 *  repo default once if the primary is unavailable/errors. */
async function callBuilder(system: string, userContent: string, maxTokens: number): Promise<string> {
  try {
    return await AIService.callKiniAI({
      system,
      messages: [{ role: 'user', content: userContent }],
      model: BUILDER_MODEL,
      max_tokens: maxTokens,
    });
  } catch (e) {
    // Config errors (no key at all) can't be fixed by swapping models —
    // rethrow so the route surfaces the "AI offline" message. For anything
    // else, try the cheaper default model once before giving up.
    if ((e as { code?: string })?.code === 'CONFIG_ERROR' || BUILDER_MODEL === FALLBACK_MODEL) throw e;
    console.warn(`[leadFormBuilder] ${BUILDER_MODEL} failed, retrying with ${FALLBACK_MODEL}:`, (e as Error)?.message);
    return AIService.callKiniAI({
      system,
      messages: [{ role: 'user', content: userContent }],
      model: FALLBACK_MODEL,
      max_tokens: maxTokens,
    });
  }
}

/** Normalise a model-proposed key into a valid crm_custom_field_defs
 *  field_key: lowercase, snake_case, starts with a letter, ≤ 80 chars. */
function normaliseKey(raw: unknown, fallback: string): string {
  let k = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(k)) k = `f_${k}`;
  k = k.slice(0, 80).replace(/_+$/g, '');
  return k || fallback;
}

function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of raw) {
    const s = (typeof o === 'string' ? o : typeof o === 'object' && o
      ? String((o as { label?: unknown; value?: unknown }).label ?? (o as { value?: unknown }).value ?? '')
      : String(o ?? '')).trim().slice(0, 80);
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    if (out.length >= 30) break;
  }
  return out;
}

export async function suggestQuestions(input: {
  problemStatement: string;
  entityType: string;
}): Promise<{ industry: string; summary: string; questions: ClarifyingQuestion[] }> {
  const entityLabel = ENTITY_LABELS[input.entityType] || 'lead';
  const system = `You are KINI, a senior CRM solution designer for "Kinematic", a multi-tenant field-force + CRM platform.

An admin will describe, in plain language, what they want their **${entityLabel} intake form** to capture. Your job in THIS step is NOT to design the form yet — it is to ask a short set of smart clarifying questions so the form you build next is comprehensive and tailored to their industry.

Do this:
1. Infer the most likely industry / business type from the statement.
2. Produce 4–7 concise clarifying questions. Mix:
   - "generic" questions every CRM needs answered (e.g. are these B2B or B2C leads, which identity fields are mandatory, what consent/compliance data is required, how they want to segment or report).
   - "industry" questions specific to the industry you inferred (the details that make THIS business's form different).
   Each question must materially change which fields end up on the form.
3. For each question, add a one-line "help" explaining why it matters, and 2–4 short "suggestions" the admin can pick from as example answers.

### OUTPUT — return ONLY this JSON object, no preamble, no markdown fence:
{
  "industry": "string — the industry/business type you inferred",
  "summary": "one sentence restating what they want to capture",
  "questions": [
    { "id": "q1", "kind": "generic" | "industry", "question": "string", "help": "short reason", "suggestions": ["string", "string"] }
  ]
}`;

  const text = await callBuilder(system, `Problem statement: ${input.problemStatement}`, 1400);
  const parsed = extractJson<{ industry?: unknown; summary?: unknown; questions?: unknown }>(text);

  const questions: ClarifyingQuestion[] = Array.isArray(parsed.questions)
    ? parsed.questions.slice(0, 10).map((q, i): ClarifyingQuestion => {
        const obj = (q ?? {}) as Record<string, unknown>;
        return {
          id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim().slice(0, 40) : `q${i + 1}`,
          kind: obj.kind === 'industry' ? 'industry' : 'generic',
          question: String(obj.question ?? '').trim().slice(0, 300),
          help: obj.help ? String(obj.help).trim().slice(0, 200) : undefined,
          suggestions: Array.isArray(obj.suggestions)
            ? obj.suggestions.map((s) => String(s).trim().slice(0, 80)).filter(Boolean).slice(0, 5)
            : undefined,
        };
      }).filter((q) => q.question)
    : [];

  return {
    industry: String(parsed.industry ?? '').trim().slice(0, 120) || 'General',
    summary: String(parsed.summary ?? '').trim().slice(0, 300),
    questions,
  };
}

export async function generateFields(input: {
  problemStatement: string;
  entityType: string;
  answers: Array<{ question: string; answer: string }>;
  existingKeys: string[];
}): Promise<{ formTitle: string; summary: string; fields: ProposedField[] }> {
  const entityLabel = ENTITY_LABELS[input.entityType] || 'lead';
  const existing = new Set((input.existingKeys || []).map((k) => k.toLowerCase()));

  const qa = (input.answers || [])
    .filter((a) => a && a.answer)
    .map((a) => `- ${a.question}\n  → ${a.answer}`)
    .join('\n');

  const system = `You are KINI, a senior CRM solution designer for "Kinematic". Design a comprehensive, production-ready set of **custom fields** for a ${entityLabel} intake form, based on the admin's problem statement and their answers to your clarifying questions.

### FIELD TYPES — you may ONLY use these values for "field_type":
${AI_FIELD_TYPES.join(', ')}
Choose the single best type per field. Use "select"/"radio" for a one-of list, "multiselect" for many-of, "currency" for money, "number" for counts/quantities, "date"/"datetime" for time, "email"/"phone"/"url" for those specific formats, "longtext" for notes, "boolean" for yes/no.

### RULES
- Return between 6 and 20 fields — enough to be genuinely comprehensive for this business, without padding.
- Do NOT re-create standard fields the CRM already has (name, primary phone, primary email, company, city, state, country, lead status, source, owner). Focus on the fields that make THIS business's form distinctive.
- "field_key": lowercase snake_case, starts with a letter, unique. NEVER reuse any of these existing keys: ${input.existingKeys.length ? input.existingKeys.join(', ') : '(none yet)'}.
- For select/multiselect/radio you MUST include a realistic "options" array (3–12 items).
- Mark "required": true ONLY for the few fields that are genuinely essential to qualify the ${entityLabel}.
- Keep "label" human and concise; add a short "help" hint per field.
- Order the fields the way they should appear on the form (most important first).

### OUTPUT — return ONLY this JSON object, no preamble, no markdown fence:
{
  "formTitle": "string",
  "summary": "one sentence describing the form you designed",
  "fields": [
    { "field_key": "string", "label": "string", "field_type": "one of the allowed types", "required": true|false, "options": ["only for select/multiselect/radio"], "help": "short hint" }
  ]
}`;

  const userContent = `Problem statement: ${input.problemStatement}

Clarifying answers:
${qa || '(the admin skipped the questions — use your best judgement for this industry)'}`;

  const text = await callBuilder(system, userContent, 4000);
  const parsed = extractJson<{ formTitle?: unknown; summary?: unknown; fields?: unknown }>(text);

  const usedKeys = new Set<string>();
  const fields: ProposedField[] = [];
  const rawFields = Array.isArray(parsed.fields) ? parsed.fields : [];
  for (let i = 0; i < rawFields.length && fields.length < 30; i++) {
    const obj = (rawFields[i] ?? {}) as Record<string, unknown>;
    const label = String(obj.label ?? '').trim().slice(0, 120);
    let key = normaliseKey(obj.field_key ?? label, `field_${i + 1}`);
    // Drop anything that collides with a field the entity already has, or a
    // key we already emitted in this batch — the DB unique constraint would
    // reject it and the admin doesn't want duplicates.
    if (existing.has(key.toLowerCase())) continue;
    let uniq = key;
    let n = 2;
    while (usedKeys.has(uniq.toLowerCase())) { uniq = `${key}_${n++}`.slice(0, 80); }
    key = uniq;
    if (!label) continue;

    let type: AiFieldType = AI_FIELD_TYPE_SET.has(String(obj.field_type)) ? (obj.field_type as AiFieldType) : 'text';
    let options: string[] | undefined;
    if (OPTION_TYPES.has(type)) {
      options = cleanOptions(obj.options);
      // A picker with no options is useless — downgrade to plain text so the
      // field is still usable rather than being silently un-fillable.
      if (options.length === 0) { type = 'text'; options = undefined; }
    }

    usedKeys.add(key.toLowerCase());
    fields.push({
      field_key: key,
      label,
      field_type: type,
      required: obj.required === true || obj.required === 'true',
      options,
      help: obj.help ? String(obj.help).trim().slice(0, 200) : undefined,
    });
  }

  return {
    formTitle: String(parsed.formTitle ?? '').trim().slice(0, 120) || `${entityLabel[0].toUpperCase()}${entityLabel.slice(1)} form`,
    summary: String(parsed.summary ?? '').trim().slice(0, 300),
    fields,
  };
}
