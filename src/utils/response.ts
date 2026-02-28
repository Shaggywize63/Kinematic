import { Response } from 'express';

export const ok = <T>(res: Response, data: T, message?: string) =>
  res.status(200).json({ success: true, data, ...(message && { message }) });

export const created = <T>(res: Response, data: T, message?: string) =>
  res.status(201).json({ success: true, data, ...(message && { message }) });

export const badRequest = (res: Response, error: string, details?: unknown) =>
  res.status(400).json({ success: false, error, ...(details && { details }) });

export const unauthorized = (res: Response, error = 'Unauthorized') =>
  res.status(401).json({ success: false, error });

export const forbidden = (res: Response, error = 'Forbidden') =>
  res.status(403).json({ success: false, error });

export const notFound = (res: Response, error = 'Not found') =>
  res.status(404).json({ success: false, error });

export const conflict = (res: Response, error: string) =>
  res.status(409).json({ success: false, error });

export const serverError = (res: Response, error = 'Internal server error') =>
  res.status(500).json({ success: false, error });
