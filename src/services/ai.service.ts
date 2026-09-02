import { AppError } from '../utils';

/**
 * Service to handle Anthropic AI communication and dynamic API key management
 */
export class AIService {
  private static functionalKey: string | null = null;
  private static lastFetched: number = 0;
  private static CACHE_LIMIT = 60 * 60 * 1000; // 1 hour caching

  // --- Servable-model discovery ------------------------------------------
  // The public Anthropic Messages API only accepts model ids the *functional
  // key* is provisioned for, and that set differs per org/plan. Our code
  // hard-codes ids (claude-sonnet-5 / claude-sonnet-4-6) that a given key may
  // not have — which surfaces as a 404 "model not found" and, historically,
  // the opaque "AI request failed". Rather than keep guessing an id, we ask the
  // key which models it can actually use (`GET /v1/models`) and self-heal a 404
  // by retrying with a discovered id. Cached ~1h alongside the key. This only
  // activates when the hard-coded id already fails, so a key for which the
  // pinned id works sees zero behaviour change (important for the Tata prod
  // tenant, whose behaviour must stay unchanged).
  private static resolvedModel: string | null = null;
  private static resolvedModelAt = 0;
  private static unavailableModels = new Set<string>();

  /**
   * Retrieves a functional Anthropic API key.
   * Uses Organization API dynamic fetch if credentials are provided,
   * otherwise falls back to static ANTHROPIC_API_KEY.
   */
  static async getFunctionalKey(): Promise<string> {
    const now = Date.now();
    
    // Return cached key if valid
    if (this.functionalKey && (now - this.lastFetched < this.CACHE_LIMIT)) {
      return this.functionalKey;
    }

    const orgKeyId = process.env.ANTHROPIC_ORG_KEY_ID;
    const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
    const staticKey = process.env.ANTHROPIC_API_KEY;

    // Phase 1: Try dynamic fetch if org credentials exist.
    // IMPORTANT: bound this with an AbortController. Without a deadline a slow
    // or hung Anthropic Org API pins the request indefinitely — every AI call
    // resolves the key first, so a hang here freezes draft/score/chat with no
    // error (the symptom we saw: requests stuck mid-flight, no usage recorded).
    // On timeout/error we fall through to the static key below.
    if (orgKeyId && adminKey) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8_000);
      try {
        const res = await fetch(`https://api.anthropic.com/v1/organizations/api_keys/${orgKeyId}`, {
          method: 'GET',
          headers: {
            'anthropic-version': '2023-06-01',
            'X-Api-Key': adminKey
          },
          signal: ac.signal,
        });

        if (res.ok) {
          const data: any = await res.json();
          // The structure expected from Anthropic's Org API for the functional key value
          const key = data.api_key || data.key || data.value;
          if (key) {
            this.functionalKey = key;
            this.lastFetched = now;
            return key;
          }
        }
      } catch (e) {
        console.warn('AIService: Dynamic key fetch failed/timed out, falling back to static key.', (e as Error)?.message);
      } finally {
        clearTimeout(timer);
      }
    }

    // Phase 2: Fallback to static key
    if (staticKey) return staticKey;

    // Last resort: if the dynamic fetch failed but we still hold a previously
    // minted key (now past its 1h cache window), use it rather than failing —
    // a stale-but-valid key beats a hard outage when the Org API is flaky.
    if (this.functionalKey) {
      console.warn('AIService: using stale cached key — dynamic refresh unavailable.');
      return this.functionalKey;
    }

    throw new AppError(500, 'AI authentication not configured. Set ANTHROPIC_ORG_KEY_ID or ANTHROPIC_API_KEY.', 'CONFIG_ERROR');
  }

  /**
   * Map an upstream Anthropic error to an opaque message before
   * surfacing it to the API caller. The raw upstream text can leak
   * key fragments on 401 ("Invalid API key: sk-ant-..."), rate-limit
   * metadata on 429, or internal model names on 500. Log the full
   * detail server-side, return a coarse message to the client.
   */
  private static opaqueAiError(
    status: number,
    upstream: string | { type?: string; message?: string } | undefined,
  ): AppError {
    const rawMsg = typeof upstream === 'string' ? upstream : upstream?.message || '';
    const type = typeof upstream === 'string' ? '' : upstream?.type || '';
    // Server-side log retains the full upstream detail (secrets redacted) for
    // ops debugging. Truncate so a malicious upstream can't pin our log writer.
    const detail = `${type ? type + ': ' : ''}${rawMsg}`.slice(0, 500);
    console.warn(`[AIService] upstream error status=${status}: ${detail.replace(/sk-[a-zA-Z0-9-]+/g, 'sk-[REDACTED]')}`);

    // Surface a SPECIFIC but secret-free reason. HTTP status codes and
    // Anthropic error `type`s never carry credentials; the free-text message is
    // scanned only to detect the (very common, very actionable) billing case.
    // Distinguishing 404-model / 401-key / 400-billing is what turned "AI
    // request failed" from an opaque dead-end into something diagnosable.
    const lc = `${type} ${rawMsg}`.toLowerCase();
    const isBilling =
      lc.includes('credit balance') || lc.includes('billing') ||
      lc.includes('payment') || lc.includes('insufficient');
    const opaque =
      status === 401 ? 'AI authentication failed (upstream 401) — the Anthropic API key is missing or invalid.'
      : status === 403 ? 'AI authorization failed (upstream 403) — this key cannot access the requested model.'
      : status === 429 ? 'AI service rate-limited — retry shortly (upstream 429).'
      : (status === 404 || type === 'not_found_error') ? 'AI model unavailable (upstream 404) — the configured model is not available to this API key.'
      : isBilling ? "AI unavailable — the workspace's Anthropic credits/billing need attention."
      : status >= 500 ? `AI service temporarily unavailable (upstream ${status}).`
      : `AI request failed (upstream ${status}${type ? ': ' + type : ''}).`;
    return new AppError(status, opaque, 'AI_ERROR');
  }

  /**
   * The model ids this functional key can actually serve, newest first.
   * Empty array on any failure (caller falls back to the hard-coded id).
   */
  static async listAccessibleModels(): Promise<string[]> {
    const apiKey = await this.getFunctionalKey();
    const res = await this.anthropicFetch(
      'https://api.anthropic.com/v1/models?limit=100',
      { method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
      15_000,
    ).catch(() => null);
    if (!res || !res.ok) return [];
    const data: any = await res.json().catch(() => ({}));
    return Array.isArray(data?.data) ? data.data.map((m: any) => String(m?.id)).filter(Boolean) : [];
  }

  /**
   * Pick a model this key can serve. Prefers `preferred` when the key has it,
   * else the newest sonnet, then opus, then haiku, then whatever's first.
   * Cached ~1h. Returns null if the key exposes no models (e.g. billing block).
   */
  static async pickServableModel(preferred?: string): Promise<string | null> {
    const now = Date.now();
    if (this.resolvedModel && now - this.resolvedModelAt < this.CACHE_LIMIT) return this.resolvedModel;
    const models = await this.listAccessibleModels();
    if (!models.length) return null;
    const pick =
      (preferred && models.includes(preferred) ? preferred : undefined) ||
      models.find((m) => /sonnet/i.test(m)) ||
      models.find((m) => /opus/i.test(m)) ||
      models.find((m) => /haiku/i.test(m)) ||
      models[0];
    this.resolvedModel = pick;
    this.resolvedModelAt = now;
    return pick;
  }

  /**
   * Fetch with hard deadline. Anthropic calls can hang on slow upstream
   * or slow downstream client; without a cap we tie up Node workers
   * indefinitely (100 slow clients = all workers blocked).
   */
  static async anthropicFetch(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === 'AbortError') {
        throw new AppError(504, 'AI service timed out', 'AI_TIMEOUT');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Centralized helper for Anthropics Messages API
   */
  static async callKiniAI(payload: { system?: string; messages: any[]; model?: string; max_tokens?: number; apiKey?: string }) {
    const apiKey = payload.apiKey || await this.getFunctionalKey();
    const requested = payload.model || 'claude-sonnet-5';

    const doCall = (model: string) =>
      this.anthropicFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: payload.max_tokens || 1000,
          system:     payload.system,
          messages:   payload.messages,
        }),
      });

    // If we've already learned this exact id isn't servable by the key, skip
    // the doomed call and go straight to the discovered model.
    let modelToUse = requested;
    if (this.unavailableModels.has(requested) && this.resolvedModel) modelToUse = this.resolvedModel;

    let response = await doCall(modelToUse);

    // Self-heal a model-not-found: discover an id this key can serve and retry
    // once. Only fires on a 404 (an otherwise-broken call), so a key for which
    // the hard-coded id works is never affected.
    if (response.status === 404) {
      this.unavailableModels.add(modelToUse);
      const alt = await this.pickServableModel();
      if (alt && alt !== modelToUse) {
        console.warn(`[AIService] model "${modelToUse}" not available for this key; retrying with "${alt}"`);
        response = await doCall(alt);
      }
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw this.opaqueAiError(response.status, (err as any)?.error);
    }

    const data: any = await response.json();
    return data?.content?.[0]?.text || '';
  }

  /**
   * One-shot diagnostics for the AI path — surfaced through an authenticated
   * admin route so the exact cause of an "AI request failed" is visible without
   * server-log access. Everything returned is secret-free (key value never
   * included; any sk- fragment in an upstream message is redacted).
   */
  static async diagnose(model?: string): Promise<{
    keySource: 'org-dynamic' | 'static' | 'stale-cache' | 'none';
    crmNbaModelEnv: string | null;
    requestedModel: string;
    accessibleModels: string[];
    resolvedModel: string | null;
    messagesTest: { ok: boolean; status: number; errorType: string | null; message: string | null };
  }> {
    const requestedModel = model || process.env.CRM_NBA_MODEL || 'claude-sonnet-5';
    const redact = (s: string) => s.replace(/sk-[a-zA-Z0-9-]+/g, 'sk-[REDACTED]').slice(0, 300);

    // Which credential path is in play (for "is the key even configured?").
    let keySource: 'org-dynamic' | 'static' | 'stale-cache' | 'none' = 'none';
    if (process.env.ANTHROPIC_ORG_KEY_ID && process.env.ANTHROPIC_ADMIN_KEY) keySource = 'org-dynamic';
    else if (process.env.ANTHROPIC_API_KEY) keySource = 'static';
    else if (this.functionalKey) keySource = 'stale-cache';

    const accessibleModels = await this.listAccessibleModels().catch(() => []);
    const resolvedModel = await this.pickServableModel(requestedModel).catch(() => null);

    // Minimal real Messages call with the requested id to capture the exact
    // status / error type the key gets.
    let messagesTest = { ok: false, status: 0, errorType: null as string | null, message: null as string | null };
    try {
      const apiKey = await this.getFunctionalKey();
      const res = await this.anthropicFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: requestedModel, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (res.ok) {
        messagesTest = { ok: true, status: res.status, errorType: null, message: null };
      } else {
        const body: any = await res.json().catch(() => ({}));
        messagesTest = {
          ok: false,
          status: res.status,
          errorType: body?.error?.type ?? null,
          message: body?.error?.message ? redact(String(body.error.message)) : null,
        };
      }
    } catch (e: any) {
      messagesTest = { ok: false, status: e?.statusCode || 0, errorType: e?.code || 'exception', message: redact(String(e?.message || e)) };
    }

    return {
      keySource,
      crmNbaModelEnv: process.env.CRM_NBA_MODEL || null,
      requestedModel,
      accessibleModels,
      resolvedModel,
      messagesTest,
    };
  }
}
