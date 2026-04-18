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
   * Centralized helper for Anthropics Messages API
   */
  static async callKiniAI(payload: { system?: string; messages: any[]; model?: string; max_tokens?: number }) {
    const apiKey = await this.getFunctionalKey();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      payload.model || 'claude-3-haiku-20240307',
        max_tokens: payload.max_tokens || 1000,
        system:     payload.system,
        messages:   payload.messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = (err as any)?.error?.message || `AI service error: ${response.status}`;
      throw new AppError(response.status, msg, 'AI_ERROR');
    }

    const data: any = await response.json();
    return data?.content?.[0]?.text || '';
  }
}
