import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request demo industry vertical, carried via AsyncLocalStorage so the
 * demo middlewares (demoCrm / demoExtensions) and the getMock* fixtures can
 * serve the vertical the demo account picked — without threading the value
 * through every controller. Mirrors the project ALS in src/lib/projects.ts.
 *
 * The web dashboard sends the selected vertical as the `X-Demo-Industry`
 * header (see withDemoIndustry middleware). Anything unknown / missing falls
 * back to 'generic', i.e. today's behaviour.
 */
const als = new AsyncLocalStorage<{ industry: string }>();

const KNOWN_INDUSTRIES = new Set(['insurance', 'pharmaceutical']);

export function normalizeIndustry(value: string | undefined | null): string {
  const v = String(value || '').trim().toLowerCase();
  return KNOWN_INDUSTRIES.has(v) ? v : 'generic';
}

export function runWithDemoIndustry<T>(industry: string | undefined | null, fn: () => T): T {
  return als.run({ industry: normalizeIndustry(industry) }, fn);
}

export function currentDemoIndustry(): string {
  return als.getStore()?.industry || 'generic';
}
