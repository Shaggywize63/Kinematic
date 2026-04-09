import { Response, NextFunction, RequestHandler } from 'express'
export * from './asyncHandler';

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

// ── Today's date as DD--MM--YYYY in IST (App format) ──
export function todayDate(): string {
  return formatAppDate(toIST());
}

// ── Today's date as YYYY-MM-DD (Database format) ──
export function dbToday(): string {
  return isoDate(toIST());
}

export function toIST(date: Date = new Date()): Date {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 5.5));
}

export function isoDate(d: Date): string {
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Convert DB format (YYYY-MM-DD) -> App format (DD--MM--YYYY)
export function formatAppDate(dateStr: string | Date | null): string {
  if (!dateStr) return '';
  const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${day}--${month}--${year}`;
}

// Convert App format (DD--MM--YYYY) -> DB format (YYYY-MM-DD)
export function parseAppDate(appDate: string | null): string {
  if (!appDate || !appDate.includes('--')) return appDate || dbToday();
  const [day, month, year] = appDate.split('--');
  return `${year}-${month}-${day}`;
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

export const isUUID = (id: any): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id));

