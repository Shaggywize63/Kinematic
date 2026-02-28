/**
 * Calculate distance between two GPS coordinates in metres.
 * Used for geo-fence validation on check-in.
 */
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371000; // Earth radius in metres
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function isWithinGeofence(
  userLat: number, userLng: number,
  meetingLat: number, meetingLng: number,
  radiusMetres: number
): { withinFence: boolean; distanceMetres: number } {
  const distanceMetres = haversineDistance(userLat, userLng, meetingLat, meetingLng);
  return { withinFence: distanceMetres <= radiusMetres, distanceMetres: Math.round(distanceMetres) };
}
