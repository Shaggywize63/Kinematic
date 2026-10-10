/**
 * GPS-distance mileage (policy rule `gps_distance`) — the pure part.
 *
 * Under a policy with `gps_distance:true` and vehicle rates, a mileage line with no odometer data may
 * carry just a distance. The server does not take the rep's word for it: it recomputes the day's
 * travel from the GPS (services/travel.service.ts) and reconciles the two here:
 *
 *   allowed = serverKm × 1.10 + 0.5
 *   - nothing recorded (serverKm 0) and the line claims more than 0.5 km -> refused (400)
 *   - the claim is within `allowed`                                      -> the claim stands
 *   - the claim is over `allowed`                                        -> the stored distance becomes serverKm
 *
 * Money is priced from the stored distance and the line's vehicle rate by the caller (priceGpsLine).
 */
import { AppError } from '../../utils';

/** A claim may exceed the measured distance by this fraction ... */
export const GPS_DISTANCE_TOLERANCE = 0.10;
/** ... plus this many km (GPS jitter, a short walk to the door). */
export const GPS_DISTANCE_SLACK_KM = 0.5;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The most a rep may claim for a day the server measured at `serverKm`. */
export const allowedGpsKm = (serverKm: number): number => serverKm * (1 + GPS_DISTANCE_TOLERANCE) + GPS_DISTANCE_SLACK_KM;

export interface GpsReconciled {
  /** The distance to store (2 dp). */
  km: number;
  /** True when the rep's figure was replaced by the measured one. */
  clamped: boolean;
}

/**
 * Reconcile a claimed distance with the server's measure for `date`. Throws a 400
 * "No GPS travel recorded for <date>" when the server measured nothing but a real distance was claimed.
 */
export function reconcileGpsKm(claimedKm: number, serverKm: number, date: string): GpsReconciled {
  const server = Number.isFinite(serverKm) && serverKm > 0 ? serverKm : 0;
  const claimed = Number.isFinite(claimedKm) && claimedKm > 0 ? claimedKm : 0;
  if (server === 0 && claimed > GPS_DISTANCE_SLACK_KM) {
    throw new AppError(400, `No GPS travel recorded for ${date}`, 'NO_GPS_TRAVEL');
  }
  if (claimed > allowedGpsKm(server)) return { km: round2(server), clamped: true };
  return { km: round2(claimed), clamped: false };
}
