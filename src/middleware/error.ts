import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { HttpError } from '../lib/http';
import { logger } from '../lib/logger';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
}

// Express identifies error middleware by its 4 arguments.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { message: 'Invalid input', code: 'VALIDATION', fields: err.flatten().fieldErrors },
    });
  }
  if (err instanceof MulterError) {
    return res.status(400).json({ error: { message: err.message, code: err.code } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ error: { message: 'Already exists', code: 'DUPLICATE' } });
    if (err.code === 'P2025') return res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } });
  }
  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { message: 'Something went wrong', code: 'INTERNAL' } });
}
