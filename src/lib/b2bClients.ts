// The clients that get the connected B2B flow: a lead becomes a CRM account,
// contacts-with-requirements are logged against it, and expenses link to an
// account + form. Spark & Ray by default; extend via env B2B_LEAD_CLIENT_IDS
// (comma-separated client ids). Any other tenant's flow is completely unchanged.
//
// Shared by crm.routes (lead → account) and the expenses service (expense ↔
// account/form + mandatory clarification) so the gate can never drift between them.
export const SPARK_CLIENT_ID = 'c0218852-0a19-4dd0-b9fa-72f9e32ed0d8';

export const B2B_LEAD_CLIENT_IDS = new Set<string>(
  [SPARK_CLIENT_ID, ...(process.env.B2B_LEAD_CLIENT_IDS ?? '').split(',')]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** True when this client runs the connected B2B flow (case-insensitive). */
export function isB2bClient(clientId?: string | null): boolean {
  return !!clientId && B2B_LEAD_CLIENT_IDS.has(clientId.trim().toLowerCase());
}
