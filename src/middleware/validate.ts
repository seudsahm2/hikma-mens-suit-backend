import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';

type Part = 'body' | 'query' | 'params';

/** Validates req[part] and replaces it with the parsed (coerced, defaulted) value. */
export function validate(schema: ZodTypeAny, part: Part = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) return next(result.error);
    Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
    next();
  };
}
