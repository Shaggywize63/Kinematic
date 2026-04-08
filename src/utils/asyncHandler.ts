import { Request, Response, NextFunction, RequestHandler } from 'express';

// Wraps async route handlers so you don't need try/catch in every controller
export const asyncHandler = <T = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<any>
) => (req: any, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req as T, res, next)).catch(next);
};
