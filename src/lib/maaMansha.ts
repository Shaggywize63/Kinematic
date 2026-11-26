// Maa Mansha Pharma — per-client gates for the pharma-specific CRM rules
// (lead access control, the 3-day deal-amount lock, form→lead capture). Keeping
// the client id in one place so the gate can never drift between call sites, and
// so every other tenant's behaviour stays completely unchanged. Extendable via
// env MAA_MANSHA_CLIENT_IDS (comma-separated) if more pharma clients adopt it.
export const MAA_MANSHA_CLIENT_ID = '40034845-5c91-4619-992e-473e07856059';

const MAA_MANSHA_CLIENT_IDS = new Set<string>(
  [MAA_MANSHA_CLIENT_ID, ...(process.env.MAA_MANSHA_CLIENT_IDS ?? '').split(',')]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** True when the request's client scope is Maa Mansha Pharma (case-insensitive). */
export function isMaaMansha(clientId?: string | null): boolean {
  return !!clientId && MAA_MANSHA_CLIENT_IDS.has(clientId.trim().toLowerCase());
}

/** A deal's amount + product basket freeze this many days after it is created. */
export const DEAL_AMOUNT_LOCK_DAYS = 3;
