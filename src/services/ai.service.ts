import { AppError } from '../utils';

/**
 * Service to handle Anthropic AI communication and dynamic API key management
 */
export class AIService {
  private static functionalKey: string | null = null;
  private static lastFetched: number = 0;
  private static CACHE_LIMIT = 60 * 60 * 1000; // 1 hour caching

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

    // Phase 1: Try dynamic fetch if org credentials exist
    if (orgKeyId && adminKey) {
      try {
        const res = await fetch(`https://api.anthropic.com/v1/organizations/api_keys/${orgKeyId}`, {
          method: 'GET',
          headers: {
            'anthropic-version': '2023-06-01',
            'X-Api-Key': adminKey
          }
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
        console.warn('AIService: Dynamic key fetch failed, falling back to static key.', e);
      }
    }

    // Phase 2: Fallback to static key
    if (!staticKey) {
      throw new AppError(500, 'AI authentication not configured. Set ANTHROPIC_ORG_KEY_ID or ANTHROPIC_API_KEY.', 'CONFIG_ERROR');
    }

    return staticKey;
  }

  /**
   * Map an upstream Anthropic error to an opaque message before
   * surfacing it to the API caller. The raw upstream text can leak
   * key fragments on 401 ("Invalid API key: sk-ant-..."), rate-limit
   * metadata on 429, or internal model names on 500. Log the full
   * detail server-side, return a coarse message to the client.
   */
  private static opaqueAiError(status: number, upstreamMessage: string | undefined): AppError {
    // Server-side log retains the upstream message for ops debugging.
    // Truncate so a malicious upstream can't pin our log writer.
    const detail = (upstreamMessage || '').slice(0, 500);
    console.warn(`[AIService] upstream error status=${status}: ${detail.replace(/sk-[a-zA-Z0-9-]+/g, 'sk-[REDACTED]')}`);
    const opaque =
      status === 401 ? 'AI authentication failed'
      : status === 403 ? 'AI authorization failed'
      : status === 429 ? 'AI service rate-limited — retry shortly'
      : status >= 500 ? 'AI service temporarily unavailable'
      : 'AI request failed';
    return new AppError(status, opaque, 'AI_ERROR');
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
  static async callKiniAI(payload: { system?: string; messages: any[]; model?: string; max_tokens?: number }) {
    const apiKey = await this.getFunctionalKey();

    const response = await this.anthropicFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      payload.model || 'claude-haiku-4-5-20251001',
        max_tokens: payload.max_tokens || 1000,
        system:     payload.system,
        messages:   payload.messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw this.opaqueAiError(response.status, (err as any)?.error?.message);
    }

    const data: any = await response.json();
    return data?.content?.[0]?.text || '';
  }
}
