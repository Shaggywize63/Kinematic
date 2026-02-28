import { Request, Response, NextFunction, RequestHandler } from 'express';

// Wraps async route handlers so you don't need try/catch in every controller
export const asyncHandler = (fn: RequestHandler) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
