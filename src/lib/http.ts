import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code?: string) => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Sign in required') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg: string, code?: string) => new HttpError(409, msg, code);

/** Wraps an async route so rejected promises reach the error middleware. */
export const ah =
  <R extends Request = Request>(fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req as R, res, next).catch(next);
  };
