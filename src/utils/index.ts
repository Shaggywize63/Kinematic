import { Request, Response, NextFunction, RequestHandler } from 'express'

// ── Wraps async route handlers to forward errors to Express error middleware ──
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void | any>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

// ── Standard application error ──
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'AppError'
    Error.captureStackTrace(this, this.constructor)
  }
}

// ── Paginate helper ──
export interface PaginationParams {
  page: number
  limit: number
  offset: number
}

export function getPagination(
  page = 1,
  limit = 20
): PaginationParams {
  const safePage  = Math.max(1, page)
  const safeLimit = Math.min(1000, Math.max(1, limit))
  return {
    page: safePage,
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  }
}

// ── Standard success response ──
export function sendSuccess(
  res: Response,
  data: unknown,
  message = 'Success',
  statusCode = 200
) {
  res.status(statusCode).json({ success: true, message, data })
}

// ── Standard paginated response ──
export function sendPaginated(
  res: Response,
  data: unknown[],
  total: number,
  page: number,
  limit: number
) {
  res.status(200).json({
    success: true,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  })
}

// ── IST offset: +5:30 in milliseconds ──
const IST_OFFSET_MS = 5.5 * 3600000;

// ── Convert a UTC Date to its IST-shifted equivalent ──
export function toISTDate(utcDate: Date): Date {
  return new Date(utcDate.getTime() + IST_OFFSET_MS);
}

// ── Today's date as YYYY-MM-DD in IST ──
export function todayDate(): string {
  return toISTDate(new Date()).toISOString().split('T')[0];
}

// ── IST date N days offset from today (negative = past, positive = future) ──
// Uses IST-aware arithmetic so day boundaries are always correct for IST.
export function istOffsetDate(daysOffset: number): string {
  const istNow = toISTDate(new Date());
  istNow.setUTCDate(istNow.getUTCDate() + daysOffset);
  return istNow.toISOString().split('T')[0];
}

export const ok = <T>(res: Response, data: T, message?: string) =>
  res.status(200).json({ success: true, data, ...(message && { message }) });

export const created = <T>(res: Response, data: T, message?: string) =>
  res.status(201).json({ success: true, data, ...(message && { message }) });

export const badRequest = (res: Response, error: string, details?: unknown) =>
  res.status(400).json({ success: false, error, ...(details && { details }) });

export const notFound = (res: Response, error = 'Not found') =>
  res.status(404).json({ success: false, error });

export const forbidden = (res: Response, error = 'Forbidden') =>
  res.status(403).json({ success: false, error });

export const conflict = (res: Response, error: string) =>
  res.status(409).json({ success: false, error });
