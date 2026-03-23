import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';
  const code = err.code || 'INTERNAL_ERROR';

  logger.error(`${req.method} ${req.path} — ${statusCode} — ${message}`, { 
    stack: err.stack,
    code,
    body: req.body,
    params: req.params,
    query: req.query
  });

  res.status(statusCode).json({ 
    success: false, 
    error: message,
    code,
    // Include stack only in development if needed, but for now let's just send the message
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
}
