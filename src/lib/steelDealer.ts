import { clientHasFlag } from './clientFlags';

/**
 * Single source of truth for "is this client a steel-dealer tenant?".
 *
 * Steel-dealer tenants run the weight/tonnage-priced deal workflow: the
 * product-basket capture at convert, the derived deal amount, the deals
 * `volume_kg` column and the "Total volume" summary tile. It is meaningless
 * for other tenants (e.g. the parent Kinematic org), so every steel-dealer
 * surface must gate on this helper rather than a bare id comparison.
 *
 * Detection is list-OR-flag:
 *   • the hardcoded set below — SRS/Tata + BMW, the original two — so their
 *     behaviour stays byte-for-byte unchanged, and
 *   • the data-driven `clients.settings.steel_dealer_deal_amount` flag, so a
 *     new tenant (e.g. PASA) opts in with NO code change.
 */
export const STEEL_DEALER_CLIENT_IDS = new Set<string>([
  'a1f67468-526e-4734-be3a-2cb132cc2804', // SRS / Tata steel dealer
  '2ee5e03a-3a56-41c9-aaa0-16468920f871', // BMW (TMT dealer)
]);

/** True when `clientId` is a steel-dealer tenant (hardcoded set OR the
 * `steel_dealer_deal_amount` client flag). Async because the flag lookup
 * reads `clients.settings` (60s-cached). */
export async function isSteelDealerClient(clientId: string | null | undefined): Promise<boolean> {
  if (!clientId) return false;
  return STEEL_DEALER_CLIENT_IDS.has(clientId) || (await clientHasFlag(clientId, 'steel_dealer_deal_amount'));
}
