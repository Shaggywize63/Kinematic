/**
 * Response body for GET /attendance/history.
 *
 * The controller used to return buildPaginatedResult() alone — `{ data, pagination }`
 * nested inside the envelope's `data`. The Android app declares that payload as
 * `{ items, total, page, limit, totalPages }` (PaginatedData), so `items` was
 * always null and the app saw an empty history: the attendance calendar showed
 * Present 0 / everything Absent even after a successful check-in.
 *
 * Return BOTH shapes so every build in the field works with no app release:
 *   - `items` / `total` / `page` / `limit` / `totalPages`  → what Android decodes
 *   - `data` / `pagination`                                → the previous shape
 */
export function shapeAttendanceHistory<T>(rows: T[], total: number, page: number, limit: number) {
  const totalPages = Math.ceil(total / limit);
  return {
    items: rows,
    total,
    page,
    limit,
    totalPages,
    data: rows,
    pagination: { page, limit, total, totalPages },
  };
}
